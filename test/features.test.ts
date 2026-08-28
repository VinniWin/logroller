/**
 * Feature tests for 2.1.0: symlink pointer, maxTotalSize budget,
 * onSeal hook, stats()/listSegments(), compressionLevel, shutdown helper.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { createStream as _createStream } from "../dist/index.esm.js";
import { installShutdown } from "../dist/index.esm.js";
import type {
    RotateFileStream,
    RotateFileStreamOptions,
    SealInfo,
} from "../dist/index";

const createStream = _createStream as unknown as (
    opts: RotateFileStreamOptions,
) => RotateFileStream;

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "logroller-feat-"));
const stampOf = (offsetDays = 0, tz = "UTC"): string => {
    const d = new Date(Date.now() + offsetDays * 86400000);
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
};
const end = (s: RotateFileStream): Promise<void> =>
    new Promise((res) => s.end(res));
const settle = (ms = 150): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));
const seedArchive = (
    dir: string, name: string, size: number, mtime: string,
): void => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, "x".repeat(size));
    const t = new Date(mtime);
    fs.utimesSync(p, t, t);
};

/* ---------------- symlink (posix only) ---------------- */
const symlinkTest = process.platform === "win32" ? test.skip : test;

symlinkTest("symlink: stable path follows the active segment across rotations",
    async () => {
        const dir = tmp();
        const link = path.join(dir, "app-current.log");
        const s = createStream({
            filename: `${dir}/app-%DATE%.log`,
            maxSize: 600,                 // 20×37B=740B → exactly ONE rotation
            zippedArchive: true,
            symlink: true,
            tz: "UTC",
        });
        try {
            s.write("first\n");
            await settle();

            assert.ok(fs.existsSync(link), "link created on open");
            assert.equal(fs.readlinkSync(link), `app-${stampOf(0)}.log`);
            assert.match(fs.readFileSync(link, "utf8"), /first/);

            for (let i = 0; i < 20; i++) s.write(`r-${i}-${"x".repeat(30)}\n`);
            await settle();

            assert.equal(fs.readlinkSync(link), `app-${stampOf(0)}.1.log`,
                "flipped to the new segment after rotation");
            assert.match(fs.readFileSync(link, "utf8"), /r-19/);
        } finally {
            s.destroy();
        }
    });

symlinkTest("symlink: custom name + excluded from retention and listing",
    async () => {
        const dir = tmp();
        const s = createStream({
            filename: `${dir}/app-%DATE%.log`,
            maxSize: 600,
            symlink: "CURRENT",
            maxFiles: "1",
            tz: "UTC",
        });
        try {
            s.write("hello\n");
            await settle();
            const link = path.join(dir, "CURRENT");
            assert.ok(fs.existsSync(link));

            for (let i = 0; i < 20; i++) s.write(`${"y".repeat(40)}\n`);
            await settle();

            assert.ok(fs.existsSync(link), "link survives retention");
            const stamps = s.listSegments().map((x) => x.stamp);
            assert.ok(!stamps.includes("CURRENT"), "not listed as a segment");
        } finally {
            s.destroy();
        }
    });

/* ---------------- maxTotalSize ---------------- */
test("maxTotalSize: deletes OLDEST archives until under budget", async () => {
    const dir = tmp();
    // oldest→newest: 100B + 200B + 400B = 700B; budget 500B
    // → delete Jan-01 (700→600), delete Jan-02 (600→400 ≤ 500). Keep Jan-03.
    seedArchive(dir, "app-2020-01-01.log.gz", 100, "2020-01-01T00:00:00Z");
    seedArchive(dir, "app-2020-01-02.log.gz", 200, "2020-01-02T00:00:00Z");
    seedArchive(dir, "app-2020-01-03.log.gz", 400, "2020-01-03T00:00:00Z");

    const s = createStream({
        filename: `${dir}/app-%DATE%.log`,
        maxTotalSize: 500,
        tz: "UTC",
    });
    try {
        await settle(300);
        assert.ok(!fs.existsSync(path.join(dir, "app-2020-01-01.log.gz")));
        assert.ok(!fs.existsSync(path.join(dir, "app-2020-01-02.log.gz")));
        assert.ok(fs.existsSync(path.join(dir, "app-2020-01-03.log.gz")),
            "newest kept (400B ≤ 500B)");
    } finally {
        s.destroy();
    }
});

test("maxTotalSize: composes with maxFiles count policy", async () => {
    const dir = tmp();
    // three 100/200/400B files; maxFiles "2" kills Jan-01 (excess count);
    // budget 500 then sees Jan-02+Jan-03 = 600B > 500 → kills Jan-02.
    // Union of policies → only Jan-03 survives.
    seedArchive(dir, "app-2020-01-01.log.gz", 100, "2020-01-01T00:00:00Z");
    seedArchive(dir, "app-2020-01-02.log.gz", 200, "2020-01-02T00:00:00Z");
    seedArchive(dir, "app-2020-01-03.log.gz", 400, "2020-01-03T00:00:00Z");

    const s = createStream({
        filename: `${dir}/app-%DATE%.log`,
        maxFiles: "2",
        maxTotalSize: 500,
        tz: "UTC",
    });
    try {
        await settle(300);
        const left = fs.readdirSync(dir).filter((f) => f.endsWith(".log.gz"));
        assert.deepEqual(left, ["app-2020-01-03.log.gz"],
            "count removed Jan-01, budget removed Jan-02");
    } finally {
        s.destroy();
    }
});

