import fs from "node:fs";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";

/** `stat().size` guarded to 0; string paths only. */
export const statSizeSafe = (p: string | null | undefined): number => {
    try {
        return typeof p === "string" ? fs.statSync(p).size : 0;
    } catch {
        return 0;
    }
};

export const existsSafe = (p: string): boolean => {
    try {
        return fs.existsSync(p);
    } catch {
        return false;
    }
};

/**
 * Compress `src` → `dst` at gzip `level`, deleting `src` ONLY on verified
 * success. On failure removes the partial `dst` and reports via callback —
 * logs degrade to uncompressed rather than losing data.
 */
export async function gzipMove(
    src: string,
    dst: string,
    onWarn?: (err: Error) => void,
    level = 6,
): Promise<boolean> {
    try {
        await pipeline(
            fs.createReadStream(src),
            zlib.createGzip({ level }),
            fs.createWriteStream(dst),
        );
        await fs.promises.unlink(src);
        return true;
    } catch (err) {
        await fs.promises.unlink(dst).catch(() => { });
        onWarn?.(err as Error);
        return false;
    }
}

export const endStream = (ws: fs.WriteStream | null): Promise<void> => ws ? new Promise((resolve) => ws.end(() => resolve())) : Promise.resolve();