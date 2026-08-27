import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";

import { endStream, existsSafe, gzipMove, statSizeSafe } from "./fsio.js";
import {
    parseClockOffset,
    parseClockStep,
    parseFrequency,
    parseMaxFiles,
    parseSize,
    type ParsedFrequency,
    type ParsedMaxFiles,
} from "./parsers.js";
import {
    escRe,
    formatStamp,
    getDtf,
    nextAligned,
    nextMidnight,
    partsIn
} from "./time.js";
import type {
    RotateFileStreamEventMap,
    RotateFileStreamOptions,
    RotationReason
} from "./types.js";

const BUMP_DEFAULT_MS = 60_000;
const AUDIT_MAX_FILES = 600;
const AUDIT_MAX_EVENTS = 200;
const HEARTBEAT_STALE_MS = 30_000;
const TIMER_POLL_MS = 1_000;

type FileState =
    | "active"
    | "sealed"
    | "archived"
    | "closed"
    | "abandoned"
    | "kept-raw"
    | "lost";

interface AuditFileRecord {
    index?: number;
    state?: FileState;
    gzipPending?: boolean;
    openedAt?: string;
    closedAt?: string;
    archivedAt?: string;
    abandonedAt?: string;
    bytes?: number;
}

interface AuditEvent {
    id: string;
    t: string;
    type: string;
    [key: string]: unknown;
}

interface AuditDoc {
    version: 1;
    prefix: string;
    ext: string;
    datePattern: string;
    tz: string;
    createdAt: string | null;
    updatedAt: string | null;
    activeStamp: string | null;
    activeIndex: number | null;
    writer: { pid: number; bootId: string; heartbeat: number } | null;
    files: Record<string, AuditFileRecord>;
    events: AuditEvent[];
}

const emptyAudit = (
    prefix: string,
    ext: string,
    datePattern: string,
    tz: string,
): AuditDoc => ({
    version: 1,
    prefix,
    ext,
    datePattern,
    tz,
    createdAt: null,
    updatedAt: null,
    activeStamp: null,
    activeIndex: null,
    writer: null,
    files: {},
    events: [],
});

/**
 * A `Writable` that appends to dated log files, rolling segments on time
 * and/or size, optionally gzipping sealed segments, enforcing retention,
 * and resuming an unbroken series across restarts via disk scan + audit
 * manifest.
 *
 * @example
 * ```ts
 * const log = createStream({
 *   filename: "logs/app-%DATE%.log",
 *   maxSize: "20m",
 *   maxFiles: "90d",
 *   zippedArchive: true,
 * });
 * log.write("hello\n");          // or: readable.pipe(log)
 * ```
 */
export class RotateFileStream extends Writable {
    readonly tz: string;
    readonly template: string;
    readonly dir: string;
    readonly datePattern: string;
    readonly zippedArchive: boolean;
    readonly maxSize: number;
    readonly maxFiles: Readonly<ParsedMaxFiles> | null;
    readonly freq: ParsedFrequency;
    readonly unrefTimers: boolean;

    /* ---- filename-template pieces ---- */
    private readonly _tL: string;
    private readonly _tMid: string;
    private readonly _tExt: string;
    private readonly _rxFor: (stampSrc: string) => RegExp;
    private readonly _rxActive: RegExp;

    /* ---- audit manifest ---- */
    private readonly _auditEnabled: boolean;
    private readonly _auditPath: string;
    private readonly _bootId = randomUUID();

    /* ---- virtual test clock ---- */
    private _offsetMs: number;
    private _stepMs: number;
    private _bumpEvery: number;

    /* ---- live state ---- */
    private _curStamp: string;
    private _index: number;
    private _ws: fs.WriteStream | null = null;
    private _path: string | null = null;
    private _bytes = 0;
    private _timer: NodeJS.Timeout | null = null;
    private _bumpTimer: NodeJS.Timeout | null = null;
    private _ended = false;
    private _tail: Promise<unknown> = Promise.resolve();
    private _warnedBackward = false;
    private _audit: AuditDoc;

