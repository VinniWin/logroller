
## README.md

<p align="center"><strong>logroller</strong></p>
<h3 align="center">Zero-dependency rotating file streams for Node.js</h3>

<div align="center">

![npm](https://img.shields.io/npm/v/logroller)
![node](https://img.shields.io/node/v/logroller)
![license](https://img.shields.io/npm/l/logroller)
![types](https://shields.io/badge/types-included-blue)

</div>

---

`logroller` turns a plain append destination into a resilient, observable
log sink: **it is a Writable**, so `readable.pipe(log)` works, pino multistreams
work, anything that consumes streams works.

```bash
npm install logroller
```

## Features

- **Daily & interval rotation** — exact local midnight in any IANA zone,
  or epoch-aligned intervals (`30s`, `5m`, `2h`)
- **Size caps** — `"20m"`-style limits roll numbered segments
- **Gzip archives** — sealed segments compressed atomically
- **Retention** — by age or count; unset means files live forever
- **Timezone-correct** — `Asia/Kolkata` means IST filenames, on a UTC box
- **Crash-safe** — restarts resume mid-series byte-exactly;
  gzips interrupted by a kill are completed on boot
- **Observability** — `<stem>_audit.json` manifest with a uuid-tagged
  event journal for every file's lifecycle
- **Testable time** — virtual clocks (`addHours`, `addHoursEveryMin`,
  `advanceClock()`) let a day pass per minute, or instantly
- **Types first** — tuple-typed events, strict mode, dual ESM/CJS build

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

### CommonJS

```js
const { createStream } = require("logroller");
```

### pino destination

```js
const logger = pino(pino.multistream([
  { level: "info", stream: createStream({ filename: "logs/general-%DATE%.log" }) },
  { level: "error", stream: createStream({ filename: "logs/error-%DATE%.log" }) },
]));
```
## What lands on disk

```
app-2026-08-27.log          ← active
app-2026-08-27.log.gz       ← sealed (hit 20 MB)
app-2026-08-27.1.log        ← next segment mid-day
app-2026-08-27.1.log.gz     ← sealed too
app-2026-08-28.log          ← fresh day (in your tz), clean series
app_audit.json              ← library-owned manifest
```

A killed process resumes without gaps or duplicates:

| Disk at crash | Restart continues into |
|---|---|
| `app-D.log` | `app-D.log` (append) |
| `app-D.log.gz` + `app-D.1.log` | `app-D.1.log` |
| `app-D.1.log.gz` (chain sealed) | `app-D.2.log` |
| died during a gzip | boot finishes the gzip, then proceeds |

## API

### `createStream(options)` → `RotateFileStream`

### Options

| Option | Values | Default |
|---|---|---|
| `filename` | **required**, must contain `%DATE%` | — |
| `datePattern` | `YYYY YY MM DD HH mm ss` | `YYYY-MM-DD` |
| `zippedArchive` | boolean | `false` |
| `maxSize` | `20m`, `512k`, `2g`, bytes, `0`=off | off |
| `maxFiles` | `"90d"` age, `500` count, unset=never | — |
| `frequency` | `daily`, `30s`, `5m`, `2h`, ms | `daily` |
| `tz` | any IANA zone | `UTC` |
| `audit` / `auditFile` | manifest control | `true` / auto-name |
| `unrefTimers` | detach from event loop | `false` |
| `addHours` | ⚠️ static clock shift, test only | off |
| `addHoursEveryMin` | ⚠️ virtual time per tick, test only | off |
| `clockStepIntervalMs` | tick interval | `60000` |

### Methods

| Method | Returns | Purpose |
|---|---|---|
| `write / end / destroy` | stream semantics | normal `Writable` |
| `rotateNow()` | `Promise<void>` | force a rotation |
| `advanceClock()` | `Promise<void>` | apply one virtual tick now |

### Events (typed)

| Event | Payload | Meaning |
|---|---|---|
| `open` | `file` | segment opened for appending |
| `rotated` | `{reason, oldFile, archive, newFile}` | segment closed |
| `archive` | `gzFile` | gzip finished |
| `deleted` | `file` | retention removed it |
| `period` | `stamp` | boundary crossed while idle |
| `clock` | `{offsetMs, …}` | virtual clock engaged |
| `warn` | `Error` | non-fatal problems |
| `error` | `Error` | fatal write problems |

Errors must be handled — attach a listener on every instance.

## Testing rotation without waiting a week

```ts
const s = createStream({
  filename: "logs/demo-%DATE%.log",
  zippedArchive: true,
  addHoursEveryMin: "24h",     // one day per real minute
  clockStepIntervalMs: 1000,   // or faster
});
await s.advanceClock();         // jump instantly when useful
```

## FAQ

**Why is `%DATE%` mandatory?**
It is the anchor that decouples *rotation scheduling* from *filenames*.
Coarser patterns than your frequency collapse distinct segments onto one
name — match tokens to cadence (`HH` for hourly, etc.).

**Can two processes share one directory?**
Different prefixes/families: yes. The *same* family: no — the audit
manifest detects a live second writer (`writer.heartbeat`) and warns loudly.

**Is the audit JSON required?**
No — `audit: false` reduces behaviour to pure disk-scan recovery. Recommended
to leave on: it repairs interrupted gzips and demotes zombies automatically.

**Windows / macOS / Linux?**
Pure Node APIs; path handling via `node:path`. All three supported
(Node `>=16.14`).

## Compare

| | logroller | file-stream-rotator | rotating-file-stream | winston-daily-rotate-file |
|---|---|---|---|---|
| Dependencies | **0** | 4+ | 2+ | winston-bound |
| Crash-safe resume | ✅ audit-assisted | partial | partial | ✖ |
| Interrupted-gzip repair | ✅ | ✖ | ✖ | ✖ |
| Event journal | ✅ | ✖ | ✖ | ✖ |
| TZ-correct daily rollover | ✅ | partial | ✅ | ✅ |
| Virtual test clock | ✅ | ✖ | ✖ | ✖ |
| Winston required | no | no | no | yes |

## Contributing

PRs welcome. `npm run verify` gates every change (lint + typecheck + tests).
Please file issues before large refactors.

## License

[MIT](./LICENSE)
