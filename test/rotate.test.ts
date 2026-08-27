/**
 * Runs against the BUILT bundle — `npm test` builds first.
 * Executed via node --experimental-strip-types: erasable TS only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

// value import: real built file
import { createStream as _createStream } from "../dist/index.esm.js";
// type-only import: erased at runtime, editor resolves dist/index.d.ts
import type {
  RotateFileStream,
  RotateFileStreamOptions,
  RotatedInfo,
} from "../dist/index";

const createStream = _createStream as unknown as (
  opts: RotateFileStreamOptions,
) => RotateFileStream;

const require = createRequire(import.meta.url);

/* ---------- helpers ---------- */
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "logroller-"));

const stampOf = (offsetDays = 0, tz = "UTC"): string => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
};

/** end() that actually waits for 'finish' */
const end = (s: RotateFileStream): Promise<void> =>
  new Promise((res) => s.end(res));

const settle = (ms = 150): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/* ---------- tests ---------- */

test("writes to base file and creates audit manifest", async () => {
  const dir = tmp();
  const s = createStream({ filename: `${dir}/app-%DATE%.log`, tz: "UTC" });
  s.write("hello\n");
  s.write("world\n");
  await end(s);

  const today = stampOf(0);
  const txt = fs.readFileSync(path.join(dir, `app-${today}.log`), "utf8");
  assert.match(txt, /hello/);
  assert.match(txt, /world/);

  const audit = JSON.parse(
    fs.readFileSync(path.join(dir, "app_audit.json"), "utf8"),
  ) as { version: number; events: { type: string }[] };
  assert.equal(audit.version, 1);
  assert.ok(audit.events.some((e) => e.type === "boot"));
  assert.ok(audit.events.some((e) => e.type === "open"));
});

test("rotates on size, gzips, increments index", async () => {
  const dir = tmp();
  // 20 lines x 39 B = 780 B. maxSize 600 => exactly ONE rotation
  // (lines 0-14 in base = 585 B, line 15 would exceed), lines 15-19 in .1.log
  const s = createStream({
    filename: `${dir}/app-%DATE%.log`,
    maxSize: 600,
    zippedArchive: true,
    tz: "UTC",
  });
  for (let i = 0; i < 20; i++)
    s.write(`line-${String(i).padStart(2, "0")}-${"x".repeat(30)}\n`);
  await settle();
  await end(s);

  const files = fs.readdirSync(dir).filter((f) => f.startsWith("app-"));
  const gz = files.find((f) => f.endsWith(".log.gz"));
  assert.ok(gz, "has .log.gz archive");
  assert.ok(files.some((f) => /\.1\.log$/.test(f)), "has .1.log");

  const text = zlib
    .gunzipSync(fs.readFileSync(path.join(dir, gz!)))
    .toString();
  assert.match(text, /^line-00/m);
  assert.doesNotMatch(text, /line-19/); // newest lines live in .1.log

  const seg = fs.readFileSync(
    path.join(dir, `app-${stampOf(0)}.1.log`),
    "utf8",
  );
  assert.match(seg, /line-19/);
});

test("restart resumes exactly where it left off", async () => {
  const dir = tmp();
  const today = stampOf(0);
  const opts: RotateFileStreamOptions = {
    filename: `${dir}/app-%DATE%.log`,
    maxSize: 600, // one rotation per session, see byte-math above
    zippedArchive: true,
    tz: "UTC",
  };

  // session 1: force one size rotation
  let s = createStream(opts);
  for (let i = 0; i < 20; i++) s.write(`s1-${i}-${"y".repeat(30)}\n`);
  await settle();
  await end(s);
  assert.ok(fs.existsSync(path.join(dir, `app-${today}.1.log`)));

  // session 2 must reopen .1.log — no index reset
  s = createStream(opts);
  const opened = new Promise<string>((res) => s.once("open", res));
  s.write("session2\n");
  const openedPath = await opened;
  assert.equal(path.basename(openedPath), `app-${today}.1.log`);
  await end(s);

  const tail = fs.readFileSync(path.join(dir, `app-${today}.1.log`), "utf8");
  assert.match(tail, /session2/);
});

