import type { RotateFileStream } from "./rotate-file-stream.js";

const registry = new Set<RotateFileStream>();
let installed = false;
let inProgress: Promise<boolean> | null = null;

export interface ShutdownOptions {
    /** Signals to listen on. @default ["SIGINT", "SIGTERM"] */
    signals?: NodeJS.Signals[];
    /** Hard-exit deadline (ms) if a stream refuses to end.
     * @default 5000 */
    timeoutMs?: number;
    /** Process exit code. @default 0 */
    code?: number;
}

/**
 * Register streams for graceful shutdown: on SIGINT/SIGTERM every
 * registered stream is ended — flushing buffered writes and finishing the
 * audit manifest — before the process exits, with a hard deadline.
 *
 * Safe to call multiple times: process listeners install once, streams
 * accumulate in the registry.
 *
 * Returns `flush()`, the same graceful end WITHOUT exiting — for tests
 * and custom signal handling.
 *
 * @example
 * const flush = installShutdown(logStream);
 * process.on("exit", () => { void flush(); });
 */
export function installShutdown(
    streams: RotateFileStream | RotateFileStream[],
    opts: ShutdownOptions = {},
): () => Promise<void> {
    const list = Array.isArray(streams) ? streams : [streams];
    for (const s of list) registry.add(s);

    if (!installed) {
        installed = true;
        const timeoutMs = opts.timeoutMs ?? 5_000;
        const code = opts.code ?? 0;
        for (const sig of opts.signals ?? (["SIGINT", "SIGTERM"] as NodeJS.Signals[])) {
            process.on(sig, () => {
                void flushAll(timeoutMs).then((clean) => process.exit(clean ? code : 1));
            });
        }
    }

    return async () => {
        // flush FIRST — flushAll() drains the registry, so unregistering
        // before flushing would flush nothing (caught by the shutdown test)
        await flushAll(opts.timeoutMs ?? 5_000);
        for (const s of list) registry.delete(s);
    };
}

/**
 * End every registered stream (flush buffered writes) with a deadline.
 * Does NOT exit the process. Resolves `true` when every stream finished,
 * `false` when the deadline hit first. Concurrent calls share one flush.
 * Ended/destroyed streams leave the registry.
 */
export function flushAll(timeoutMs = 5_000): Promise<boolean> {
    inProgress ??= (async () => {
        let deadline: NodeJS.Timeout | undefined;
        try {
            const ended = Promise.allSettled(
                [...registry].map(
                    (s) => new Promise<void>((res) => {
                        s.once("close", res);
                        s.end(() => res());
                        if (s.destroyed) res();
                    }),
                ),
            ).then(() => true);
            const timedOut = new Promise<boolean>((res) => {
                deadline = setTimeout(() => res(false), timeoutMs);
                deadline.unref();
            });
            return await Promise.race([ended, timedOut]);
        } finally {
            clearTimeout(deadline);
            for (const s of registry) if (s.writableFinished || s.destroyed) registry.delete(s);
            inProgress = null;
        }
    })();
    return inProgress;
}