    constructor(opts: Partial<RotateFileStreamOptions> = {}) {
        super(opts.highWaterMark ? { highWaterMark: opts.highWaterMark } : {});

        const filename = opts.filename;
        if (typeof filename !== "string" || !filename.includes("%DATE%")) {
            throw new Error(
                "opts.filename must contain '%DATE%' (e.g. 'logs/app-%DATE%.log')",
            );
        }

        this.tz = opts.tz || "UTC";
        getDtf(this.tz); // validate early, fail fast

        this.template = path.basename(filename);
        this.dir = path.dirname(filename);
        this.datePattern = opts.datePattern || "YYYY-MM-DD";
        this.zippedArchive = !!opts.zippedArchive;
        this.maxSize = parseSize(opts.maxSize ?? 0);
        this.maxFiles = parseMaxFiles(opts.maxFiles);
        this.freq = parseFrequency(opts.frequency);
        this.unrefTimers = !!opts.unrefTimers;
        this._offsetMs = parseClockOffset(opts.addHours);
        this._stepMs = parseClockStep(opts.addHoursEveryMin);
        this._bumpEvery = Math.max(50, opts.clockStepIntervalMs ?? BUMP_DEFAULT_MS);

        /* Split "prefix-%DATE%mid.ext" → pieces so indices land BETWEEN the
           stamp and the extension: prefix-STAMP.N.ext                       */
        const li = this.template.indexOf("%DATE%");
        const rest = this.template.slice(li + "%DATE%".length);
        const dot = rest.lastIndexOf(".");
        this._tL = this.template.slice(0, li);
        this._tMid = dot >= 0 ? rest.slice(0, dot) : "";
        this._tExt = dot >= 0 ? rest.slice(dot) : "";

        this._rxFor = (stampSrc) =>
            new RegExp(
                "^" +
                escRe(this._tL) + stampSrc + escRe(this._tMid) +
                "(?:\\.(\\d+))?" + escRe(this._tExt) + "(?:\\.gz)?$",
            );
        this._rxActive = this._rxFor("[^.]+");

        this._auditEnabled = opts.audit !== false;
        const stem = (this._tL.replace(/[^\w.-]+/g, "") || "log")
            .replace(/^[-.]+|[-.]+$/g, "");
        this._auditPath = path.join(this.dir, opts.auditFile || `${stem}_audit.json`);

        fs.mkdirSync(this.dir, { recursive: true });

        this._curStamp = this._stampNow();
        this._audit = emptyAudit(this._tL, this._tExt, this.datePattern, this.tz);

        const hadAudit = this._auditEnabled && this._loadAudit();
        this._index = this._recoverIndexFor(this._curStamp);
        const aiBoot = this._audit.activeIndex;
        if (hadAudit && aiBoot !== null && this._audit.activeStamp === this._curStamp) {
            this._index = Math.max(this._index, aiBoot);
        }

        if (this._offsetMs !== 0 || this._stepMs !== 0) {
            process.nextTick(() =>
                this.emit("clock", {
                    addHours: opts.addHours ?? undefined,
                    addHoursEveryMin: opts.addHoursEveryMin ?? undefined,
                    offsetMs: this._offsetMs,
                }),
            );
        }


        process.nextTick(() => {
            const warn = (m: string) => this.emit("warn", new Error(m));
            if (this.freq.type === "interval") {
                if (this.freq.ms < 86_400_000 && !this.datePattern.includes("HH")) {
                    warn(
                        `frequency "${opts.frequency}" needs HH in datePattern — ` +
                        "segments would collapse onto one filename",
                    );
                }
                if (this.freq.ms < 60_000 && !this.datePattern.includes("mm")) {
                    warn(`frequency "${opts.frequency}" needs mm in datePattern`);
                }
            } else if (!this.datePattern.includes("DD")) {
                warn("daily frequency needs DD in datePattern");
            }
        });

        /* Boot housekeeping is job #1 of the serial queue — chained HERE in the
           constructor so it deterministically precedes any write job: zombie
           demotion sees `_path === null`, gzip repair cannot race a reopen.  */
        this._job(async () => {
            await this._sealOrphanedPastStamps();
            if (this._auditEnabled) {
                this._demoteZombieActives();
                this._reconcileWithDisk();
                await this._repairInterruptedGzips();
                this._aevent("boot", { stamp: this._curStamp, index: this._index });
                this._saveAudit();
            }
            if (this.maxFiles) this._retire();
        }).catch(() => { });

        this._armTimer();
        this._armBump();
        this.once("close", () => {
            this._stopTimer();
            this._stopBump();
        });
    }

