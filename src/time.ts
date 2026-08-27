/* Timezone-aware helpers built exclusively on Intl (zero deps). */
const _dtfCache = new Map<string, Intl.DateTimeFormat>();

/** Cached `Intl.DateTimeFormat`; throws synchronously for invalid zones. */
export function getDtf(tz: string): Intl.DateTimeFormat {
    let dtf = _dtfCache.get(tz);
    if (!dtf) {
        try {
            dtf = new Intl.DateTimeFormat("en-US", {
                timeZone: tz,
                hourCycle: "h23",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            });
        } catch {
            throw new Error(`Invalid timeZone "${tz}"`);
        }
        _dtfCache.set(tz, dtf);
    }
    return dtf;
}

export function partsIn(tz: string, date: Date): Record<string, string> {
    const o: Record<string, string> = {};
    for (const p of getDtf(tz).formatToParts(date)) o[p.type] = p.value;
    return o;
}

const pad2 = (n: string): string => n.padStart(2, "0");

/** Escape a literal string for embedding inside a RegExp. */
export function escRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Substitute YYYY|YY|MM|DD|HH|mm|ss tokens in `pattern`. */
export function formatStamp(
    pattern: string,
    parts: Record<string, string>,
): string {
    return pattern.replace(
        /YYYY|YY|MM|DD|HH|mm|ss/g,
        (token) => {
            switch (token) {
                case "YYYY":
                    return parts.year;
                case "YY":
                    return parts.year.slice(-2);
                case "MM":
                    return pad2(parts.month);
                case "DD":
                    return pad2(parts.day);
                case "HH":
                    return pad2(parts.hour);
                case "mm":
                    return pad2(parts.minute);
                case "ss":
                    return pad2(parts.second);
                default:
                    return token;
            }
        },
    );
}

/** Offset of `tz` vs UTC at instant `date`, milliseconds. */
export function tzOffsetMs(tz: string, date: Date): number {
    const p = partsIn(tz, date);
    return (
        Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) -
        (date.getTime() - (date.getTime() % 1000))
    );
}

/** Next local midnight in `tz`, DST-corrected by fixed-point iteration. */
export function nextMidnight(tz: string, fromMs: number): number {
    const p = partsIn(tz, new Date(fromMs));
    const localNext = Date.UTC(+p.year, +p.month - 1, +p.day + 1);
    let inst = localNext - tzOffsetMs(tz, new Date(localNext));
    for (let i = 0; i < 3; i++) {
        const cand = localNext - tzOffsetMs(tz, new Date(inst));
        if (cand === inst) break;
        inst = cand;
    }
    if (inst <= fromMs) inst += 86_400_000;
    return inst;
}

/** Next epoch-aligned boundary (e.g. hh:00 for step = 1h). */
export const nextAligned = (from: number, step: number): number => Math.floor(from / step) * step + step;