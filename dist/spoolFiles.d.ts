/**
 * Shared reader for the spool container convention (docs/signal-spool-format.md):
 * newline-delimited JSON — one object per line, append-only — with a JSON array
 * accepted in a `.json` file for hand-staged convenience, and a DIRECTORY
 * meaning "every `*.jsonl` / `*.json` file in it, name-sorted" so multiple
 * receivers can each append their own file.
 *
 * The container is the convention; the row SCHEMA stays with each caller:
 * `signals fetch --from` validates staged signal rows, `enrich ingest` stages
 * enrichment rows, `market observe --from` validates observation-set envelopes.
 * This module only parses objects out of files — it never interprets them.
 *
 * Extracted from the `file` signal-source connector (the Phase-2 webhook
 * landing-zone reader), which now delegates here; error-message text is
 * parameterized by `label` so existing connector errors are unchanged.
 */
/** Spool files in a landing-zone directory: `*.jsonl` / `*.json`, name-sorted. */
export declare function spoolFilesIn(dir: string): string[];
/** Parse a JSON-array spool file into rows. `label` prefixes error messages. */
export declare function parseSpoolArray(raw: string, path: string, label: string): Record<string, unknown>[];
/** Parse a JSONL spool file into rows. `label` prefixes error messages. */
export declare function parseSpoolJsonl(raw: string, path: string, label: string): Record<string, unknown>[];
/** Parse one spool file's text — JSON array if it opens with `[`, else JSONL. */
export declare function parseSpoolText(raw: string, path: string, label: string): Record<string, unknown>[];
/**
 * Should an explicitly named intake path be read with spool semantics?
 * True for a directory (a landing zone) or a `*.jsonl` file. Plain `.json` /
 * `.csv` files keep each verb's original single-file handling, so existing
 * invocations parse exactly as before.
 */
export declare function isSpoolPath(absPath: string): boolean;
/** A parsed spool row plus where it came from (for error labels). */
export type SpoolRow = {
    file: string;
    index: number;
    row: Record<string, unknown>;
};
/**
 * Read an explicitly named spool path — a `.jsonl` file or a directory of
 * `*.jsonl` / `*.json` files. Unlike the webhook `file` connector (where a
 * missing spool is an empty source), the user named this path: a missing or
 * unreadable file is an error, and a malformed row throws with file + line.
 */
export declare function readSpoolPath(absPath: string, label: string): SpoolRow[];
