# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.2] — 2026-08-28

### Fixed

- **Corrupt audit manifest quarantine**: an unparseable `<stem>_audit.json`
  (partial write, bad edit) is now renamed to `.corrupt` and preserved,
  matching existing behaviour for version/family mismatches. Previously it
  was silently overwritten by the first manifest save, destroying the
  event journal.
- **Backward-clock safety**: a clock moving backward (NTP correction,
  manual change) no longer reopens a past log family or forks the segment
  series. The stream keeps the current segment, warns once, and resumes
  normal rotation when the clock catches up.
- **Timer anti-spin**: with the rotation boundary in the past (backward
  clock), the timer now polls at 1 s instead of firing every 100 ms,
  which previously could keep processes from exiting cleanly.

### Added

- **Construction-time pattern warning**: warns when `frequency` is finer
  than the `datePattern` tokens allow (`daily`→`DD`, sub-daily→`HH`,
  sub-minute→`mm`), preventing silent filename collisions where many
  rotations overwrite a single file.

### Tests

- Suite expanded to 23 tests: interrupted-gzip repair, manifest divergence
  healing (`archive-regressed`, `vanished`), manifest quarantine,
  concurrent-writer detection, IST-midnight boundary, idle `period` slide,
  `rotateNow()`, over-max resume, backward-clock guard, and coarse-pattern
  warning.

## [2.0.1] — 2026-08-27

### Fixed

- Reactivated segments no longer inherit stale lifecycle timestamps
  (`abandonedAt` could predate `openedAt`).
- Raw tails of already-passed periods are now gzipped at boot
  (crash-near-midnight no longer leaves yesterday's file uncompressed).
- Rotation adopts a `.gz` produced by a (warned-about) concurrent writer
  instead of recording a false `drop-empty` that orphaned the archive.

## [2.0.0] — 2026-08-28

Architecture release: the library moved from a single-file JavaScript SDK to a
modular **TypeScript** codebase with strict typings, first-class DX tooling,
and CI-gated releases. The public runtime API (`createStream`,
`RotateFileStream`, all options and events) remains compatible with 1.x;
TypeScript consumers gain full type coverage.

> ⚠️ Consumers on 1.x should re-run their smoke/integration tests after
> upgrading — mostly due to the deterministic boot-order fix below.

### Added

- **Full TypeScript source with shipped declarations** (`dist/index.d.ts`);
  strict-mode compile (`noImplicitOverride`, `noUnusedLocals`,
  `verbatimModuleSyntax`, …).
- **Tuple-typed events** via `RotateFileStreamEventMap` — `on("rotated", …)`
  autocompletes and payload types are checked (`RotatedInfo`, `ClockInfo`),
  while Node-core fallback overloads keep `.pipe()` structurally valid.
- `advanceClock()` — apply one virtual-clock tick immediately (previously the
  step timer fired only every minute); makes day-crossing tests fully
  deterministic.
- `clockStepIntervalMs` option — control how often `addHoursEveryMin` ticks.
- Modular source layout (`src/types.ts`, `parsers.ts`, `time.ts`, `fsio.ts`,
  `rotate-file-stream.ts`) with `.js` extension imports so emitted
  declarations resolve under `nodenext` consumers.
- Developer toolchain: Prettier, `npm run verify` gate (typecheck + build + tests).
- GitHub Actions: CI matrix on Node 18/20/22, release-triggered publish with
  npm provenance (`id-token: write`, `--provenance`).
- Expanded README: comparison table, FAQ, restart-resume matrix, pino recipe.

### Fixed

- **Deterministic boot sequencing**: housekeeping (zombie demotion, disk
  reconciliation, interrupted-gzip repair) is chained as job #1 of the
  serial operation queue in the constructor instead of `process.nextTick`,
  so a rapid first `write()` can no longer race a boot-time reopen or skip
  zombie cleanup.
- Retention sweep skips `<audit>.corrupt` artifacts alongside `.tmp`.

### Changed

- Internals restructured behind the same public exports; barrels re-export
  types explicitly (`import type { RotatedInfo } from "logroller"`).
- Stricter package hygiene metadata: `sideEffects: false`, explicit
  `./package.json` export, `files` whitelist (`dist`, docs, license,
  changelog).
- Test suite runs against the built bundle and covers: base writing +
  manifest creation, size rotation/gzip/indexing, restart resume,
  `addHours` naming, virtual midnight crossing, count-retention ordering
  (mtime-deterministic), zombie-record lifecycle (`abandon → active →
closed`), and CJS loadability through the exports map.

## [1.0.0] — 2026-08-26

Initial release. Single-file zero-dependency JavaScript SDK
(`file-rotation-sdk.js`) providing a Writable stream with scheduled file
rotation.

### Added

- Time-based rotation: `frequency: "daily"` (local midnight in any IANA
  timezone via `Intl`) or epoch-aligned intervals (`"30s"`, `"5m"`, `"2h"`).
- Size-based rotation: `maxSize` (`"20m"` / `"512k"` / raw bytes) producing
  numbered segments — `app-D.log`, `app-D.1.log`, … — inserted between the
  date stamp and the extension.
- Optional gzip archiving of sealed segments (`zippedArchive`), atomic tmp+
  rename writes, source deleted only after verified compression success.
- Retention via `maxFiles`: age policy (`"90d"`) or count policy (`500`);
  unset means files are never auto-deleted.
- Crash-safe restart resume from disk scan: raw tails are appended to,
  sealed chains continue at the next free index; lazy period-roll catches
  boundaries missed while suspended or shut down.
- Audit manifest (`<stem>_audit.json`): lifecycle records per file, capped
  uuid-tagged event journal, `gzipPending` intent markers enabling automatic
  repair of gzips interrupted by a crash, zombie active-record demotion,
  disk-divergence healing (`archive-regressed`, `vanished`),
  concurrent-writer detection via pid/bootId heartbeat.
- Virtual test clock: static shift (`addHours`) and per-minute stepping
  (`addHoursEveryMin`).
- Dual-format distribution (ESM + CJS) bundled with Rollup; named exports
  `createStream` and `RotateFileStream`; factory options mirroring common
  rotator APIs; streams pipe-ready for pino multistreams.
