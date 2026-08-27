/**
 * logroller — zero-dependency rotating file streams for Node.js.
 *
 * @packageDocumentation
 */
export { RotateFileStream, createStream } from "./rotate-file-stream.js";
export type {
  RotateFileStreamOptions,
  RotateFileStreamEventMap,
  RotatedInfo,
  ClockInfo,
  RotationReason,
} from "./types.js";