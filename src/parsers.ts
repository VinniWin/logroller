import type { RotateFileStreamOptions } from "./types.js";

/* ---------------- internal shapes ---------------- */
export interface ParsedMaxFiles {
    days?: number;
    count?: number;
}
export type ParsedFrequency =
    | { readonly type: "daily" }
    | { readonly type: "interval"; ms: number };

const UNITS: Record<string, number> = {
    b: 1, k: 1024, kb: 1024,
    m: 1048576, mb: 1048576,
    g: 1073741824, gb: 1073741824,
};

const FREQ_MULT: Record<string, number> = {
    ms: 1, s: 1000, m: 60_000, h: 3_600_000,
};

function parseDuration(
    value: number | string,
    defaultUnit: keyof typeof FREQ_MULT,
    fieldName: string,
): number {
    if (typeof value === "number") {
        return Math.round(value * FREQ_MULT[defaultUnit]);
    }
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value);
    if (!m) throw new Error(`Invalid ${fieldName} "${value}"`);
    return Math.round(Number.parseFloat(m[1]) * FREQ_MULT[(m[2] ?? defaultUnit).toLowerCase()],);
}

export function parseSize(v: RotateFileStreamOptions["maxSize"]): number {
    if (v === undefined || v === null || v === 0) return 0;
    if (typeof v === "number") return v;
    const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|k|mb|m|gb|g)?\s*$/i.exec(v);
    if (!m) throw new Error(`Invalid maxSize "${v}"`);
    return Math.round(Number.parseFloat(m[1]) * (UNITS[m[2]?.toLowerCase()] ?? 1));
}

export function parseMaxFiles(
    v: RotateFileStreamOptions["maxFiles"],
): ParsedMaxFiles | null {
    if (v === undefined || v === null || v === "" || v === 0) return null;
    if (typeof v === "number") return { count: v };
    const m = /^\s*(\d+)\s*d\s*$/i.exec(v);
    if (m) return { days: Number.parseInt(m[1], 10) };
    const n = /^\s*(\d+)\s*$/.exec(v);
    if (n) return { count: Number.parseInt(n[1], 10) };
    throw new Error(`Invalid maxFiles "${v}"`);
}

export function parseFrequency(
    v: RotateFileStreamOptions["frequency"],
): ParsedFrequency {
    if (v === undefined || v === null) return { type: "daily" };
    if (v === "daily") return { type: "daily" };
    if (typeof v === "number") {
        if (v <= 0) throw new Error(`Invalid frequency "${v}"`);
        return { type: "interval", ms: v };
    }
    const m = /^\s*(\d+)\s*(ms|s|m|h)\s*$/i.exec(v);
    if (!m) throw new Error(`Invalid frequency "${v}"`);
    return { type: "interval", ms: Number.parseInt(m[1], 10) * FREQ_MULT[m[2].toLowerCase()] };
}

export function parseClockOffset(
    v: RotateFileStreamOptions["addHours"],
): number {
    if (v === undefined || v === null || v === "") return 0;
    return parseDuration(v, "h", "addHours");
}

export function parseClockStep(
    v: RotateFileStreamOptions["addHoursEveryMin"],
): number {
    if (v === undefined || v === null || v === "") return 0;
    return parseDuration(v, "h", "addHours");
}