/* ---------------- onSeal hook ---------------- */
test("onSeal: awaited with gz path, runs BEFORE retention can delete",
    async () => {
        const dir = tmp();
        const sealed: SealInfo[] = [];

        // 20 lines × 37B = 740B; maxSize 600 → exactly ONE rotation per round
        const s = createStream({
            filename: `${dir}/app-%DATE%.log`,
            maxSize: 600,
            zippedArchive: true,
            maxFiles: "1",
            tz: "UTC",
            onSeal: async (info) => {
                // simulate a slow upload — proves the rotation queue waits
                await new Promise((r) => setTimeout(r, 50));
                const text = zlib.gunzipSync(fs.readFileSync(info.gz!)).toString();
                assert.match(text, /s\d-/);
                sealed.push(info);
            },
        });
        try {
            for (let round = 0; round < 2; round++)
                for (let i = 0; i < 20; i++)
                    s.write(`s${round}-${i}-${"x".repeat(30)}\n`);
            await settle();
            await end(s);

            assert.equal(sealed.length, 2, "one seal per round");
            assert.ok(sealed.every((x) => x.gz!.endsWith(".log.gz")));
            const left = fs.readdirSync(dir).filter((f) => f.endsWith(".log.gz"));
            assert.equal(left.length, 1, "retention kept only the newest archive");
        } finally {
            s.destroy();
        }
    });

test("onSeal: null gz when compression is off; hook errors degrade to warn",
    async () => {
        const dir = tmp();
        const seen: SealInfo[] = [];
        const warns: Error[] = [];

        // 20 lines × 41B = 820B; maxSize 600 → exactly ONE rotation
        const s = createStream({
            filename: `${dir}/app-%DATE%.log`,
            maxSize: 600,
            zippedArchive: false,
            tz: "UTC",
            onSeal: async (info) => {
                seen.push(info);
                throw new Error("upload failed (intentional)");
            },
        });
        s.on("warn", (e) => warns.push(e));
        try {
            for (let i = 0; i < 20; i++) s.write(`${"x".repeat(40)}\n`);
            await settle();
            await end(s);

            assert.equal(seen.length, 1);
            assert.equal(seen[0].gz, null, "no gz when zippedArchive is false");
            assert.ok(warns.some((w) => /upload failed/.test(w.message)),
                "hook failure surfaced as warn, rotation continued");
            assert.ok(fs.existsSync(path.join(dir, `app-${stampOf(0)}.1.log`)),
                "next segment was still created");
        } finally {
            s.destroy();
        }
    });

/* ---------------- stats / listSegments ---------------- */
test("stats() and listSegments() report disk truth", async () => {
    const dir = tmp();
    // 20 lines × 41B = 820B; maxSize 600 → exactly ONE rotation → 2 segments
    const s = createStream({
        filename: `${dir}/app-%DATE%.log`,
        maxSize: 600,
        zippedArchive: true,
        tz: "UTC",
    });
    try {
        for (let i = 0; i < 20; i++) s.write(`${"x".repeat(40)}\n`);
        await settle();

        const st = s.stats();
        assert.equal(st.dir, dir);
        assert.equal(st.currentStamp, stampOf(0));
        assert.equal(st.segments, 2);        // .log.gz + .1.log
        assert.equal(st.archived, 1);
        assert.ok(st.activeFile!.endsWith(".1.log"));
        assert.equal(st.activeIndex, 1);
        assert.ok(st.totalBytes > 0);
        assert.equal(st.clockOffsetMs, 0);
        assert.equal(st.symlink, null);

        const list = s.listSegments();
        assert.deepEqual(list.map((l) => l.index), [0, 1]);
        assert.equal(list[0].gzipped, true);
        assert.equal(list[1].gzipped, false);
        assert.ok(list.every((l) => l.bytes > 0));
        assert.ok(list.every((l) => l.stamp === stampOf(0)));
    } finally {
        s.destroy();
    }
});

/* ---------------- compressionLevel ---------------- */
test("compressionLevel: 0 (stored) still produces valid gzip", async () => {
    const dir = tmp();
    const line = `payload-${"z".repeat(200)}\n`;
    const s = createStream({
        filename: `${dir}/app-%DATE%.log`,
        maxSize: 200,
        zippedArchive: true,
        compressionLevel: 0,
        tz: "UTC",
    });
    try {
        s.write(line);
        await s.rotateNow();
        await settle();
        const gz = path.join(dir, `app-${stampOf(0)}.log.gz`);
        const text = zlib.gunzipSync(fs.readFileSync(gz)).toString();
        assert.match(text, /payload-/);
        assert.ok(fs.statSync(gz).size > Buffer.byteLength(line) * 0.8,
            "stored-mode archive is uncompressed-size-like");
    } finally {
        s.destroy();
    }
});

/* ---------------- shutdown helper ---------------- */
test("installShutdown: flush() ends all registered streams cleanly",
    async () => {
        const dir = tmp();
        const a = createStream({ filename: `${dir}/a-%DATE%.log`, tz: "UTC" });
        const b = createStream({ filename: `${dir}/b-%DATE%.log`, tz: "UTC" });
        try {
            a.write("alpha\n");
            b.write("bravo\n");

            const flush = installShutdown([a, b], { timeoutMs: 2_000 });
            await flush();

            assert.ok(a.writableEnded, "stream a ended");
            assert.ok(b.writableEnded, "stream b ended");
            assert.match(
                fs.readFileSync(path.join(dir, `a-${stampOf(0)}.log`), "utf8"),
                /alpha/);
            assert.match(
                fs.readFileSync(path.join(dir, `b-${stampOf(0)}.log`), "utf8"),
                /bravo/);
        } finally {
            // flush already ended them — double-end is harmless; destroy only
            // guarantees timers are gone even if an assert above threw
            a.destroy();
            b.destroy();
        }
    });