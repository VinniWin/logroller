import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

/* ================================================================
 * Public types
 * ================================================================ */
export type RotationReason = "time" | "size" | "manual";

export interface RotateFileStreamOptions {
  /** Required. Must contain %DATE% — e.g. "logs/app-%DATE%.log" */
  filename: string;
  /** Tokens: YYYY YY MM DD HH mm ss. Default "YYYY-MM-DD". */
  datePattern?: string;
  /** gzip closed segments. Default false. */
  zippedArchive?: boolean;
  /** Roll when next write would exceed: 20 | "20m" | "1k" | "5g". 0/undefined = off. */
  maxSize?: number | string;
  /** Retention: "90d" (age) | 500 (count). Unset = never delete. */
  maxFiles?: number | string;
  /** Any IANA zone. Default "UTC". */
  tz?: string;
  /** "daily" | "1s" | "5m" | "2h" | ms number. Default "daily". */
  frequency?: number | string;
  /** Static virtual-clock shift in hours ("-6h", 1.5). TEST ONLY. */
  addHours?: number | string;
  /** Amount added to the clock every clockStepIntervalMs ("24h"). TEST ONLY. */
  addHoursEveryMin?: number | string;
  /** How often addHoursEveryMin applies. Default 60_000 ms. */
  clockStepIntervalMs?: number;
  /** Don't hold the process open via rotation timers. */
  unrefTimers?: boolean;
  /** Write <stem>_audit.json manifest. Default true. */
  audit?: boolean;
  /** Override manifest filename. */
  auditFile?: string;
  highWaterMark?: number;
}

export interface RotatedInfo {
  reason: RotationReason;
  oldFile: string | null;
  archive: string | null;
  newFile: string;
}

export interface ClockInfo {
  addHours?: number | string;
  addHoursEveryMin?: number | string;
  offsetMs: number;
}

export interface RotateFileStreamEvents {
  open: (file: string) => void;
  rotated: (info: RotatedInfo) => void;
  archive: (gzFile: string) => void;
  deleted: (file: string) => void;
  period: (stamp: string) => void;
  clock: (info: ClockInfo) => void;
  warn: (err: Error) => void;
  error: (err: Error) => void;   // ◀ TS FIX: used internally by Writable contract
  close: () => void;             // ◀ TS FIX: used internally
}

/** ◀ TS FIX: interface members SHADOW inherited Writable.on/emit.
 *  Add a generic string fallback so `.pipe()` stays structurally valid. */
export interface RotateFileStream {
  on<E extends keyof RotateFileStreamEvents>(
    event: E,
    listener: RotateFileStreamEvents[E],
  ): this;
  on(event: string, listener: (...args: any[]) => void): this;
  once<E extends keyof RotateFileStreamEvents>(
    event: E,
    listener: RotateFileStreamEvents[E],
  ): this;
  once(event: string, listener: (...args: any[]) => void): this;
  emit<E extends keyof RotateFileStreamEvents>(
    event: E,
    ...args: Parameters<RotateFileStreamEvents[E]>
  ): boolean;
  emit(event: string, ...args: any[]): boolean;
}

/* ================================================================
 * Internal types
 * ================================================================ */
interface ParsedMaxFiles { days?: number; count?: number }
type ParsedFrequency = { type: "daily" } | { type: "interval"; ms: number };

type FileState =
  | "active" | "sealed" | "archived" | "closed"
  | "abandoned" | "kept-raw" | "lost";

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

/* ================================================================
 * Option parsers
 * ================================================================ */
const UNITS: Record<string, number> = {
  b: 1, k: 1024, kb: 1024,
  m: 1048576, mb: 1048576,
  g: 1073741824, gb: 1073741824,
};

const FREQ_MULT: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };

function parseSize(v: number | string | null | undefined): number {
  if (v === undefined || v === null || v === 0) return 0;
  if (typeof v === "number") return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?\s*$/i.exec(v);
  if (!m) throw new Error(`Invalid maxSize "${v}"`);
  return Math.round(Number.parseFloat(m[1]) * (UNITS[m[2]?.toLowerCase()] ?? 1));
}

