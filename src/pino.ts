/**
 * pino (v7+) transport target: `transport: { target: "logroller/pino", options }`.
 * pino loads this module in a worker thread and writes to the returned stream.
 */
import { createStream } from "./rotate-file-stream.js";
import type { RotateFileStream } from "./rotate-file-stream.js";
import type { RotateFileStreamOptions } from "./types.js";

export default function pinoTransport(options: RotateFileStreamOptions): RotateFileStream {
    return createStream(options);
}