    /* ==================================================================
     * Typed events — tuple map overloads FIRST, Node-core-compatible
     * fallback SECOND (keeps `.pipe()` structural typing intact).
     * ================================================================ */

    override on<E extends keyof RotateFileStreamEventMap>(
        event: E,
        listener: (...args: RotateFileStreamEventMap[E]) => void,
    ): this;
    override on(event: string | symbol, listener: (...args: any[]) => void): this;
    override on(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }

    override once<E extends keyof RotateFileStreamEventMap>(
        event: E,
        listener: (...args: RotateFileStreamEventMap[E]) => void,
    ): this;
    override once(event: string | symbol, listener: (...args: any[]) => void): this;
    override once(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.once(event, listener);
    }

    override emit<E extends keyof RotateFileStreamEventMap>(
        event: E,
        ...args: RotateFileStreamEventMap[E]
    ): boolean;
    override emit(event: string | symbol, ...args: unknown[]): boolean;
    override emit(event: string | symbol, ...args: unknown[]): boolean {
        return super.emit(event, ...(args as any[]));
    }

    /* ==================================================================
     * Public API
     * ================================================================ */

    /** Absolute path of the segment currently written; `null` until first write. */
    get filename(): string | null {
        return this._path;
    }

    /** Index of the active segment within the current period. */
    get currentIndex(): number {
        return this._index;
    }

    /** Force an immediate rotation and resolve when the next slot is staged. */
    rotateNow(): Promise<void> {
        return this._job(() => this._rotate("manual"));
    }

    /**
     * Apply ONE virtual-clock tick immediately (bypasses the interval timer
     * for deterministic tests). Crossing into a new period triggers the same
     * archive flow as a real midnight roll.
     */
    advanceClock(): Promise<void> {
        return this._job(() => this._applyBump());
    }

    /* ==================================================================
     * Writable contract
     * ================================================================ */

    public override _write(
        chunk: Buffer,
        encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        if (this._ended) {
            process.nextTick(callback, new Error("write after end"));
            return;
        }
        const len = chunk.length;

        this._job(async () => {
            try {
                // guarded roll (never rotates into a regressed stamp)
                if (this._stampAdvanced(this._stampNow())) await this._rotate("time");

                await this._ensureOpen();

                if (
                    this.maxSize > 0 &&
                    this._bytes > 0 &&
                    this._bytes + len > this.maxSize
                ) {
                    await this._rotate("size");
                    await this._ensureOpen();
                }

                const ws = this._ws;
                if (!ws) throw new Error("segment write stream not open");

                await new Promise<void>((resolve, reject) =>
                    ws.write(chunk, encoding, (e) => (e ? reject(e) : resolve())),
                );
                this._bytes += len;
                callback();
            } catch (err) {
                this.emit("error", err as Error);
                callback(err as Error);
            }
        }).catch(() => { });
    }

    public override _final(callback: (error?: Error | null) => void): void {
        this._ended = true;
        this._stopTimer();
        this._stopBump();
        this._job(async () => {
            await endStream(this._ws);
            const base = this._path && path.basename(this._path);
            if (base && this._audit.files[base]) {
                const rec = this._audit.files[base];
                rec.state = "closed";
                rec.closedAt = new Date().toISOString();
                rec.bytes = statSizeSafe(this._path);
                this._aevent("close", { file: base });
                this._saveAudit();
            }
            this._ws = null;
            this._path = null;
        })
            .catch(() => { })
            .finally(() => callback());
    }

    public override destroy(...args: Parameters<Writable["destroy"]>): this {
        this._stopTimer();
        this._stopBump();
        return super.destroy(...args);
    }

    /* ==================================================================
     * Serialisation — every mutating operation funnels through one queue
     * so rotations/gzips/writes never interleave.
     * ================================================================ */

    private _job<T>(fn: () => T | Promise<T>): Promise<T> {
        const run = this._tail.then(fn, fn) as Promise<T>;
        this._tail = run.catch(() => { });
        return run;
    }

    private _now(): number {
        return Date.now() + this._offsetMs;
    }