function parseMaxFiles(v: number | string | null | undefined): ParsedMaxFiles | null {
  if (v === undefined || v === null || v === "" || v === 0) return null;
  if (typeof v === "number") return { count: v };
  let m = /^\s*(\d+)\s*d\s*$/i.exec(v);
  if (m) return { days: Number.parseInt(m[1], 10) };
  m = /^\s*(\d+)\s*$/.exec(v);
  if (m) return { count: Number.parseInt(m[1], 10) };
  throw new Error(`Invalid maxFiles "${v}"`);
}

function parseFrequency(v: number | string | null | undefined): ParsedFrequency {
  if (v === undefined || v === null) v = "daily";
  if (v === "daily") return { type: "daily" };
  if (typeof v === "number" && v > 0) return { type: "interval", ms: v };
  const m = /^\s*(\d+)\s*(ms|s|m|h)\s*$/i.exec(String(v));
  if (!m) throw new Error(`Invalid frequency "${v}"`);
  const mult = FREQ_MULT[m[2].toLowerCase()] ?? 1;              // ◀ TS FIX
  return { type: "interval", ms: Number.parseInt(m[1], 10) * mult };
}

function parseClockOffset(v: number | string | null | undefined): number {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number") return Math.round(v * 3600000);
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*h(?:our)?s?\s*$/i.exec(v);
  if (!m) throw new Error(`Invalid addHours "${v}"`);
  return Math.round(Number.parseFloat(m[1]) * 3600000);
}

function parseClockStep(v: number | string | null | undefined): number {
  if (v === undefined || v === null || v === "" || v === 0) return 0;
  if (typeof v === "number") return Math.round(v * 3600000);
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(v);
  if (!m) throw new Error(`Invalid addHoursEveryMin "${v}"`);
  const mult = FREQ_MULT[(m[2] || "h").toLowerCase()] ?? 1;     // ◀ TS FIX
  return Math.round(Number.parseFloat(m[1]) * mult);
}

/* ================================================================
 * Timezone helpers
 * ================================================================ */
const _dtfCache = new Map<string, Intl.DateTimeFormat>();

function getDtf(tz: string): Intl.DateTimeFormat {
  let d = _dtfCache.get(tz);
  if (!d) {
    try {
      d = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new Error(`Invalid timeZone "${tz}"`);
    }
    _dtfCache.set(tz, d);
  }
  return d;
}

function partsIn(tz: string, date: Date): Record<string, string> {
  const o: Record<string, string> = {};
  for (const p of getDtf(tz).formatToParts(date)) o[p.type] = p.value;
  return o;
}

const pad2 = (n: string) => n.padStart(2, "0");
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function formatStamp(pattern: string, parts: Record<string, string>): string {
  return pattern.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (t) =>
    t === "YYYY" ? parts.year :
      t === "YY" ? parts.year.slice(-2) :
        t === "MM" ? pad2(parts.month) :
          t === "DD" ? pad2(parts.day) :
            t === "HH" ? pad2(parts.hour) :
              t === "mm" ? pad2(parts.minute) :
                t === "ss" ? pad2(parts.second) : t,
  );
}

function tzOffsetMs(tz: string, date: Date): number {
  const p = partsIn(tz, date);
  return (
    Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) -
    (date.getTime() - (date.getTime() % 1000))
  );
}

function nextMidnight(tz: string, fromMs: number): number {
  const p = partsIn(tz, new Date(fromMs));
  const localNext = Date.UTC(+p.year, +p.month - 1, +p.day + 1);
  let inst = localNext - tzOffsetMs(tz, new Date(localNext));
  for (let i = 0; i < 3; i++) {
    const cand = localNext - tzOffsetMs(tz, new Date(inst));
    if (cand === inst) break;
    inst = cand;
  }
  if (inst <= fromMs) inst += 86400000;
  return inst;
}

const nextAligned = (from: number, step: number) =>
  Math.floor(from / step) * step + step;