test("addHours shifts the file date", async () => {
  const dir = tmp();
  const yday = stampOf(-1);
  const s = createStream({
    filename: `${dir}/app-%DATE%.log`,
    addHours: "-24h",
    tz: "UTC",
  });
  const opened = new Promise<string>((res) => s.once("open", res));
  s.write("x\n");
  const openedPath = await opened;
  assert.equal(path.basename(openedPath), `app-${yday}.log`);
  await end(s);
});

test("virtual day crossing rotates like real midnight", async () => {
  const dir = tmp();
  const s = createStream({
    filename: `${dir}/app-%DATE%.log`,
    zippedArchive: true,
    addHoursEveryMin: "24h",
    clockStepIntervalMs: 3_600_000,
    tz: "UTC",
  });
  s.write("day0\n");

  const rotated = new Promise<RotatedInfo>((res) => s.once("rotated", res));
  await s.advanceClock();
  const info = await rotated;

  assert.equal(info.reason, "time");
  const tomorrow = stampOf(1);
  assert.equal(path.basename(info.newFile), `app-${tomorrow}.log`);

  s.write("day1\n");
  await settle();
  await end(s);

  assert.ok(fs.existsSync(path.join(dir, `app-${stampOf(0)}.log.gz`)));
  const next = fs.readFileSync(path.join(dir, `app-${tomorrow}.log`), "utf8");
  assert.match(next, /day1/);
});

test("maxFiles count retention keeps newest N", async () => {
  const dir = tmp();
  const days = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"];
  for (const d of days) {
    const p = path.join(dir, `app-${d}.log.gz`);
    fs.writeFileSync(p, "x");
    const t = new Date(`${d}T00:00:00Z`);
    fs.utimesSync(p, t, t); // deterministic mtimes — retire sorts by mtime
  }

  const s = createStream({
    filename: `${dir}/app-%DATE%.log`,
    maxFiles: "2",
    tz: "UTC",
  });
  await settle(300);
  await end(s);

  const left = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".log.gz"))
    .sort();
  assert.deepEqual(left, ["app-2020-01-03.log.gz", "app-2020-01-04.log.gz"]);
});

test("zombie active records are demoted on boot", async () => {
  const dir = tmp();
  const today = stampOf(0);
  fs.writeFileSync(path.join(dir, `app-${today}.log`), "old data\n");
  fs.writeFileSync(
    path.join(dir, "app_audit.json"),
    JSON.stringify({
      version: 1,
      prefix: "app-",
      ext: ".log",
      datePattern: "YYYY-MM-DD",
      tz: "UTC",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeStamp: today,
      activeIndex: 0,
      writer: null,
      files: {
        [`app-${today}.log`]: {
          index: 0,
          state: "active",
          gzipPending: false,
          openedAt: new Date().toISOString(),
        },
      },
      events: [],
    }),
  );

  const readAudit = (): {
    files: Record<string, { state: string; closedAt?: string }>;
    events: { type: string }[];
  } =>
    JSON.parse(
      fs.readFileSync(path.join(dir, "app_audit.json"), "utf8"),
    );

  const s = createStream({ filename: `${dir}/app-%DATE%.log`, tz: "UTC" });
  s.write("new data\n");
  await settle();

  // MID-FLIGHT: boot demoted the zombie, then OUR open reactivated the file
  let audit = readAudit();
  assert.ok(audit.events.some((e) => e.type === "abandon"));
  assert.equal(
    audit.files[`app-${today}.log`].state,
    "active",
    "reactivated by our open",
  );

  await end(s);

  // AFTER CLEAN SHUTDOWN: lifecycle completed -> closed (not abandoned)
  audit = readAudit();
  assert.equal(audit.files[`app-${today}.log`].state, "closed");
  assert.ok(audit.files[`app-${today}.log`].closedAt, "has closedAt");
});

