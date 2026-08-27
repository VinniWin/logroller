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

// ◀ FIX: double cast through unknown silences TS2854
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