    private _stampNow(d: Date = new Date(this._now())): string {
        return formatStamp(this.datePattern, partsIn(this.tz, d));
    }

    private _resolveName(stamp: string, index: number): string {
        const base = path.join(this.dir, this._tL + stamp + this._tMid + this._tExt);
        if (!index) return base;
        return /\.[^.]+$/.test(base)
            ? base.replace(/\.[^.]+$/, `.${index}$&`)
            : `${base}.${index}`;
    }

    /**
     * true only when the period legally advanced. A regressed
     * clock (NTP correction, manual change) never reopens a past family:
     * writes continue in the current segment until real time catches up.
     * Requires zero-padded datePattern tokens (documented assumption).
     */
    private _stampAdvanced(stamp: string): boolean {
        if (stamp > this._curStamp) return true;
        if (stamp < this._curStamp && !this._warnedBackward) {
            this._warnedBackward = true;
            this.emit(
                "warn",
                new Error(
                    `clock moved backward (stamp ${stamp} < ${this._curStamp}); ` +
                    "keeping current segment until the clock catches up",
                ),
            );
        }
        return false;
    }

    /**
     * Highest viable segment index for `stamp`.
     * Disk is truth: resume a raw tail; start after sealed ones.
     * The audit pointer (same stamp only) may only RAISE the result.
     */
    private _recoverIndexFor(stamp: string): number {
        const rx = this._rxFor(escRe(stamp));
        let maxAny = -1;
        let maxRaw = -1;
        let names: string[] = [];
        try {
            names = fs.readdirSync(this.dir);
        } catch {
            /* unreadable dir → fresh series */
        }
        for (const n of names) {
            const m = rx.exec(n);
            if (!m) continue;
            const idx = m[1] ? Number.parseInt(m[1], 10) : 0;
            if (idx > maxAny) maxAny = idx;
            if (!n.endsWith(".gz") && idx > maxRaw) maxRaw = idx;
        }
        let idx = maxRaw >= 0 ? maxRaw : maxAny >= 0 ? maxAny + 1 : 0;

        const ai = this._audit.activeIndex;
        if (this._auditEnabled && ai !== null && this._audit.activeStamp === stamp) {
            idx = Math.max(idx, ai);
        }
        return idx;
    }

    private async _ensureOpen(): Promise<void> {
        if (this._ws) return;
        const p = this._resolveName(this._curStamp, this._index);
        this._bytes = statSizeSafe(p);
        const ws = fs.createWriteStream(p, { flags: "a" });
        ws.on("error", (e) => this.emit("error", e));
        this._ws = ws;
        this._path = p;

        if (this._auditEnabled) {
            const base = path.basename(p);
            // reopen = NEW incarnation. Never inherit lifecycle
            // fields from the previous record (observed in the wild as
            // abandonedAt < openedAt on reactivated segments).
            this._audit.files[base] = {
                index: this._index,
                state: "active",
                gzipPending: false,
                openedAt: new Date().toISOString(),
            };
            this._setActivePointer(this._index);
            this._aevent("open", {
                file: base,
                index: this._index,
                resumedBytes: this._bytes,
            });
            this._saveAudit();
        }
        this.emit("open", p);
    }

