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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Spool files in a landing-zone directory: `*.jsonl` / `*.json`, name-sorted. */
export function spoolFilesIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".jsonl") || name.endsWith(".json"))
    .sort()
    .map((name) => join(dir, name));
}

/** Parse a JSON-array spool file into rows. `label` prefixes error messages. */
export function parseSpoolArray(raw: string, path: string, label: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} ${path}: not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} ${path}: expected a JSON array of staged signal rows.`);
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label} ${path}: row ${index} is not an object.`);
    }
    return entry as Record<string, unknown>;
  });
}

/** Parse a JSONL spool file into rows. `label` prefixes error messages. */
export function parseSpoolJsonl(raw: string, path: string, label: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const lines = raw.split("\n");
  lines.forEach((line, index) => {
    const t = line.trim();
    if (!t) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch (error) {
      throw new Error(`${label} ${path}: line ${index} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} ${path}: line ${index} is not a JSON object.`);
    }
    out.push(parsed as Record<string, unknown>);
  });
  return out;
}

/** Parse one spool file's text — JSON array if it opens with `[`, else JSONL. */
export function parseSpoolText(raw: string, path: string, label: string): Record<string, unknown>[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed.startsWith("[") ? parseSpoolArray(trimmed, path, label) : parseSpoolJsonl(trimmed, path, label);
}

/**
 * Should an explicitly named intake path be read with spool semantics?
 * True for a directory (a landing zone) or a `*.jsonl` file. Plain `.json` /
 * `.csv` files keep each verb's original single-file handling, so existing
 * invocations parse exactly as before.
 */
export function isSpoolPath(absPath: string): boolean {
  try {
    if (statSync(absPath).isDirectory()) return true;
  } catch {
    return false;
  }
  return absPath.endsWith(".jsonl");
}

/** A parsed spool row plus where it came from (for error labels). */
export type SpoolRow = { file: string; index: number; row: Record<string, unknown> };

/**
 * Read an explicitly named spool path — a `.jsonl` file or a directory of
 * `*.jsonl` / `*.json` files. Unlike the webhook `file` connector (where a
 * missing spool is an empty source), the user named this path: a missing or
 * unreadable file is an error, and a malformed row throws with file + line.
 */
export function readSpoolPath(absPath: string, label: string): SpoolRow[] {
  const isDir = statSync(absPath).isDirectory();
  const files = isDir ? spoolFilesIn(absPath) : [absPath];
  if (isDir && files.length === 0) {
    throw new Error(`${label} ${absPath}: directory contains no *.jsonl / *.json spool files.`);
  }
  const rows: SpoolRow[] = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    parseSpoolText(raw, file, label).forEach((row, index) => rows.push({ file, index, row }));
  }
  return rows;
}
