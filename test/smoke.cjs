// Runtime smoke test for old Node versions (16/18/20): plain CJS, no TS, runs the BUILT bundle.
// The full suite needs Node 22.6+ (--experimental-strip-types); this proves `engines` is honest.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { createStream, flushAll, installShutdown } = require("../dist/index.cjs");
const pino = require("../dist/pino.cjs").default;

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logroller-smoke-"));
    const log = createStream({ filename: `${dir}/app-%DATE%.log`, maxSize: 100, zippedArchive: true, tz: "UTC" });
    installShutdown(log);
    for (let i = 0; i < 50; i++) log.write(`line ${i}\n`);
    assert.equal(await flushAll(5000), true);

    const segs = log.listSegments();
    assert.ok(segs.length > 1, "rotated by size");
    const text = segs
        .map((s) => (s.gzipped ? zlib.gunzipSync(fs.readFileSync(s.file)) : fs.readFileSync(s.file)).toString())
        .join("");
    assert.equal(text.split("\n").length - 1, 50, "every line on disk, in order");

    const p = pino({ filename: `${dir}/p-%DATE%.log`, tz: "UTC", audit: false });
    await new Promise((r) => p.end("ok\n", r));

    console.log(`smoke ok on Node ${process.version}`);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