    private async _rotate(kind: RotationReason): Promise<void> {
        const oldPath = this._path;
        const oldWs = this._ws;
        this._ws = null;
        this._path = null;
        this._bytes = 0;

        let archive: string | null = null;
        if (oldWs && oldPath) {
            await endStream(oldWs);
            const realBytes = statSizeSafe(oldPath);
            const oldBase = path.basename(oldPath);
            const rec = this._auditEnabled ? this._audit.files[oldBase] : undefined;

            if (this.zippedArchive && realBytes > 0) {
                archive = `${oldPath}.gz`;
                /* Mark intent BEFORE compressing: crash mid-gzip becomes a
                   repairable `gzipPending` flag instead of silent divergence.  */
                if (rec) {
                    rec.gzipPending = true;
                    rec.bytes = realBytes;
                    this._saveAudit();
                }
                const ok = await gzipMove(oldPath, archive, (e) => this.emit("warn", e));
                if (ok) {
                    this._finishArchivedRecord(oldBase);
                } else {
                    if (rec) {
                        rec.gzipPending = false;
                        rec.state = "kept-raw";
                    }
                    this._aevent("gzip-failed", { file: oldBase });
                    archive = null;
                }
            } else if (realBytes === 0) {
                // a concurrent writer may have archived this segment
                // between our last stat and now — adopt its artifact instead of
                // recording a false `drop-empty` that orphans the .gz.
                const adoptedGz = `${oldPath}.gz`;
                if (existsSafe(adoptedGz)) {
                    this._finishArchivedRecord(oldBase);
                    archive = adoptedGz;
                } else {
                    try {
                        fs.unlinkSync(oldPath);
                    } catch {
                        /* already gone */
                    }
                    if (rec) delete this._audit.files[oldBase];
                    this._aevent("drop-empty", { file: oldBase });
                }
            } else if (rec) {
                rec.state = "sealed";
                rec.bytes = realBytes;
            }
        }

        let stamp = this._stampNow();
        // a rotation itself must never move the series backward
        // (covers rotateNow()/interval/size paths the upstream guards miss)
        if (stamp < this._curStamp) {
            if (!this._warnedBackward) {
                this._warnedBackward = true;
                this.emit(
                    "warn",
                    new Error(
                        `clock moved backward (stamp ${stamp} < ${this._curStamp}); ` +
                        "rotation clamped to the current period",
                    ),
                );
            }
            stamp = this._curStamp;
        }
        const newPeriod = stamp !== this._curStamp;
        this._curStamp = stamp;
        /* Never blind-reset to 0 — recover what THIS stamp already owns. */
        this._index =
            newPeriod || kind === "time"
                ? this._recoverIndexFor(stamp)
                : this._index + 1;
        this._bytes = 0;

        if (this._auditEnabled) {
            this._setActivePointer(this._index);
            this._aevent("rotate", { reason: kind, nextIndex: this._index, stamp });
            this._saveAudit();
        }

        if (kind === "time" || kind === "manual") this._armTimer();

        if (oldPath) {
            this.emit("rotated", {
                reason: kind,
                oldFile: oldPath,
                archive,
                newFile: this._resolveName(stamp, this._index),
            });
        }

        this._retire();
    }

    /* ==================================================================
     * Timers
     * ================================================================ */

    private _hasContent(): boolean {
        return this._ws
            ? this._bytes > 0 || statSizeSafe(this._path) > 0
            : !!(this._path && statSizeSafe(this._path) > 0);
    }

    private _armTimer(): void {
        this._stopTimer();
        if (this._ended) return;
        const now = this._now();
        const next =
            this.freq.type === "daily"
                ? nextMidnight(this.tz, now)
                : nextAligned(now, this.freq.ms);

        // anti-spin. A backward clock can put the computed
        // boundary in the past; poll gently instead of firing every 100 ms.
        const delta = next - this._now();
        const delay = delta < 0 ? TIMER_POLL_MS : Math.max(100, delta);

        this._timer = setTimeout(
            () => {
                this._job(async () => {
                    const stamp = this._stampNow();

                    if (this.freq.type !== "daily") {
                        /* interval rotation is schedule-based; runs regardless of
                           stamp movement */
                        if (this._hasContent()) await this._rotate("time");
                    } else if (this._stampAdvanced(stamp)) {
                        // guarded daily branch
                        if (this._hasContent()) {
                            await this._rotate("time");
                        } else {
                            /* idle boundary slide — no file created for empty days */
                            this._curStamp = stamp;
                            this._index = this._recoverIndexFor(stamp);
                            if (this._auditEnabled) {
                                this._setActivePointer(this._index);
                                this._aevent("period", { stamp });
                                this._saveAudit();
                            }
                            this.emit("period", stamp);
                        }
                    }
                    /* stamp regressed or unchanged → keep current segment, re-arm */

                    this._armTimer();
                }).catch(() => { });
            },
            delay,
        );
        if (this.unrefTimers) this._timer.unref();
    }

    private _armBump(): void {
        this._stopBump();
        if (!this._stepMs || this._ended) return;
        this._bumpTimer = setInterval(
            () => this._job(() => this._applyBump()).catch(() => { }),
            this._bumpEvery,
        );
        if (this.unrefTimers) this._bumpTimer.unref();
    }