test("cjs bundle loads", () => {
  const cjs = require("../dist/index.cjs") as Record<string, unknown>;
  assert.equal(typeof cjs.createStream, "function");
  assert.equal(typeof cjs.RotateFileStream, "function");
});

test("raw tail of a past stamp is sealed at boot", async () => {
  const dir = tmp();
  const yesterday = stampOf(-1);
  fs.writeFileSync(path.join(dir, `app-${yesterday}.log`), "crash tail\n");

  const s = createStream({
    filename: `${dir}/app-%DATE%.log`,
    zippedArchive: true, tz: "UTC",
  });
  await settle(300);
  await end(s);

  assert.ok(fs.existsSync(path.join(dir, `app-${yesterday}.log.gz`)));
  assert.ok(!fs.existsSync(path.join(dir, `app-${yesterday}.log`)));
});

test("orphan raw+gz pair is recompressed and raw removed", async () => {
  const dir = tmp();
  const yday = stampOf(-1);
  fs.writeFileSync(path.join(dir, `app-${yday}.log`), "tail\n");
  fs.writeFileSync(path.join(dir, `app-${yday}.log.gz`), "stale-archive");

  const s = createStream({ filename: `${dir}/app-%DATE%.log`, zippedArchive: true, tz: "UTC" });
  await settle(300);
  await end(s);

  const text = zlib.gunzipSync(fs.readFileSync(path.join(dir, `app-${yday}.log.gz`))).toString();
  assert.match(text, /tail/);                       // .gz was refreshed, not stale
  assert.ok(!fs.existsSync(path.join(dir, `app-${yday}.log`)));
});

/* ==================================================================
 * GROUP A — passes against current SDK (with 2.0.1 fixes applied)
 * ================================================================== */

test("reopened record starts a FRESH lifecycle (no stale abandonedAt)", async () => {
  const dir = tmp();
  const today = stampOf(0);
  // zombie fixture: dead process left an 'active' record
  fs.writeFileSync(path.join(dir, `app-${today}.log`), "old data\n");
  fs.writeFileSync(
    path.join(dir, "app_audit.json"),
    JSON.stringify({
      version: 1, prefix: "app-", ext: ".log", datePattern: "YYYY-MM-DD",
      tz: "UTC", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeStamp: today, activeIndex: 0, writer: null,
      files: {
        [`app-${today}.log`]: {
          index: 0, state: "active", gzipPending: false,
          openedAt: "2020-01-01T00:00:00.000Z",
          abandonedAt: "2020-01-01T00:00:00.000Z",   // stale poison
        },
      },
      events: [],
    }),
  );

  const s = createStream({ filename: `${dir}/app-%DATE%.log`, tz: "UTC" });
  s.write("new\n");
  await settle();

  const audit = JSON.parse(
    fs.readFileSync(path.join(dir, "app_audit.json"), "utf8"),
  ) as { files: Record<string, Record<string, unknown>> };
  const rec = audit.files[`app-${today}.log`];

  // fix #1 contract: reopen = new incarnation; nothing inherited
  assert.ok(!("abandonedAt" in rec), "no abandonedAt on reactivated record");
  assert.ok(!("closedAt" in rec), "no closedAt on active record");
  const openedAt = rec.openedAt as string;
  assert.ok(openedAt > "2025-01-01", "openedAt is fresh, not inherited");
  await end(s);
});

