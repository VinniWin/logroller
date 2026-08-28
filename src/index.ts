/**
 * logroller — zero-dependency rotating file streams for Node.js.
 *
 * @packageDocumentation
 */
export { createStream, RotateFileStream } from "./rotate-file-stream.js";
export { flushAll, installShutdown } from "./shutdown.js";
export type { ShutdownOptions } from "./shutdown.js";
export type {
  ClockInfo, RotatedInfo, RotateFileStreamEventMap, RotateFileStreamOptions, RotationReason,
  SealInfo,
  SegmentInfo,
  StreamStats
} from "./types.js";