    private _stopBump(): void {
        if (this._bumpTimer) {
            clearInterval(this._bumpTimer);
            this._bumpTimer = null;
        }
    }

    private async _applyBump(): Promise<void> {
        if (this._ended) return;
        this._offsetMs += this._stepMs;
        this._armTimer();

        const stamp = this._stampNow();
        // guarded crossing (virtual clock can't roll backward either)
        if (this._stampAdvanced(stamp)) {
            if (this._hasContent()) {
                await this._rotate("time");
            } else {
                this._curStamp = stamp;
                this._index = this._recoverIndexFor(stamp);
                if (this._auditEnabled) {
                    this._setActivePointer(this._index);
                    this._aevent("period", { stamp, virtual: true });
                }
                this.emit("period", stamp);
            }
        }
        if (this._auditEnabled) {
            this._aevent("clock-step", {
                addedMsPerMin: this._stepMs,
                offsetMs: this._offsetMs,
                stamp,
            });
            this._saveAudit();
        }
    }

    private _stopTimer(): void {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    /* ==================================================================
     * Audit manifest
     * ================================================================ */

    private _loadAudit(): boolean {
        let parsed: unknown;
        try {
            parsed = JSON.parse(fs.readFileSync(this._auditPath, "utf8"));
        } catch {
            // unparseable manifest is quarantined too (was silently
            // clobbered by the first save — caught by the quarantine test)
            try {
                fs.renameSync(this._auditPath, `${this._auditPath}.corrupt`);
            } catch {
                /* ignore */
            }
            return false;
        }

        const j = parsed as Partial<AuditDoc> | null;

        if (!j || j.version !== 1 || j.prefix !== this._tL || j.ext !== this._tExt) {
            try {
                fs.renameSync(this._auditPath, `${this._auditPath}.corrupt`);
            } catch {
                /* ignore */
            }
            return false;
        }

        this._audit.createdAt = j.createdAt ?? new Date().toISOString();
        this._audit.activeStamp =
            typeof j.activeStamp === "string" ? j.activeStamp : null;
        this._audit.activeIndex =
            Number.isInteger(j.activeIndex) ? (j.activeIndex as number) : null;
        this._audit.files =
            j.files && typeof j.files === "object"
                ? (j.files as Record<string, AuditFileRecord>)
                : {};
        this._audit.events = Array.isArray(j.events)
            ? (j.events as AuditEvent[]).slice(-AUDIT_MAX_EVENTS)
            : [];

        /* Detect another LIVE process on this family before clobbering it. */
        const w = j.writer;
        if (
            w &&
            typeof w.bootId === "string" &&
            w.bootId !== this._bootId &&
            typeof w.heartbeat === "number" &&
            Date.now() - w.heartbeat < HEARTBEAT_STALE_MS
        ) {
            const err = new Error(
                `concurrent writer detected (pid ${w.pid}, boot ${w.bootId}); ` +
                "two processes share this log family and will race. " +
                "If running 'node --watch', exclude the logs dir via --watch-path.",
            );
            this.emit("warn", err);
            this._audit.events.push({
                id: randomUUID(),
                t: new Date().toISOString(),
                type: "concurrent-writer",
                otherPid: w.pid,
                otherBoot: w.bootId,
            });
        }
        return true;
    }

    private _saveAudit(): void {
        if (!this._auditEnabled) return;
        try {
            this._pruneAuditFiles();
            this._audit.updatedAt = new Date().toISOString();
            this._audit.writer = {
                pid: process.pid,
                bootId: this._bootId,
                heartbeat: Date.now(),
            };
            const tmp = `${this._auditPath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this._audit, null, 1));
            fs.renameSync(tmp, this._auditPath);
        } catch (e) {
            this.emit("warn", e as Error);
        }
    }

    private _pruneAuditFiles(): void {
        const files = this._audit.files;
        const keys = Object.keys(files);
        if (keys.length <= AUDIT_MAX_FILES) return;
        const activeBase = this._path && path.basename(this._path);
        const lastTouch = (r: AuditFileRecord): string =>
            r.archivedAt ?? r.closedAt ?? r.abandonedAt ?? r.openedAt ?? "";
        const stale = keys
            .filter((k) => k !== activeBase && files[k].state !== "active")
            .sort((a, b) => lastTouch(files[a]).localeCompare(lastTouch(files[b])));
        const excess = keys.length - AUDIT_MAX_FILES + 50;
        for (const key of stale.slice(0, excess)) delete files[key];
    }

    private _aevent(type: string, extra: Record<string, unknown> = {}): void {
        if (!this._auditEnabled) return;
        const events = this._audit.events;
        events.push({ id: randomUUID(), t: new Date().toISOString(), type, ...extra });
        if (events.length > AUDIT_MAX_EVENTS) {
            events.splice(0, events.length - AUDIT_MAX_EVENTS);
        }
    }

    private _setActivePointer(index: number): void {
        this._audit.activeStamp = this._curStamp;
        this._audit.activeIndex = index;
    }

    /** Records left `active` by dead processes → `abandoned`. */
    private _demoteZombieActives(): void {
        const activeBase = this._path && path.basename(this._path);
        for (const [name, rec] of Object.entries(this._audit.files)) {
            if (rec.state === "active" && name !== activeBase) {
                rec.state = "abandoned";
                rec.abandonedAt = new Date().toISOString();
                this._aevent("abandon", { file: name });
            }
        }
    }

    /** Heal audit-vs-disk divergence after crashes / external tampering. */
    private _reconcileWithDisk(): void {
        for (const name of Object.keys(this._audit.files)) {
            const rec = this._audit.files[name];
            if (rec.gzipPending) continue; // handled by the repair pass

            if (name.endsWith(".gz")) {
                const gzExists = existsSafe(path.join(this.dir, name));
                const rawName = name.slice(0, -3);
                const rawExists = existsSafe(path.join(this.dir, rawName));

                if (gzExists) continue;
                if (rawExists) {
                    delete this._audit.files[name];
                    this._audit.files[rawName] = { ...rec, state: "sealed" };
                    this._aevent("archive-regressed", { file: name, backTo: rawName });
                    this.emit(
                        "warn",
                        new Error(`archive ${name} missing but raw ${rawName} exists`),
                    );
                    continue;
                }
                this._aevent("vanished", { file: name });
                delete this._audit.files[name];
                continue;
            }

            const rawExists = existsSafe(path.join(this.dir, name));
            const gzExists = existsSafe(path.join(this.dir, `${name}.gz`));
            if (rawExists) continue;
            if (gzExists) {
                this._finishArchivedRecord(name, true); // unlink was interrupted
                continue;
            }
            this._aevent("vanished", { file: name });
            delete this._audit.files[name];
        }
    }

    /**
     * DISK-DRIVEN seal. Seal raw segments whose period has
     * already passed (crash near midnight, virtual-clock leftovers,
     * untracked/pruned files). Iterates the DIRECTORY, not the manifest:
     * the filesystem is the source of truth; the manifest is an index.
     */
    private async _sealOrphanedPastStamps(): Promise<void> {
        if (!this.zippedArchive) return;

        const stampRx = new RegExp(
            "^" + escRe(this._tL) + "(.+?)" + escRe(this._tMid) +
            "(?:\\.\\d+)?" + escRe(this._tExt) + "(?:\\.gz)?$",
        );

        let names: string[] = [];
        try {
            names = fs.readdirSync(this.dir);
        } catch {
            return;
        }

        for (const name of names) {
            if (name.endsWith(".gz")) continue;
            if (name === (this._path && path.basename(this._path))) continue;

            const stamp = stampRx.exec(name)?.[1];
            // lexicographic compare is safe for zero-padded patterns (YYYY-MM-DD…);
            // also guards the current stamp and anything future-dated
            if (!stamp || stamp >= this._curStamp) continue;

            const full = path.join(this.dir, name);
            if (!existsSafe(full) || statSizeSafe(full) === 0) continue;

            const ok = await gzipMove(full, `${full}.gz`, (e) => this.emit("warn", e));
            if (!ok) continue;

            if (this._auditEnabled && this._audit.files[name]) {
                // tracked → re-key record name → name.gz (emits archive + journal)
                this._finishArchivedRecord(name, true);
            } else {
                // untracked → record it fresh so future reconciles see truth
                const gzName = `${name}.gz`;
                if (this._auditEnabled) {
                    this._audit.files[gzName] = {
                        state: "archived",
                        gzipPending: false,
                        archivedAt: new Date().toISOString(),
                    };
                    this._aevent("seal-past", { file: gzName });
                }
                this.emit("archive", path.join(this.dir, gzName));
            }
        }
    }

    private async _repairInterruptedGzips(): Promise<void> {
        for (const [name, rec] of Object.entries(this._audit.files)) {
            if (!rec.gzipPending) continue;
            const src = path.join(this.dir, name);
            const dst = `${src}.gz`;

            if (!existsSafe(src)) {
                rec.gzipPending = false;
                rec.state = "lost";
                this._aevent("gzip-lost", { file: name });
                continue;
            }
            if (existsSafe(dst)) {
                try {
                    fs.unlinkSync(src);
                } catch {
                    /* ignore */
                }
                this._finishArchivedRecord(name, true);
                continue;
            }
            const ok = await gzipMove(src, dst, (e) => this.emit("warn", e));
            if (ok) {
                this._finishArchivedRecord(name, true);
            } else {
                rec.gzipPending = false;
                rec.state = "kept-raw";
                this._aevent("gzip-failed", { file: name });
            }
        }
    }

    /** Seal a record; re-key `name` → `name.gz` so scans stop ghosting. */
    private _finishArchivedRecord(rawName: string, repaired = false): void {
        const rec = this._audit.files[rawName];
        if (!rec) return;
        rec.gzipPending = false;
        rec.state = "archived";
        rec.archivedAt = new Date().toISOString();

        if (rawName.endsWith(".gz")) {
            this.emit("archive", path.join(this.dir, rawName));
            this._aevent("archive", { file: rawName, ...(repaired && { repaired }) });
            return;
        }
        const gzName = `${rawName}.gz`;
        delete this._audit.files[rawName];
        this._audit.files[gzName] = rec;
        this.emit("archive", path.join(this.dir, gzName));
        this._aevent("archive", { file: gzName, ...(repaired && { repaired }) });
    }

    /* ==================================================================
     * Retention
     * ================================================================ */

    private async _retire(): Promise<void> {
        const policy = this.maxFiles;
        if (!policy) return;

        const activeBase = this._path && path.basename(this._path);
        const activeStem = activeBase?.replace(/(?:\.\d+)?(?:\.log|)(?:\.gz)?$/, "");
        const reserved = [
            path.basename(this._auditPath),
            `${path.basename(this._auditPath)}.tmp`,
            `${path.basename(this._auditPath)}.corrupt`,
        ];

        try {
            const dirEntries = await fs.promises.readdir(this.dir);
            const candidates = dirEntries.filter(
                (n) =>
                    this._rxActive.test(n) &&
                    n !== activeBase &&
                    !(activeStem && n.startsWith(activeStem)) &&
                    !reserved.includes(n),
            );

            const stats: { full: string; mtimeMs: number }[] = [];
            for (const name of candidates) {
                const full = path.join(this.dir, name);
                try {
                    stats.push({ full, mtimeMs: (await fs.promises.stat(full)).mtimeMs });
                } catch {
                    /* raced deletion */
                }
            }
            stats.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

            const kill = new Set<string>();
            if (policy.days != null) {
                const cutoff = this._now() - policy.days * 86_400_000;
                for (const f of stats) if (f.mtimeMs < cutoff) kill.add(f.full);
            }
            if (policy.count != null) {
                const survivors = stats.filter((f) => !kill.has(f.full));
                const excessCount = survivors.length - policy.count;
                for (let i = 0; i < excessCount; i++) kill.add(survivors[i].full);
            }

            if (kill.size === 0) return;
            for (const file of kill) {
                await fs.promises.unlink(file).catch(() => { });
                if (this._auditEnabled) {
                    delete this._audit.files[path.basename(file)];
                    this._aevent("deleted", { file: path.basename(file) });
                }
                this.emit("deleted", file);
            }
            this._saveAudit();
        } catch (e) {
            this.emit("warn", e as Error);
        }
    }
}

/**
 * Convenience factory mirroring common rotator APIs.
 *
 * @example
 * const log = createStream({ filename: "logs/app-%DATE%.log" });
 */
export function createStream(options: RotateFileStreamOptions): RotateFileStream {
    return new RotateFileStream(options);
}