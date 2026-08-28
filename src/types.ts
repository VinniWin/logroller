/**
 * logroller — public types.
 *
 * Everything exported here is part of the stable API surface.
 */

export type RotationReason = "time" | "size" | "manual";

/** Options accepted by {@linkcode RotateFileStream} and `createStream`. */
export interface RotateFileStreamOptions {
    /**
     * Destination filename pattern. REQUIRED and must contain the `%DATE%`
     * token.
     * @example "logs/app-%DATE%.log"
     */
    filename: string;

    /** Tokens: `YYYY YY MM DD HH mm ss`. Must be coarse-or-equal to your
     *  rotation frequency, or segments collapse onto one name.
     * @default "YYYY-MM-DD" */
    datePattern?: string;

    /** Gzip closed segments (`name.log` → `name.log.gz`).
     * @default false */
    zippedArchive?: boolean;

    /**
     * gzip level 0–9. 0 = stored (fastest, no ratio), 9 = best ratio,
     * 6 = default library default. Ignored when `zippedArchive` is false.
     * @default 6
     */
    compressionLevel?: number;

    /**
     * Roll when the next write would exceed this size per segment.
     * `"20m"`, `"512k"`, `"2g"`, or raw bytes. `0` disables.
     * @default 0 (unlimited)
     */
    maxSize?: number | string;

    /**
     * Retention by age or count:
     * - `"90d"` — delete archived files older than 90 days (mtime)
     * - `500`   — keep at most the newest 500 archived files
     * Unset means never auto-delete.
     */
    maxFiles?: number | string;

    /**
     * Retention by total byte budget across archived files (the active
     * segment is never counted). When archives exceed the budget, the
     * OLDEST are deleted until under budget. Composes with `maxFiles`
     * (either policy may delete). `"5g"`, `"500m"`, or raw bytes.
     * Unset/0 = no byte budget.
     */
    maxTotalSize?: number | string;

    /** IANA timezone for stamps and the daily boundary.
     * @default "UTC" */
    tz?: string;

    /** `"daily"` (local midnight in `tz`) or interval `"30s"`/`"5m"`/`"2h"`
     *  /ms. Interval boundaries align to epoch multiples.
     * @default "daily" */
    frequency?: number | string;

    /**
     * TEST ONLY. Static shift of the internal clock. `"-6h"`, `"24h"`,
     * plain/fractional number, or `"30m"`/`"90s"`.
     */
    addHours?: number | string;

    /**
     * TEST ONLY. Virtual time added per tick (see `clockStepIntervalMs`).
     * Negative values exercise the backward-clock guard (no rotations).
     */
    addHoursEveryMin?: number | string;

    /** Real interval between virtual-clock ticks.
     * @default 60_000 */
    clockStepIntervalMs?: number;

    /**
     * Maintain a stable "current" pointer for log collectors
     * (`tail -f`, Filebeat, promtail). `true` derives the name from the
     * prefix (`"app-"` → `app-current.log`); a string names it exactly.
     * The link is updated atomically each time a segment opens. Best-effort:
     * on filesystems denying symlinks (Windows without Developer Mode) it
     * warns once and disables itself.
     * @default false */
    symlink?: boolean | string;

    /**
     * Awaited after a segment is sealed/archived and BEFORE retention can
     * delete it — the extension point for uploading to S3/GCS. Errors and
     * timeouts degrade to a `warn`; they never break rotation.
     * @default undefined */
    onSeal?: (info: SealInfo) => Promise<void> | void;

    /** Hard deadline for one `onSeal` invocation.
     * @default 30_000 */
    sealHookTimeoutMs?: number;

    /** Detach rotation timers from the event loop.
     * @default false */
    unrefTimers?: boolean;

    /** Maintain `<stem>_audit.json` (library-owned; treat as read-only).
     * @default true */
    audit?: boolean;

    /** Override the audit manifest filename. */
    auditFile?: string;

    /** Passed through to the underlying `Writable`. */
    highWaterMark?: number;
}

/** Payload delivered to `onSeal` when a segment completes its lifecycle. */
export interface SealInfo {
    /** Closed segment path. May already be unlinked when `gz` exists. */
    raw: string;
    /** Compressed artifact; `null` when compression is off or failed. */
    gz: string | null;
}

/** One file of the stream family, as reported by `listSegments()`. */
export interface SegmentInfo {
    file: string;
    /** Date stamp embedded in the filename. */
    stamp: string;
    /** Segment index within the stamp (0 = base file). */
    index: number;
    gzipped: boolean;
    bytes: number;
    /** Audit state, or `"untracked"` for files unknown to the manifest. */
    state: string;
    openedAt?: string;
    archivedAt?: string;
}

/** Snapshot for dashboards/health checks — see `stats()`. */
export interface StreamStats {
    dir: string;
    currentStamp: string;
    activeFile: string | null;
    activeIndex: number;
    /** All family files on disk (active included). */
    segments: number;
    /** Of those, how many are compressed archives. */
    archived: number;
    totalBytes: number;
    /** Active virtual-clock shift (non-zero only under test knobs). */
    clockOffsetMs: number;
    /** Active symlink path, or `null`. */
    symlink: string | null;
}

/** Payload for the `rotated` event. */
export interface RotatedInfo {
    reason: RotationReason;
    oldFile: string | null;
    archive: string | null;
    newFile: string;
}

/** Payload for the `clock` event. */
export interface ClockInfo {
    addHours?: number | string;
    addHoursEveryMin?: number | string;
    offsetMs: number;
}

/** Tuple-style event map typing `on` / `once` / `emit`. */
export interface RotateFileStreamEventMap {
    open: [file: string];
    rotated: [info: RotatedInfo];
    archive: [gzFile: string];
    deleted: [file: string];
    period: [stamp: string];
    clock: [info: ClockInfo];
    warn: [err: Error];
    error: [err: Error];
    close: [];
}