<p align="center"><strong>logroller</strong></p>
<h3 align="center">Zero-dependency rotating file streams for Node.js</h3>

<div align="center">

![npm](https://img.shields.io/npm/v/logroller)
![node](https://img.shields.io/node/v/logroller)
![license](https://img.shields.io/npm/l/logroller)
![types](https://shields.io/badge/types-included-blue)

</div>

---

`logroller` turns a plain append destination into a resilient, observable log
sink: **it is a Writable**, so `readable.pipe(log)` works, pino multistreams
work, anything that consumes streams works.

```bash
npm install logroller
```

## Features

- **Daily & interval rotation** — exact local midnight in any IANA zone,
  or epoch-aligned intervals (`30s`, `5m`, `2h`)
- **Size caps** — `"20m"`-style limits roll numbered segments
- **Gzip archives** — sealed segments compressed atomically, level 0–9
- **Stable "current" path** — a symlink log collectors can follow
  (`tail -F app-current.log`, Filebeat, promtail) while files rotate beneath
- **Retention three ways** — by age, by count, **or by total byte budget**
  ("never exceed 5 GB of archives")
- **Upload pipeline** — an awaited `onSeal` hook that fires after a segment
  is archived and _before_ retention can delete it: ship to S3/GCS safely
- **Graceful shutdown** — one helper flushes buffered writes on
  SIGINT/SIGTERM (no more missing last lines)
- **Timezone-correct** — `Asia/Kolkata` means IST filenames, on a UTC box
- **Crash-safe** — restarts resume mid-series byte-exactly; gzips
  interrupted by a kill are completed on boot
- **Observability** — `<stem>_audit.json` manifest with a uuid-tagged event
  journal, plus `stats()` / `listSegments()` introspection
- **Testable time** — virtual clocks (`addHours`, `addHoursEveryMin`,
  `advanceClock()`) let a day pass per minute, or instantly
- **Types first** — tuple-typed events, strict mode, dual ESM/CJS build
- **Zero dependencies**

## Quick start

### ESM

```ts
import { createStream } from "logroller";

const log = createStream({
  filename: "logs/app-%DATE%.log",
  datePattern: "YYYY-MM-DD",
  zippedArchive: true,
  maxSize: "20m",
  maxFiles: "90d",
  tz: "UTC",
  frequency: "daily",
});

log.write("hello\n");
log.on("rotated", ({ reason, archive, newFile }) =>
  console.log(`${reason}: ${archive ?? "-"} → ${newFile}`),
);
process.on("exit", () => log.end());
```

### Production shape — collectors, budget, uploads, shutdown

```ts
import { createStream, installShutdown } from "logroller";

const log = createStream({
  filename: "logs/app-%DATE%.log",
  zippedArchive: true,
  maxSize: "20m",
  maxTotalSize: "5g", // never hold more than 5 GB of archives
  maxFiles: "90d",
  symlink: true, // logs/app-current.log always points at the live file
  onSeal: async ({ gz }) => uploadToS3(gz), // awaited BEFORE retention deletes
});

// SIGINT/SIGTERM → flush buffered writes, then exit
installShutdown(log);
```

### CommonJS

```js
const { createStream } = require("logroller");
```

### pino destination

```js
const logger = pino(
  pino.multistream([
    { level: "info", stream: createStream({ filename: "logs/general-%DATE%.log" }) },
    { level: "error", stream: createStream({ filename: "logs/error-%DATE%.log" }) },
  ]),
);
```

## What lands on disk

Example snapshot for `filename: "logs/app-%DATE%.log"` on **Aug 28**, with
`zippedArchive: true` and `symlink: true`:

```
app-current.log             ← symlink → app-2026-08-28.log   (only with symlink: true)
app-2026-08-27.log.gz       ← yesterday, sealed (hit 20 MB)
app-2026-08-27.1.log.gz     ← yesterday, sealed too
app-2026-08-28.log          ← ACTIVE — the only raw file on disk
app_audit.json              ← library-owned manifest
```

Three invariants that hold at every moment:

1. **Exactly one raw file** — the active segment. Everything else is a
   `.gz` archive (or a raw tail kept only because gzip failed — with a
   `warn` event, never silently).
2. **A segment's `.log` and `.log.gz` never coexist.** The raw file is
   deleted only _after_ its archive is verified.
3. **`app-current.log` always points at the active segment**, flipped
   atomically on every open. It exists only when `symlink` is enabled, and
   retention never touches it.

### How a day evolves (all states, in order)

| Moment (tz)               | Directory contains                        | `app-current.log` →                                              |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| morning, first write      | `…27.log`                                 | `…27.log`                                                        |
| hit 20 MB → roll          | `…27.log.gz` + `…27.1.log`                | `…27.1.log`                                                      |
| `.1` fills → roll         | `…27.log.gz` + `…27.1.log.gz`             | _(stale until next write — segments open lazily on first write)_ |
| midnight → Aug 28 + write | `…27.log.gz` + `…27.1.log.gz` + `…28.log` | `…28.log`                                                        |

A killed process resumes without gaps or duplicates:

| Disk at crash                   | Restart continues into                |
| ------------------------------- | ------------------------------------- |
| `app-D.log`                     | `app-D.log` (append)                  |
| `app-D.log.gz` + `app-D.1.log`  | `app-D.1.log`                         |
| `app-D.1.log.gz` (chain sealed) | `app-D.2.log`                         |
| died during a gzip              | boot finishes the gzip, then proceeds |
| crash left yesterday's tail raw | boot seals (gzips) it automatically   |

## Log collectors & the stable current path

Rotating filenames are great for humans, hostile to consumers: `tail -f`,
Filebeat, Fluent Bit and promtail want **one path that never changes**.

```ts
const log = createStream({
  filename: "logs/app-%DATE%.log",
  symlink: true, // → logs/app-current.log
  // symlink: "CURRENT",         // → logs/CURRENT (custom name)
});
```

```bash
tail -F logs/app-current.log     # survives every rotation (capital -F: re-resolve the link)
```

- The pointer is flipped **atomically** (tmp + rename) on every segment open,
  so followers never observe a gap or a half-written name.
- The target is stored **relative**, so the directory stays portable.
- Best-effort by design: on filesystems that deny symlinks (Windows without
  Developer Mode) the stream warns once and continues without it.
- The pointer is never touched by retention and never reported as a segment.

## Upload pipeline — archive, ship, _then_ delete

`onSeal` runs inside the rotation queue **after** the segment is compressed
and **before** retention can remove it — the safe window for shipping:

```ts
const log = createStream({
  filename: "logs/cdr-%DATE%.log",
  zippedArchive: true,
  maxFiles: "7d", // local copies are disposable
  onSeal: async ({ raw, gz }) => {
    await uploadToS3(gz ?? raw); // awaited — rotation waits
  },
  sealHookTimeoutMs: 60_000, // a wedged upload warns instead of stalling
});
```

Guarantees:

- invoked exactly once per sealed segment, with `{ raw, gz }` (`gz: null`
  when compression is off or gzip failed)
- **ordering**: hook → then retention sweep, so an in-flight upload can never
  race a deletion
- a throwing or timed-out hook degrades to a `warn` event — logging and
  rotation continue

## Graceful shutdown

The classic support case: SIGTERM arrives, buffered lines are lost. One call
ends it:

```ts
import { createStream, installShutdown } from "logroller";

const log = createStream({ filename: "logs/app-%DATE%.log" });
installShutdown(log); // SIGINT + SIGTERM → end() → exit 0
```

- `installShutdown(stream | streams, { signals?, timeoutMs?, code? })` —
  installs process listeners once; streams accumulate in a registry.
- On signal: every registered stream is ended (buffered writes flushed,
  audit manifest finalized), with a hard `timeoutMs` deadline (default 5 s).
- `flushAll()` is the same graceful end **without exiting** — for tests and
  custom signal handling.

## Introspection

```ts
const st = log.stats();
// { dir, currentStamp, activeFile, activeIndex, segments, archived,
//   totalBytes, clockOffsetMs, symlink }

for (const seg of log.listSegments()) {
  // { file, stamp, index, gzipped, bytes, state, openedAt?, archivedAt? }
  console.log(seg.stamp, seg.index, seg.gzipped ? "gz" : "raw", seg.bytes);
}
```

`listSegments()` reads the **directory** (disk is truth), so it also reports
files the manifest doesn't know (state `"untracked"`). Perfect for
`/healthz` endpoints, dashboards, and "where did my logs go" support.

## Retention — three policies, composable

```ts
maxFiles: "90d"      // age: delete archives older than 90 days
maxFiles: 500        // count: keep the newest 500 archives
maxTotalSize: "5g"   // budget: delete OLDEST archives until under 5 GB
maxFiles: "30d",
maxTotalSize: "2g",  // combined: either policy may delete
```

Unset means files live forever until you delete them. The active segment is
never a retention candidate, and the audit/symlink files are always reserved.

## API

### `createStream(options)` → `RotateFileStream`

### Options

| Option                | Values                                | Default            |
| --------------------- | ------------------------------------- | ------------------ |
| `filename`            | **required**, must contain `%DATE%`   | —                  |
| `datePattern`         | `YYYY YY MM DD HH mm ss`              | `YYYY-MM-DD`       |
| `zippedArchive`       | boolean                               | `false`            |
| `compressionLevel`    | gzip level `0`–`9` (0 = stored)       | `6`                |
| `maxSize`             | `20m`, `512k`, `2g`, bytes, `0`=off   | off                |
| `maxFiles`            | `"90d"` age, `500` count, unset=never | —                  |
| `maxTotalSize`        | `"5g"`, `"500m"`, bytes, `0`=off      | off                |
| `symlink`             | `true` (auto name) or custom string   | off                |
| `onSeal`              | `async ({ raw, gz }) => void`         | —                  |
| `sealHookTimeoutMs`   | hard deadline for one `onSeal` call   | `30000`            |
| `frequency`           | `daily`, `30s`, `5m`, `2h`, ms        | `daily`            |
| `tz`                  | any IANA zone                         | `UTC`              |
| `audit` / `auditFile` | manifest control                      | `true` / auto-name |
| `unrefTimers`         | detach from event loop                | `false`            |
| `addHours`            | ⚠️ static clock shift, test only      | off                |
| `addHoursEveryMin`    | ⚠️ virtual time per tick, test only   | off                |
| `clockStepIntervalMs` | tick interval                         | `60000`            |

### Methods

| Method                  | Returns          | Purpose                         |
| ----------------------- | ---------------- | ------------------------------- |
| `write / end / destroy` | stream semantics | normal `Writable`               |
| `rotateNow()`           | `Promise<void>`  | force a rotation                |
| `advanceClock()`        | `Promise<void>`  | apply one virtual tick now      |
| `stats()`               | `StreamStats`    | health snapshot                 |
| `listSegments()`        | `SegmentInfo[]`  | every family file, oldest first |

### Module functions

| Function                          | Purpose                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `installShutdown(streams, opts?)` | register streams for SIGINT/SIGTERM flush; returns `flush()` |
| `flushAll(timeoutMs?)`            | gracefully end all registered streams, no exit               |

### Events (typed)

| Event     | Payload                               | Meaning                                                      |
| --------- | ------------------------------------- | ------------------------------------------------------------ |
| `open`    | `file`                                | segment opened for appending                                 |
| `rotated` | `{reason, oldFile, archive, newFile}` | segment closed                                               |
| `archive` | `gzFile`                              | gzip finished                                                |
| `deleted` | `file`                                | retention removed it                                         |
| `period`  | `stamp`                               | boundary crossed while idle                                  |
| `clock`   | `{offsetMs, …}`                       | virtual clock engaged                                        |
| `warn`    | `Error`                               | non-fatal (hook failure, gzip retry, symlink unavailable, …) |
| `error`   | `Error`                               | fatal write problems                                         |

Errors must be handled — attach a listener on every instance.

## Testing rotation without waiting a week

```ts
const s = createStream({
  filename: "logs/demo-%DATE%.log",
  zippedArchive: true,
  addHours: "-48h", // start two days back
  addHoursEveryMin: "24h", // one virtual day per real minute
  clockStepIntervalMs: 1000, // or faster
});
await s.advanceClock(); // jump instantly when useful
```

Negative `addHoursEveryMin` deliberately triggers the backward-clock guard
(warn, no rotation) — it exists so you can test that safety net too.

## FAQ

**Why is `%DATE%` mandatory?**
It is the anchor that decouples _rotation scheduling_ from _filenames_.
Coarser patterns than your frequency collapse distinct segments onto one
name — match tokens to cadence (`HH` for hourly, etc.). The library warns at
construction when it detects a mismatch.

**How do I ship logs to S3 without losing any?**
`zippedArchive: true` + `onSeal` (see the upload pipeline section). The hook
is awaited and runs before retention, so an in-flight upload can never race
a deletion.

**How do I keep `tail -f` working across rotations?**
`symlink: true` — follow `app-current.log`. Use `tail -F` (capital) so the
follower re-resolves the link after it flips.

**Can two processes share one directory?**
Different prefixes/families: yes. The _same_ family: no — the audit manifest
detects a live second writer (`writer.heartbeat`) and warns loudly.

**Is the audit JSON required?**
No — `audit: false` reduces behaviour to pure disk-scan recovery. Recommended
to leave on: it repairs interrupted gzips, demotes zombie records, and
powers `listSegments()` states.

**What if the system clock jumps backward?**
The stream keeps the current segment, warns once, and resumes normal
rotation when the clock catches up — the series is never forked into a past
family. (Requires zero-padded `datePattern` tokens, which all presets are.)

**Windows / macOS / Linux?**
Pure Node APIs; path handling via `node:path`. All three supported
(Node `>=16.14`). Symlinks are best-effort on Windows — see above.

## Compare

|                                   | logroller         | file-stream-rotator | rotating-file-stream | winston-daily-rotate-file |
| --------------------------------- | ----------------- | ------------------- | -------------------- | ------------------------- |
| Dependencies                      | **0**             | 4+                  | 2+                   | winston-bound             |
| Crash-safe resume                 | ✅ audit-assisted | partial             | partial              | ✖                         |
| Interrupted-gzip repair           | ✅                | ✖                   | ✖                    | ✖                         |
| Event journal                     | ✅                | partial             | ✖                    | ✖                         |
| TZ-correct daily rollover         | ✅                | partial             | ✅                   | ✅                        |
| Stable current path               | ✅ atomic         | ✅                  | ✅                   | ✅                        |
| Byte-budget retention             | ✅                | ✅ (bytes only)     | ✖                    | ✖                         |
| Awaited upload-before-delete hook | ✅                | ✖                   | ✖                    | ✖                         |
| Graceful shutdown helper          | ✅                | ✖                   | ✖                    | via winston               |
| Introspection API                 | ✅                | ✖                   | ✖                    | partial                   |
| Virtual test clock                | ✅                | ✖                   | ✖                    | ✖                         |
| Winston required                  | no                | no                  | no                   | yes                       |

## Contributing

PRs welcome. `npm run verify` gates every change (lint + typecheck + tests).
Please file issues before large refactors.

## License

[MIT](./LICENSE)