test("interrupted gzip (gzipPending) is completed at boot", async () => {
  const dir = tmp();
  const today = stampOf(0);
  // simulate: crashed AFTER writing intent marker, BEFORE compressing
  fs.writeFileSync(path.join(dir, `app-${today}.log`), "half-written\n");
  fs.writeFileSync(
    path.join(dir, "app_audit.json"),
    JSON.stringify({
      version: 1, prefix: "app-", ext: ".log", datePattern: "YYYY-MM-DD",
      tz: "UTC", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeStamp: today, activeIndex: 0, writer: null,
      files: {
        [`app-${today}.log`]: {
          index: 0, state: "sealed", gzipPending: true,
          bytes: 12, openedAt: new Date().toISOString(),
        },
      },
      events: [],
    }),
  );

  const s = createStream({
    filename: `${dir}/app-%DATE%.log`,
    zippedArchive: true, tz: "UTC",
  });
  await settle(300);
  await end(s);

  assert.ok(fs.existsSync(path.join(dir, `app-${today}.log.gz`)));
  assert.ok(!fs.existsSync(path.join(dir, `app-${today}.log`)));

  const audit = JSON.parse(
    fs.readFileSync(path.join(dir, "app_audit.json"), "utf8"),
  ) as {
    files: Record<string, { state: string }>;
    events: { type: string; repaired?: boolean }[];
  };
  assert.equal(audit.files[`app-${today}.log.gz`].state, "archived");
  assert.ok(audit.events.some((e) => e.type === "archive" && e.repaired));
});

test("archive claimed in manifest but raw on disk → record reverted", async () => {
  const dir = tmp();
  const today = stampOf(0);
  fs.writeFileSync(path.join(dir, `app-${today}.log`), "raw survived\n");
  // manifest lies: says .gz exists
  fs.writeFileSync(
    path.join(dir, "app_audit.json"),
    JSON.stringify({
      version: 1, prefix: "app-", ext: ".log", datePattern: "YYYY-MM-DD",
      tz: "UTC", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeStamp: today, activeIndex: 0, writer: null,
      files: {
        [`app-${today}.log.gz`]: {
          index: 0, state: "archived", gzipPending: false,
          archivedAt: new Date().toISOString(),
        },
      },
      events: [],
    }),
  );

  const warns: Error[] = [];
  const s = createStream({ filename: `${dir}/app-%DATE%.log`, tz: "UTC" });
  s.on("warn", (e) => warns.push(e));
  s.write("after boot\n");
  await settle();
  await end(s);

  const audit = JSON.parse(
    fs.readFileSync(path.join(dir, "app_audit.json"), "utf8"),
  ) as { events: { type: string }[] };
  assert.ok(audit.events.some((e) => e.type === "archive-regressed"));
  assert.ok(warns.some((w) => /archive-regressed|missing/.test(w.message)));
  // raw content survived the heal
  const txt = fs.readFileSync(path.join(dir, `app-${today}.log`), "utf8");
  assert.match(txt, /raw survived/);
  assert.match(txt, /after boot/);
});

test("vanished tracked file is journaled and dropped from manifest", async () => {
  const dir = tmp();
  const today = stampOf(0);
  // manifest references a file that does NOT exist on disk
  fs.writeFileSync(
    path.join(dir, "app_audit.json"),
    JSON.stringify({
      version: 1, prefix: "app-", ext: ".log", datePattern: "YYYY-MM-DD",
      tz: "UTC", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeStamp: today, activeIndex: 1, writer: null,
      files: {
        "app-2020-01-01.3.log.gz": {
          index: 3, state: "archived", gzipPending: false,
        },
      },
      events: [],
    }),
  );

  const s = createStream({ filename: `${dir}/app-%DATE%.log`, tz: "UTC" });
  s.write("x\n");
  await settle();
  await end(s);

  const audit = JSON.parse(
    fs.readFileSync(path.join(dir, "app_audit.json"), "utf8"),
  ) as { files: Record<string, unknown>; events: { type: string }[] };
  assert.ok(audit.events.some((e) => e.type === "vanished"));
  assert.ok(!("app-2020-01-01.3.log.gz" in audit.files));
});