/* ================================================================
 * Utilities
 * ================================================================ */
const statSizeSafe = (p: string | null | undefined): number => {
  try {
    return typeof p === "string" ? fs.statSync(p).size : 0;
  } catch {
    return 0;
  }
};

const existsSafe = (p: string): boolean => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

/** ◀ TS FIX: takes an onWarn CALLBACK instead of an emitter object,
 *  so the strictly-typed `emit` can be passed without casts. */
async function gzipMove(
  src: string,
  dst: string,
  onWarn?: (err: Error) => void,
): Promise<boolean> {
  try {
    await pipeline(
      fs.createReadStream(src),
      zlib.createGzip({ level: 6 }),
      fs.createWriteStream(dst),
    );
    await fs.promises.unlink(src);
    return true;
  } catch (err) {
    await fs.promises.unlink(dst).catch(() => { });
    onWarn?.(err as Error);
    return false;
  }
}

const endStream = (ws: fs.WriteStream | null): Promise<void> =>
  ws ? new Promise((r) => ws.end(() => r())) : Promise.resolve();

const BUMP_DEFAULT_MS = 60_000;
const AUDIT_MAX_FILES = 600;
const HEARTBEAT_STALE_MS = 30_000;

/* ================================================================
 * Main class
 * ================================================================ */
export class RotateFileStream extends Writable {
  readonly tz: string;
  readonly template: string;
  readonly dir: string;
  readonly datePattern: string;
  readonly zippedArchive: boolean;
  readonly maxSize: number;
  readonly maxFiles: ParsedMaxFiles | null;
  readonly freq: ParsedFrequency;
  readonly unrefTimers: boolean;

  private readonly _tL: string;
  private readonly _tMid: string;
  private readonly _tExt: string;
  private readonly _rxFor: (stampSrc: string) => RegExp;
  private readonly _rxActive: RegExp;
  private readonly _auditEnabled: boolean;
  private readonly _auditPath: string;
  private readonly _bootId = randomUUID();

  private _offsetMs: number;
  private _stepMs: number;
  private _bumpEvery: number;

  private _curStamp: string;
  private _index: number;
  private _ws: fs.WriteStream | null = null;
  private _path: string | null = null;
  private _bytes = 0;
  private _timer: NodeJS.Timeout | null = null;
  private _bumpTimer: NodeJS.Timeout | null = null;
  private _ended = false;
  private _tail: Promise<unknown> = Promise.resolve();
  private _audit!: AuditDoc;

