# logroller

Zero-dependency rotating file stream for Node.js. Daily or interval rotation,
size limits, gzip archives, retention policies, timezone-aware naming and a
crash-safe resume — in one small Writable stream you can `pipe()` into or hand
to pino.

```bash
npm install logroller
```

## Quick start

### ESM

```js
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
log.on("rotated", (r) => console.log("rotated:", r));
```

### CommonJS

```js
const { createStream } = require("logroller");
```

### Pipe anything into it

```js
source.pipe(createStream({ filename: "logs/data-%DATE%.log" }));
```

### With pino

```js
import pino from "pino";
import { createStream } from "logroller";

const stream = createStream({
  filename: "logs/general-%DATE%.log",
  zippedArchive: true,
  maxSize: "20m",
  maxFiles: "90d",
  tz: "Asia/Kolkata",
});

const logger = pino(pino.multistream([
  { level: "info", stream: pino.transport({ target: "./pretty.js" }) },
  { level: "info", stream },
]));
```

## Options

| Option | Values | Default |
|---|---|---|
| `filename` | must contain `%DATE%` | required |
| `datePattern` | `YYYY YY MM DD HH mm ss` | `YYYY-MM-DD` |
| `zippedArchive` | boolean | `false` |
| `maxSize` | `20m`, `1k`, `5g`, number of bytes, `0` = off | off |
| `maxFiles` | `"90d"` (age), `500` (count), unset = never delete | off |
| `frequency` | `"daily"`, `"1s"`, `"5m"`, `"2h"`, ms number | `"daily"` |
| `tz` | any IANA zone (`Intl`-based) | `"UTC"` |
| `audit` | write `<stem>_audit.json` manifest | `true` |
| `auditFile` | custom manifest name | `<stem>_audit.json` |
| `unrefTimers` | don't hold the process open | `false` |
| `addHours` | static clock shift (`"-6h"`) — **test only** | off |
| `addHoursEveryMin` | hours added per step (`"24h"`) — **test only** | off |
| `clockStepIntervalMs` | step interval for `addHoursEveryMin` | `60000` |

## File naming

```
app-2026-08-27.log          ← active
app-2026-08-27.log.gz       ← hit maxSize → gzipped
app-2026-08-27.1.log        ← next segment, writing…
app-2026-08-27.1.log.gz     ← that one sealed too
app-2026-08-28.log          ← new day (in tz), fresh series
```

## Restart behaviour

| Disk at crash | Resumes into |
|---|---|
| `app-D.log` | `app-D.log` (append) |
| `app-D.log.gz` + `app-D.1.log` | `app-D.1.log` (append) |
| `app-D.1.log.gz` only | `app-D.2.log` |
| crossed midnight while down | new day base file on first write |
| killed mid-gzip | boot finishes the interrupted gzip |

## Events

| Event | Payload |
|---|---|
| `open` | `(file: string)` |
| `rotated` | `({ reason, oldFile, archive, newFile })` |
| `archive` | `(gzFile: string)` |
| `deleted` | `(file: string)` — retention |
| `period` | `(stamp: string)` — new period, nothing to archive |
| `clock` | `({ addHours, addHoursEveryMin, offsetMs })` — test clock active |
| `warn` | `(err: Error)` — non-fatal (gzip failure, concurrent writer, …) |

Always attach an `error` handler — this is a real Writable stream.

## Audit manifest

Each stream family keeps a `*_audit.json` beside the logs (library-owned —
treat it as read-only). It records every file's lifecycle with a capped,
uuid-tagged event journal, restores the series index across restarts, repairs
gzip interrupted by a crash, and demotes records left behind by dead
processes. Writes are atomic (tmp + rename); a corrupt/foreign file is
quarantined as `*.corrupt` and logging continues via disk scan.

## Testing rotation without waiting

```js
const s = createStream({
  filename: "logs/test-%DATE%.log",
  zippedArchive: true,
  addHoursEveryMin: "24h",   // a day passes every minute
  clockStepIntervalMs: 1000, // optional: step every second instead
  tz: "UTC",
});
await s.advanceClock();      // or trigger one step manually
```

## Retention

- `maxFiles: "90d"` — delete family files older than 90 days (mtime)
- `maxFiles: 500` — keep newest 500 archives
- unset — never auto-delete; remove manually

## License

MIT