test("live concurrent writer is detected via heartbeat", async () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, "app_audit.json"),
    JSON.stringify({
      version: 1, prefix: "app-", ext: ".log", datePattern: "YYYY-MM-DD",
      tz: "UTC", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeStamp: stampOf(0), activeIndex: 0,
      // fresh heartbeat from a DIFFERENT boot → still alive
      writer: { pid: 99999, bootId: "other-boot", heartbeat: Date.now() },
      files: {}, events: [],
    }),
  );

  const s = createStream({ filename: `${dir}/app-%DATE%.log`, tz: "UTC" });
  s.write("x\n");
  await settle();
  await end(s);

  // note: the constructor-time warn has no listener yet — the JOURNAL
  // is the durable, assertable record of the detection
  const audit = JSON.parse(
    fs.readFileSync(path.join(dir, "app_audit.json"), "utf8"),
  ) as { events: { type: string; otherPid: number }[] };
  assert.ok(audit.events.some((e) => e.type === "concurrent-writer"));
});

test("corrupt manifest is quarantined; logging continues", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "app_audit.json"), "{not json{{{");

  const s = createStream({ filename: `${dir}/app-%DATE%.log`, tz: "UTC" });
  s.write("still works\n");
  await settle();
  await end(s);

  assert.ok(fs.existsSync(path.join(dir, "app_audit.json.corrupt")));
  const txt = fs.readFileSync(
    path.join(dir, `app-${stampOf(0)}.log`), "utf8",
  );
  assert.match(txt, /still works/);
  // a healthy manifest was rebuilt
  const audit = JSON.parse(
    fs.readFileSync(path.join(dir, "app_audit.json"), "utf8"),
  ) as { version: number };
  assert.equal(audit.version, 1);
});

test("maxFiles age retention ('90d') deletes only old files", async () => {
  const dir = tmp();
  const old = path.join(dir, "app-2020-01-01.log.gz");
  const recent = path.join(dir, `app-${stampOf(0)}.log.gz`);
  fs.writeFileSync(old, "old");
  fs.writeFileSync(recent, "new");
  fs.utimesSync(old, new Date("2020-01-01"), new Date("2020-01-01"));

  const s = createStream({
    filename: `${dir}/app-%DATE%.log`,
    maxFiles: "90d", tz: "UTC",
  });
  await settle(300);
  await end(s);

  assert.ok(!fs.existsSync(old), "ancient file deleted");
  assert.ok(fs.existsSync(recent), "recent file kept");
});

test("idle boundary crossing emits 'period' and creates NO empty file", async () => {
  const dir = tmp();
  const s = createStream({
    filename: `${dir}/app-%DATE%.log`,
    addHoursEveryMin: "24h",      // stepping armed
    tz: "UTC",
  });
  // NO writes at all
  const period = new Promise<string>((res) => s.once("period", res));
  await s.advanceClock();         // +24h with nothing on disk
  const stamp = await period;

  assert.equal(stamp, stampOf(1));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".log"));
  assert.equal(files.length, 0, "no empty log files for idle days");
  await end(s);
});

test("tz-correct midnight: IST day breaks at 18:30 UTC", async () => {
  const dir = tmp();
  const IST_OFFSET_MS = 5.5 * 3_600_000;         // constant, no DST

  // aim the internal clock at 23:30 IST today
  const now = Date.now();
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const nextIstMidnight =
    Date.UTC(get("year"), get("month") - 1, get("day") + 1) - IST_OFFSET_MS;
  const target = nextIstMidnight - 30 * 60_000;  // 30 min before IST midnight
  const addHours = (target - now) / 3_600_000;   // fractional, may be negative

  const s = createStream({
    filename: `${dir}/app-%DATE%.log`,
    zippedArchive: true,
    tz: "Asia/Kolkata",
    addHours,
    addHoursEveryMin: "1h",       // one tick crosses midnight
  });
  s.write("before ist midnight\n");

  const rotated = new Promise<RotatedInfo>((res) => s.once("rotated", res));
  await s.advanceClock();          // +1h → 00:30 IST → new IST day
  const info = await rotated;

  assert.equal(info.reason, "time");
  const istTomorrow = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(Date.now() + (target - now) + 3_600_000));
  assert.equal(path.basename(info.newFile), `app-${istTomorrow}.log`);
  await end(s);
});

