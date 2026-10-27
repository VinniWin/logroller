/**
 * Regression tests for the 3.0 audit fixes: naming, error path, batching,
 * retention, maxFiles parsing, shutdown, destroy, asyncDispose, pino entry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStream as _createStream, flushAll, installShutdown } from "../dist/index.esm.js";
import pinoTransport from "../dist/pino.esm.js";
import type { RotateFileStream, RotateFileStreamOptions } from "../dist/index";

const createStream = _createStream as unknown as (
    opts: RotateFileStreamOptions,
) => RotateFileStream;

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "logroller-fix-"));
const end = (s: RotateFileStream): Promise<void> => new Promise((res) => s.end(res));
const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));
const stamp = (pattern: "-" | "."): string => {
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    return [d.getUTCFullYear(), p2(d.getUTCMonth() + 1), p2(d.getUTCDate())].join(pattern);
};

test("size rotation keeps segments in a dotted directory with no extension", async () => {
    const dir = path.join(tmp(), "logs.d");
    const s = createStream({ filename: `${dir}/app-%DATE%`, maxSize: 10, tz: "UTC", audit: false });
    let errors = 0;
    s.on("error", () => errors++);
    for (const l of ["0123456789", "abcdefghij", "ABCDEFGHIJ"]) s.write(l);
    await end(s);

    assert.equal(errors, 0);
    const S = stamp("-");
    assert.deepEqual(fs.readdirSync(dir).sort(), [`app-${S}`, `app-${S}.1`, `app-${S}.2`]);
    assert.ok(!fs.existsSync(path.join(path.dirname(dir), "logs.1.d")));
});

test("dotted datePattern: index is not confused with stamp parts", async () => {
    const dir = tmp();
    const s = createStream({
        filename: `${dir}/app-%DATE%`, datePattern: "YYYY.MM.DD",
        maxSize: 10, tz: "UTC", audit: false,
    });
    s.write("0123456789");
    s.write("abcdefghij");
    await end(s);

    const S = stamp(".");
    const segs = s.listSegments().map((x) => [x.stamp, x.index]);
    assert.deepEqual(segs, [[S, 0], [S, 1]]);
});

test("a failed open emits exactly one 'error' and fails the write callback", async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, `app-${stamp("-")}.log`)); // segment path is a directory → EISDIR
    const s = createStream({ filename: `${dir}/app-%DATE%.log`, tz: "UTC", audit: false });
    let errors = 0;
    s.on("error", () => errors++);
    const cbErr = await new Promise<Error | null | undefined>((res) => s.write("x\n", res));
    await settle();

    assert.ok(cbErr instanceof Error);
    assert.equal(errors, 1);
});

test("batched writes keep order and never exceed maxSize", async () => {
    const dir = tmp();
    const s = createStream({ filename: `${dir}/app-%DATE%.log`, maxSize: 1000, tz: "UTC", audit: false });
    const lines = Array.from({ length: 500 }, (_, i) => `line-${String(i).padStart(4, "0")}\n`);
    for (const l of lines) s.write(l); // synchronous burst → _writev batches
    await end(s);

    const segs = s.listSegments();
    assert.ok(segs.length > 1, "rotated");
    for (const g of segs) assert.ok(g.bytes <= 1000, `${g.file} is ${g.bytes}B`);
    const joined = segs.map((g) => fs.readFileSync(g.file, "utf8")).join("");
    assert.equal(joined, lines.join(""));
});

test("maxFiles count keeps exactly N archives besides the active segment", async () => {
    const dir = tmp();
    const s = createStream({ filename: `${dir}/app-%DATE%.log`, maxSize: 20, maxFiles: 2, tz: "UTC" });
    for (let i = 0; i < 10; i++) {
        s.write(`${"x".repeat(15)}\n`);
        await settle(20);
    }
    await end(s);

    const segs = s.listSegments();
    assert.equal(segs.length, 3, segs.map((g) => path.basename(g.file)).join(", "));
    assert.equal(segs.at(-1)!.index, 9, "active (newest) segment survives");
});

test('maxFiles "0" and "0d" mean unlimited, like the number 0', async () => {
    for (const maxFiles of ["0", "0d"]) {
        const dir = tmp();
        const old = path.join(dir, "app-2020-01-01.log.gz");
        fs.writeFileSync(old, "x");
        const s = createStream({ filename: `${dir}/app-%DATE%.log`, maxFiles, tz: "UTC" });
        await settle(200);
        s.destroy();
        assert.ok(fs.existsSync(old), `maxFiles ${maxFiles} kept the archive`);
    }
});

test("flushAll: shares one flush, reports a timeout and never exits", async () => {
    const dir = tmp();
    const s = createStream({
        filename: `${dir}/app-%DATE%.log`, tz: "UTC",
        onSeal: () => new Promise(() => { }), sealHookTimeoutMs: 1_000, // wedged upload
    });
    installShutdown(s);
    s.write("x\n");
    await settle();
    void s.rotateNow(); // queue is now stuck behind the hook for 1s

    const a = flushAll(100);
    const b = flushAll(100);
    assert.equal(a, b, "concurrent calls share one promise");
    assert.equal(await a, false, "deadline reported, process still alive");

    assert.equal(await flushAll(3_000), true, "completes once the hook times out");
});

test("destroy() releases the segment file handle", async () => {
    const dir = tmp();
    const s = createStream({ filename: `${dir}/app-%DATE%.log`, tz: "UTC" });
    s.write("x\n");
    await settle();
    s.destroy();
    await settle(50);
    fs.rmSync(dir, { recursive: true }); // EBUSY on Windows if the fd leaked
    assert.ok(!fs.existsSync(dir));
});

test("Symbol.asyncDispose flushes instead of dropping buffered lines", async () => {
    const dir = tmp();
    const s = createStream({ filename: `${dir}/app-%DATE%.log`, tz: "UTC", audit: false });
    for (let i = 0; i < 100; i++) s.write(`l${i}\n`);
    await s[Symbol.asyncDispose]();

    assert.ok(s.writableFinished);
    const text = fs.readFileSync(path.join(dir, `app-${stamp("-")}.log`), "utf8");
    assert.equal(text.split("\n").length - 1, 100);
});

test("logroller/pino default export returns a working stream", async () => {
    const dir = tmp();
    const s = pinoTransport({ filename: `${dir}/app-%DATE%.log`, tz: "UTC", audit: false }) as RotateFileStream;
    s.write('{"msg":"hi"}\n');
    await end(s);
    assert.match(fs.readFileSync(s.listSegments()[0]!.file, "utf8"), /"hi"/);
});