  // ◀ TS FIX: Partial<> + runtime validation (default {} is legal now)
  constructor(opts: Partial<RotateFileStreamOptions> = {}) {
    super(opts.highWaterMark ? { highWaterMark: opts.highWaterMark } : {});

    if (typeof opts.filename !== "string" || !opts.filename.includes("%DATE%"))
      throw new Error("opts.filename must contain '%DATE%'");

    this.tz = opts.tz || "UTC";
    getDtf(this.tz);

    this.template = path.basename(opts.filename);
    this.dir = path.dirname(opts.filename);
    this.datePattern = opts.datePattern || "YYYY-MM-DD";
    this.zippedArchive = !!opts.zippedArchive;
    this.maxSize = parseSize(opts.maxSize ?? 0);
    this.maxFiles = parseMaxFiles(opts.maxFiles);
    this.freq = parseFrequency(opts.frequency);
    this.unrefTimers = !!opts.unrefTimers;
    this._offsetMs = parseClockOffset(opts.addHours);
    this._stepMs = parseClockStep(opts.addHoursEveryMin);
    this._bumpEvery = Math.max(50, opts.clockStepIntervalMs ?? BUMP_DEFAULT_MS);

    const li = this.template.indexOf("%DATE%");
    const rest = this.template.slice(li + 6);
    const dot = rest.lastIndexOf(".");
    this._tL = this.template.slice(0, li);
    this._tMid = dot >= 0 ? rest.slice(0, dot) : "";
    this._tExt = dot >= 0 ? rest.slice(dot) : "";

    this._rxFor = (stampSrc: string) =>
      new RegExp(
        "^" + escRe(this._tL) + stampSrc + escRe(this._tMid) +
        "(?:\\.(\\d+))?" + escRe(this._tExt) + "(?:\\.gz)?$",
      );
    this._rxActive = this._rxFor("[^.]+");

    this._auditEnabled = opts.audit !== false;
    const stem = (this._tL.replace(/[^\w.-]+/g, "") || "log").replace(
      /^[-.]+|[-.]+$/, "",
    );
    this._auditPath = path.join(this.dir, opts.auditFile || `${stem}_audit.json`);

    fs.mkdirSync(this.dir, { recursive: true });

    this._curStamp = this._stampNow();
    this._resetAuditObject();
    const hadAudit = this._auditEnabled && this._loadAudit();
    this._index = this._recoverIndexFor(this._curStamp);

    // ◀ TS FIX: local const narrows away null (Number.isInteger doesn't)
    const ai = this._audit.activeIndex;
    if (hadAudit && ai !== null && this._audit.activeStamp === this._curStamp) {
      this._index = Math.max(this._index, ai);
    }

    if (this._offsetMs !== 0 || this._stepMs !== 0)
      process.nextTick(() =>
        this.emit("clock", {
          addHours: opts.addHours ?? undefined,
          addHoursEveryMin: opts.addHoursEveryMin ?? undefined,
          offsetMs: this._offsetMs,
        }),
      );

    /* boot audit pass = job #1 in the serial queue.
   Chained HERE (not nextTick) so it always runs before any write job:
   zombie demotion sees _path === null, and gzip-repair can never race
   with a write reopening a pending file.                        */
    this._job(async () => {
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
    this.once("close", () => {           // ok now: "close" is in the events map
      this._stopTimer();
      this._stopBump();
    });
  }

  /* ---------------- public ---------------- */

  get filename(): string | null {
    return this._path;
  }

  get currentIndex(): number {
    return this._index;
  }

  private _now(): number {
    return Date.now() + this._offsetMs;
  }

  rotateNow(): Promise<void> {
    return this._job(() => this._rotate("manual"));
  }

  /** Apply one virtual-clock step immediately (test helper). */
  advanceClock(): Promise<void> {
    return this._job(() => this._applyBump());
  }

  /* ---------------- audit internals ---------------- */

  private _resetAuditObject(): void {
    this._audit = {
      version: 1,
      prefix: this._tL,
      ext: this._tExt,
      datePattern: this.datePattern,
      tz: this.tz,
      createdAt: null,
      updatedAt: null,
      activeStamp: null,
      activeIndex: null,
      writer: null,
      files: {},
      events: [],
    };
  }

  private _loadAudit(): boolean {
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(this._auditPath, "utf8"));
      } catch {
        return false;
      }
      const j = raw as Partial<AuditDoc> | null;
      if (j && j.version === 1 && j.prefix === this._tL && j.ext === this._tExt) {
        this._audit.createdAt = j.createdAt || new Date().toISOString();
        this._audit.updatedAt = null;
        this._audit.activeStamp =
          typeof j.activeStamp === "string" ? j.activeStamp : null;
        this._audit.activeIndex =
          Number.isInteger(j.activeIndex as number) ? (j.activeIndex as number) : null;
        this._audit.files =
          j.files && typeof j.files === "object"
            ? (j.files as Record<string, AuditFileRecord>)
            : {};
        this._audit.events = Array.isArray(j.events)
          ? (j.events as AuditEvent[]).slice(-200)
          : [];

        const w = j.writer;
        if (
          w && w.bootId && w.bootId !== this._bootId &&
          typeof w.heartbeat === "number" &&
          Date.now() - w.heartbeat < HEARTBEAT_STALE_MS
        ) {
          const err = new Error(
            `concurrent writer detected (pid ${w.pid}, boot ${w.bootId}). ` +
            `Two processes are sharing this log family — results will race. ` +
            `If using 'node --watch', add --watch-path to exclude the logs dir.`,
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
      try {
        fs.renameSync(this._auditPath, this._auditPath + ".corrupt");
      } catch {
        /* ignore */
      }
    } catch {
      /* fallthrough */
    }
    return false;
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
      const tmp = this._auditPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this._audit, null, 1));
      fs.renameSync(tmp, this._auditPath);
    } catch (e) {
      this.emit("warn", e as Error);
    }
  }

  private _pruneAuditFiles(): void {
    const f = this._audit.files;
    const keys = Object.keys(f);
    if (keys.length <= AUDIT_MAX_FILES) return;
    const activeBase = this._path && path.basename(this._path);
    const dated = (r: AuditFileRecord) =>
      r.archivedAt || r.closedAt || r.abandonedAt || r.openedAt || "";
    const stale = keys
      .filter((k) => k !== activeBase && f[k].state !== "active")
      .sort((a, b) => dated(f[a]).localeCompare(dated(f[b])));
    for (const k of stale.slice(0, keys.length - AUDIT_MAX_FILES + 50)) delete f[k];
  }

  private _aevent(type: string, extra: Record<string, unknown> = {}): void {
    if (!this._auditEnabled) return;
    this._audit.events.push({
      id: randomUUID(),
      t: new Date().toISOString(),
      type,
      ...extra,
    });
    if (this._audit.events.length > 200)
      this._audit.events.splice(0, this._audit.events.length - 200);
  }

  private _setActivePointer(index: number): void {
    this._audit.activeStamp = this._curStamp;
    this._audit.activeIndex = index;
  }

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

  private _reconcileWithDisk(): void {
    for (const name of Object.keys(this._audit.files)) {
      const rec = this._audit.files[name];
      if (rec.gzipPending) continue;

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
            new Error(
              `archive ${name} missing but raw ${rawName} exists — record reverted`,
            ),
          );
          continue;
        }
        this._aevent("vanished", { file: name });
        delete this._audit.files[name];
        continue;
      }

      const rawExists = existsSafe(path.join(this.dir, name));
      const gzExists = existsSafe(path.join(this.dir, name + ".gz"));
      if (rawExists) continue;
      if (gzExists) {
        this._finishArchivedRecord(name, true);
        continue;
      }
      this._aevent("vanished", { file: name });
      delete this._audit.files[name];
    }
  }

  private async _repairInterruptedGzips(): Promise<void> {
    for (const [name, rec] of Object.entries(this._audit.files)) {
      if (!rec.gzipPending) continue;
      const src = path.join(this.dir, name);
      const dst = src + ".gz";

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
      // ◀ TS FIX: callback instead of emitter object
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

  private _finishArchivedRecord(rawName: string, repaired = false): void {
    const rec = this._audit.files[rawName];
    if (!rec) return;
    rec.gzipPending = false;
    rec.state = "archived";
    rec.archivedAt = new Date().toISOString();
    if (rawName.endsWith(".gz")) {
      this.emit("archive", path.join(this.dir, rawName));
      this._aevent("archive", { file: rawName, ...(repaired && { repaired }) });
    } else {
      const gzName = rawName + ".gz";
      delete this._audit.files[rawName];
      this._audit.files[gzName] = rec;
      this.emit("archive", path.join(this.dir, gzName));
      this._aevent("archive", { file: gzName, ...(repaired && { repaired }) });
    }
  }

  /* ---------------- Writable ---------------- */

  override _write(
    chunk: any,
    encoding: BufferEncoding,
    cb: (error?: Error | null) => void,
  ): void {
    if (this._ended) {
      process.nextTick(cb, new Error("write after end"));
      return;
    }
    const len: number = chunk.length;

    this._job(async () => {
      try {
        const s = this._stampNow();
        if (s !== this._curStamp) await this._rotate("time");

        await this._ensureOpen();

        if (
          this.maxSize > 0 &&
          this._bytes > 0 &&
          this._bytes + len > this.maxSize
        ) {
          await this._rotate("size");
          await this._ensureOpen();
        }

        // ◀ TS FIX: narrow instead of `this._ws!`
        const ws = this._ws;
        if (!ws) throw new Error("write stream not open");

        await new Promise<void>((res, rej) =>
          ws.write(chunk, encoding, (e) => (e ? rej(e) : res())),
        );
        this._bytes += len;
        cb();
      } catch (err) {
        this.emit("error", err as Error);   // ok now: "error" in the events map
        cb(err as Error);
      }
    }).catch(() => { });
  }

  override _final(cb: (error?: Error | null) => void): void {
    this._ended = true;
    this._stopTimer();
    this._stopBump();
    this._job(async () => {
      await endStream(this._ws);
      const b = this._path && path.basename(this._path);
      if (b && this._audit.files[b]) {
        this._audit.files[b].state = "closed";
        this._audit.files[b].closedAt = new Date().toISOString();
        this._audit.files[b].bytes = statSizeSafe(this._path);
        this._aevent("close", { file: b });
        this._saveAudit();
      }
      this._ws = null;
      this._path = null;
    })
      .catch(() => { })
      .finally(() => cb());
  }

  override destroy(...args: Parameters<Writable["destroy"]>): this {
    this._stopTimer();
    this._stopBump();
    return super.destroy(...args);
  }

  /* ---------------- core ---------------- */

  private _job<T>(fn: () => T | Promise<T>): Promise<T> {
    const p = this._tail.then(fn, fn) as Promise<T>;
    this._tail = p.catch(() => { });
    return p;
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

  private _recoverIndexFor(stamp: string): number {
    const rx = this._rxFor(escRe(stamp));
    let maxAny = -1;
    let maxRaw = -1;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      /* ignore */
    }
    for (const n of names) {
      const m = rx.exec(n);
      if (!m) continue;
      const idx = m[1] ? Number.parseInt(m[1], 10) : 0;
      if (idx > maxAny) maxAny = idx;
      if (!n.endsWith(".gz") && idx > maxRaw) maxRaw = idx;
    }
    let idx = maxRaw >= 0 ? maxRaw : maxAny >= 0 ? maxAny + 1 : 0;

    // ◀ TS FIX: local const narrows away null
    const ai = this._audit.activeIndex;
    if (
      this._auditEnabled &&
      ai !== null &&
      this._audit.activeStamp === stamp
    ) {
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
      const b = path.basename(p);
      const prev = this._audit.files[b];
      this._audit.files[b] = {
        ...(prev && prev.state === "archived" ? {} : prev),
        index: this._index,
        state: "active",
        gzipPending: false,
        openedAt: new Date().toISOString(),
      };
      this._setActivePointer(this._index);
      this._aevent("open", {
        file: b,
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

    // ◀ TS FIX: guard on oldPath too — narrows string|null for the whole block,
    // removing every `!` and the null-concatenation risk
    if (oldWs && oldPath) {
      await endStream(oldWs);
      const real = statSizeSafe(oldPath);
      const abase = path.basename(oldPath);
      const arec = this._auditEnabled ? this._audit.files[abase] : null;

      if (this.zippedArchive && real > 0) {
        archive = oldPath + ".gz";
        if (arec) {
          arec.gzipPending = true;
          arec.bytes = real;
          this._saveAudit();
        }
        const ok = await gzipMove(oldPath, archive, (e) => this.emit("warn", e));
        if (ok) {
          this._finishArchivedRecord(abase);
        } else {
          if (arec) {
            arec.gzipPending = false;
            arec.state = "kept-raw";
          }
          this._aevent("gzip-failed", { file: abase });
          archive = null;
        }
      } else if (real === 0) {
        try {
          fs.unlinkSync(oldPath);
        } catch {
          /* ignore */
        }
        if (arec) delete this._audit.files[abase];
        this._aevent("drop-empty", { file: abase });
      } else if (arec) {
        arec.state = "sealed";
        arec.bytes = real;
      }
    }

    const s = this._stampNow();
    const newPeriod = s !== this._curStamp;
    this._curStamp = s;
    this._index = newPeriod
      ? this._recoverIndexFor(s)
      : kind === "time"
        ? this._recoverIndexFor(s)
        : this._index + 1;
    this._bytes = 0;

    if (this._auditEnabled) {
      this._setActivePointer(this._index);
      this._aevent("rotate", { reason: kind, nextIndex: this._index, stamp: s });
      this._saveAudit();
    }

    if (kind === "time" || kind === "manual") this._armTimer();

    if (oldPath)
      this.emit("rotated", {
        reason: kind,
        oldFile: oldPath,
        archive,
        newFile: this._resolveName(s, this._index),
      });

    this._retire();
  }

  /* ---------------- timers ---------------- */

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

    this._timer = setTimeout(
      () => {
        this._job(async () => {
          const s = this._stampNow();
          if (
            (this.freq.type === "daily" && s !== this._curStamp) ||
            this.freq.type !== "daily"
          ) {
            if (this._hasContent()) {
              await this._rotate("time");
            } else if (s !== this._curStamp) {
              this._curStamp = s;
              this._index = this._recoverIndexFor(s);
              if (this._auditEnabled) {
                this._setActivePointer(this._index);
                this._aevent("period", { stamp: s });
                this._saveAudit();
              }
              this.emit("period", s);
            }
          }
          this._armTimer();
        }).catch(() => { });
      },
      Math.max(100, next - this._now()),
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

    const s = this._stampNow();
    if (s !== this._curStamp) {
      if (this._hasContent()) {
        await this._rotate("time");
      } else {
        this._curStamp = s;
        this._index = this._recoverIndexFor(s);
        if (this._auditEnabled) {
          this._setActivePointer(this._index);
          this._aevent("period", { stamp: s, virtual: true });
        }
        this.emit("period", s);
      }
    }
    if (this._auditEnabled) {
      this._aevent("clock-step", {
        addedMsPerMin: this._stepMs,
        offsetMs: this._offsetMs,
        stamp: s,
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

  /* ---------------- retention ---------------- */

  private async _retire(): Promise<void> {
    if (!this.maxFiles) return;

    const activeBase = this._path && path.basename(this._path);
    const activeStem =
      activeBase && activeBase.replace(/(?:\.\d+)?(?:\.log|)(?:\.gz)?$/, "");
    const auditNames = [
      path.basename(this._auditPath),
      path.basename(this._auditPath) + ".tmp",
      path.basename(this._auditPath) + ".corrupt",
    ];

    try {
      const names = (await fs.promises.readdir(this.dir)).filter(
        (n) =>
          this._rxActive.test(n) &&
          n !== activeBase &&
          !(activeStem && n.startsWith(activeStem)) &&
          !auditNames.includes(n),
      );

      const info: { full: string; mt: number }[] = [];
      for (const n of names) {
        const full = path.join(this.dir, n);
        try {
          info.push({ full, mt: (await fs.promises.stat(full)).mtimeMs });
        } catch {
          /* ignore */
        }
      }
      info.sort((a, b) => a.mt - b.mt);

      const kill = new Set<string>();
      if (this.maxFiles.days != null) {
        const cut = this._now() - this.maxFiles.days * 86400000;
        for (const f of info) if (f.mt < cut) kill.add(f.full);
      }
      if (this.maxFiles.count != null) {
        const rest = info.filter((f) => !kill.has(f.full));
        for (const f of rest.slice(
          0,
          Math.max(0, rest.length - this.maxFiles.count),
        ))
          kill.add(f.full);
      }

      let removed = false;
      for (const f of kill) {
        await fs.promises.unlink(f).catch(() => { });
        if (this._auditEnabled) {
          delete this._audit.files[path.basename(f)];
          this._aevent("deleted", { file: path.basename(f) });
        }
        this.emit("deleted", f);
        removed = true;
      }
      if (removed) this._saveAudit();
    } catch (e) {
      this.emit("warn", e as Error);
    }
  }
}

/* ================================================================
 * Factory
 * ================================================================ */
export function createStream(options: RotateFileStreamOptions): RotateFileStream {
  return new RotateFileStream(options);
}