test("rotateNow() forces a manual rotation", async () => {
  const dir = tmp();
  const s = createStream({
    filename: `${dir}/app-%DATE%.log`,
    zippedArchive: true, tz: "UTC",
  });
  s.write("first\n");

  const rotated = new Promise<RotatedInfo>((res) => s.once("rotated", res));
  await s.rotateNow();
  const info = await rotated;

  assert.equal(info.reason, "manual");
  assert.ok(info.archive, "gzipped on manual rotate");
  s.write("second\n");
  await settle();
  await end(s);

  assert.ok(fs.existsSync(path.join(dir, `app-${stampOf(0)}.1.log`)));
  const seg = fs.readFileSync(
    path.join(dir, `app-${stampOf(0)}.1.log`), "utf8",
  );
  assert.match(seg, /second/);
});

test("resumed file already over maxSize rolls on FIRST write", async () => {
  const dir = tmp();
  const today = stampOf(0);
  // crash left a 1000-byte tail; maxSize is 600
  fs.writeFileSync(path.join(dir, `app-${today}.log`), "z".repeat(1000));

  const s = createStream({
    filename: `${dir}/app-%DATE%.log`,
    maxSize: 600, zippedArchive: true, tz: "UTC",
  });
  const rotated = new Promise<RotatedInfo>((res) => s.once("rotated", res));
  s.write("pushes it over\n");
  const info = await rotated;

  assert.equal(info.reason, "size");
  await settle();
  await end(s);

  const seg = fs.readFileSync(
    path.join(dir, `app-${today}.1.log`), "utf8",
  );
  assert.match(seg, /pushes it over/);
  const text = zlib.gunzipSync(
    fs.readFileSync(path.join(dir, `app-${today}.log.gz`)),
  ).toString();
  assert.match(text, /^z{1000}$/);
});

/* ==================================================================
 * GROUP B — requires the 2.0.2 patches; red until applied (by design)
 * ================================================================== */
test("backward clock: keeps current segment, warns, never reopens past",
  async () => {
    const dir = tmp();
    const s = createStream({
      filename: `${dir}/app-%DATE%.log`,
      addHoursEveryMin: "24h",
      tz: "UTC",
    });
    try {
      s.write("today\n");
      await settle();

      const readAudit = () =>
        JSON.parse(
          fs.readFileSync(path.join(dir, "app_audit.json"), "utf8"),
        ) as { events: { type: string }[] };

      const before = readAudit().events.length; // snapshot: initial boot/open excluded

      // white-box: yank the internal clock 48h into the past, then step +24h
      // → stamp lands on YESTERDAY while _curStamp is TODAY
      (s as unknown as { _offsetMs: number })._offsetMs -= 48 * 3_600_000;

      const warns: Error[] = [];
      s.on("warn", (e) => warns.push(e));
      await s.advanceClock();

      const newEvents = readAudit().events.slice(before);
      assert.ok(newEvents.some((e) => e.type === "clock-step"), "step journaled");
      assert.ok(
        !newEvents.some((e) => e.type === "rotate" || e.type === "open"),
        "no rotation/reopen into the past",
      );
      assert.ok(warns.some((w) => /backward/.test(w.message)));
    } finally {
      s.destroy();                                  // stop timers even on assert throw
      await new Promise((r) => s.once("close", r)); // loop can drain → no hang
    }
  });

test("coarse datePattern with fine frequency warns at construction", () => {
  const dir = tmp();
  const s = createStream({
    filename: `${dir}/app-%DATE%.log`,   // no HH token
    frequency: "1h",
    tz: "UTC",
  });
  const warns: Error[] = [];
  s.on("warn", (e) => warns.push(e));

  // warn is emitted on nextTick — give the loop a beat
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.ok(
        warns.some((w) => /HH/.test(w.message)),
        "warns about missing HH token",
      );
      s.end();
      resolve();
    }, 50);
  });
});