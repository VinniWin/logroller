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
     * token, which is replaced by the formatted current date/time.
     *
     * @example "logs/app-%DATE%.log"
     */
    filename: string;

    /**
     * Date token pattern substituted for `%DATE%`.
     *
     * Supported tokens: `YYYY YY MM DD HH mm ss`.
     * Use tokens coarser-or-equal to your rotation frequency — hourly
     * rotation with a day-only pattern collapses multiple files onto one name.
     *
     * @default "YYYY-MM-DD"
     */
    datePattern?: string;

    /** Gzip closed segments (`name.log` → `name.log.gz`). */
    /** @default false */
    zippedArchive?: boolean;

    /**
     * Maximum bytes per segment before rolling. Accepts raw numbers (bytes)
     * or human strings: `"20m"`, `"512k"`, `"2g"`, `"100b"`.
     * `0` disables size-based rotation.
     * @default 0 (unlimited)
     */
    maxSize?: number | string;

    /**
     * Retention policy for this stream family.
     * - `"90d"` — delete archived files older than 90 days (by mtime)
     * - `500`   — keep at most the newest 500 archived files
     * Unset means **never** auto-delete.
     */
    maxFiles?: number | string;

    /**
     * IANA timezone used for date stamps and the daily boundary.
     * Resolved via `Intl.DateTimeFormat`; throws early if invalid.
     * @default "UTC"
     */
    tz?: string;

    /**
     * Rotation cadence: `"daily"` (local midnight in `tz`) or an interval
     * like `"30s"`, `"5m"`, `"2h"`, or a millisecond number.
     * Interval boundaries align to epoch multiples (hh:00:00 for `"1h"`).
     * @default "daily"
     */
    frequency?: number | string;

    /**
     * TEST ONLY. Static shift of the internal clock, in hours.
     * `"-6h"`, `"24h"`, or a plain number (fractional allowed).
     * Affects naming, timers, and retention cutoffs — never production data.
     */
    addHours?: number | string;

    /**
     *  TEST ONLY. Amount of virtual time added to the internal clock at
     * every tick ({@linkcode RotateFileStreamOptions.clockStepIntervalMs}),
     * simulating passing days: crossing into a new period archives the old
     * segment exactly like a real midnight roll.
     */
    addHoursEveryMin?: number | string;

    /**
     * Real interval between virtual-clock ticks (see `addHoursEveryMin`).
     * Lower it to fast-forward faster in integration tests.
     * @default 60_000
     */
    clockStepIntervalMs?: number;

    /** Detach rotation timers from the event loop (`timer.unref()`). */
    /** @default false */
    unrefTimers?: boolean;

    /**
     * Maintain `<stem>_audit.json` beside the logs: lifecycle manifest,
     * uuid-tagged journal, restart recovery, interrupted-gzip repair,
     * zombie-process detection. Library-owned; treat as read-only.
     * @default true
     */
    audit?: boolean;

    /** Override the audit manifest filename. Default derives from the prefix. */
    auditFile?: string;

    /** Passed through to the underlying `Writable`. */
    highWaterMark?: number;
}

/** Payload for the `rotated` event. */
export interface RotatedInfo {
    reason: RotationReason;
    /** Segment that was closed; `null` when nothing was open. */
    oldFile: string | null;
    /** Gzip artifact created for it; `null` when unzipped, empty, or failed. */
    archive: string | null;
    /** Segment subsequent writes go to (opened lazily). */
    newFile: string;
}

/** Payload for the `clock` event (emitted when a virtual clock is active). */
export interface ClockInfo {
    addHours?: number | string;
    addHoursEveryMin?: number | string;
    offsetMs: number;
}

/**
 * Tuple-style event map used to type `on` / `once` / `emit`.
 * Keys mirror Node core lifecycle events where relevant.
 */
export interface RotateFileStreamEventMap {
    /** A segment file was opened for appending. */
    open: [file: string];
    /** A segment completed its lifecycle; see {@linkcode RotatedInfo}. */
    rotated: [info: RotatedInfo];
    /** A gzip archive finished successfully. */
    archive: [gzFile: string];
    /** Retention removed a file. */
    deleted: [file: string];
    /** Period changed with nothing to archive (idle boundary slide). */
    period: [stamp: string];
    /** Virtual clock engaged (test knobs). */
    clock: [info: ClockInfo];
    /** Non-fatal problem: gzip failure, divergent state, stray writer… */
    warn: [err: Error];
    /** Fatal problem mid-write; mirrors `Writable#close` semantics. */
    error: [err: Error];
    /** Stream fully closed. */
    close: [];
}