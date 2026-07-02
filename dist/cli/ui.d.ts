type StreamLike = {
    isTTY?: boolean;
    columns?: number;
    write(chunk: string): boolean;
};
export type UiEnv = Record<string, string | undefined>;
/** Should `stream` receive color/ANSI styling at all? */
export declare function colorEnabled(stream?: StreamLike | undefined, env?: UiEnv): boolean;
/**
 * Should `stream` receive live single-line repaints (spinners, bars)?
 * Stricter than color: FORCE_COLOR opts into color codes, not into cursor
 * animation — repaint sequences in a captured log are never what anyone wants.
 */
export declare function animationEnabled(stream?: StreamLike | undefined, env?: UiEnv): boolean;
declare const CODES: {
    readonly reset: "\u001B[0m";
    readonly bold: "\u001B[1m";
    readonly dim: "\u001B[2m";
    readonly red: "\u001B[31m";
    readonly green: "\u001B[32m";
    readonly yellow: "\u001B[33m";
    readonly blue: "\u001B[34m";
    readonly magenta: "\u001B[35m";
    readonly cyan: "\u001B[36m";
};
export type StyleName = keyof Omit<typeof CODES, "reset">;
export type Paint = Record<StyleName, (text: string) => string> & {
    enabled: boolean;
};
/**
 * Style functions for one stream: identity functions when styling is off, so
 * call sites never branch. `paint(colorEnabled(process.stdout))`.
 */
export declare function paint(enabled: boolean): Paint;
export declare const GLYPH: {
    readonly ok: "✓";
    readonly warn: "!";
    readonly fail: "✗";
    readonly pending: "○";
    readonly bullet: "●";
};
/** `✓` in green / `!` in yellow / `✗` in red — or the bare glyph unstyled. */
export declare function statusGlyph(state: "ok" | "warn" | "fail" | "pending", p: Paint): string;
/** Color banding for 0–100 scores: ≥80 green, ≥60 yellow, else red. */
export declare function scoreColor(score: number, p: Paint): string;
/** Min–max normalized sparkline: [42, 51, 68, 81] → "▁▃▅█". */
export declare function sparkline(values: number[]): string;
/** `formatBar(0.67)` → "▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱" (clamped to [0,1]). */
export declare function formatBar(fraction: number, width?: number): string;
/** 950 → "950ms"; 12_400 → "12s"; 84_000 → "1m 24s". */
export declare function formatDuration(ms: number): string;
/** 12345 → "12,345" (fixed en-US grouping — output must not vary by host locale). */
export declare function formatCount(value: number): string;
/**
 * Rounded-corner frame around pre-rendered lines. `width` is measured on the
 * raw text, so style the CONTENT only after framing (or pass unstyled lines) —
 * ANSI codes inside `lines` would inflate the measured width.
 */
export declare function box(lines: string[], p: Paint, title?: string): string[];
/**
 * Left-aligned columns with two-space gutters. Rows may be ragged; widths are
 * measured on raw cell text, so pass unstyled cells and style whole lines, or
 * style via the optional per-column painters (applied AFTER padding).
 */
export declare function table(rows: string[][], painters?: Array<((cell: string) => string) | null>): string[];
export type StatusLine = {
    /** Replace the line's text (next frame repaints it). */
    set(text: string): void;
    /** Stop animating; optionally leave a final static line (else clear). */
    done(finalText?: string): void;
    readonly active: boolean;
};
/**
 * One live spinner line on stderr, repainted in place. Returns an inert no-op
 * outside an interactive TTY, so call sites never branch. `done()` always
 * clears the animation; pass `finalText` to leave a plain summary line behind.
 */
export declare function createStatusLine(stream?: StreamLike, env?: UiEnv): StatusLine;
/**
 * A status line that re-renders itself every second with the elapsed time —
 * for single long waits (an LLM call) where nothing else ticks. `label`
 * receives the formatted elapsed time. Inert outside an interactive TTY.
 */
export declare function startElapsedStatus(label: (elapsed: string) => string, stream?: StreamLike, env?: UiEnv): {
    done(finalText?: string): void;
    active: boolean;
};
export type Checklist = {
    update(id: string, state: "pending" | "running" | "ok" | "warn" | "fail", note?: string): void;
    /** Stop animating and erase the board (callers print their own summary). */
    done(): void;
    readonly active: boolean;
};
/**
 * A multi-line live board — one line per item, each flipping ○ → ⠹ → ✓ as work
 * progresses (the audit rule registry renders through this). Repaints with
 * cursor-up; erases itself on done() so the verb's real output owns stdout.
 */
export declare function createChecklist(items: Array<{
    id: string;
    label: string;
}>, stream?: StreamLike, env?: UiEnv): Checklist;
/** Truncate to `max` display characters, ending in "…" when cut. */
export declare function truncateToWidth(text: string, max: number): string;
/** critical → red, warning → yellow, info → dim. */
export declare function severityWord(word: string, p: Paint): string;
/** needs_approval → yellow, approved/applied → green, rejected → red. */
export declare function planStatusWord(status: string, p: Paint): string;
/**
 * Interactive-terminal styling for the patch-plan markdown that `audit` and
 * `plans show` print: headings bold, severities banded, and the core diff —
 * current value red, proposed value green (placeholders yellow: they need a
 * human before they can be written). Line-level and additive — with paint
 * disabled the text passes through untouched, so piped output is unchanged.
 * One deliberate text change in rich mode: finding headlines render
 * terminal-bold instead of markdown-bold (the ** markers drop).
 */
export declare function stylizePlanMarkdown(text: string, p: Paint): string;
/** Strip ANSI escape sequences (test helper + safety net for width math). */
export declare function stripAnsi(text: string): string;
export {};
