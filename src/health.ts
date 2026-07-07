import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { activeProfile, credentialsDir, ensureSecureHomeDir, writeSecureFile } from "./credentials.ts";
import type { CanonicalGtmSnapshot } from "./types.ts";
import type { HealthEntry } from "./healthScore.ts";

// Pure scoring lives in healthScore.ts (node-free, importable from V8 runtimes
// like the hosted app's Convex queries); this module owns the fs-backed
// profile timeline. Re-exported so existing imports keep working.
export {
  computeHealth,
  summarizeHealth,
  healthToMarkdown,
  type HealthEntry,
  type HealthRuleDelta,
  type HealthRollup,
} from "./healthScore.ts";

/**
 * The engagement workspace: a per-client health timeline that accrues from the
 * verb people already run (`audit --save`). State lives in the profile dir
 * (`$FSGTM_HOME[/profiles/<name>]`) alongside credentials and plans, so a
 * consultant working `--profile <client>` builds a continuous record of one
 * org's CRM health over time — not just episodic one-off audits.
 *
 * The score is DETERMINISTIC (no LLM): same plan + same snapshot → same score,
 * so it is stable in CI and comparable run-over-run.
 */

// ── Profile-scoped storage ──────────────────────────────────────────────────

/** `$FSGTM_HOME[/profiles/<name>]/health.jsonl` — append-only, one entry per audit-save. */
export function healthFilePath(): string {
  return join(credentialsDir(), "health.jsonl");
}

/** `$FSGTM_HOME[/profiles/<name>]/snapshots/` — canonical snapshots correlated by plan id. */
export function snapshotsDir(): string {
  return join(credentialsDir(), "snapshots");
}

/** Append a health entry to the active profile's timeline (0600, owner-only). */
export function appendHealthEntry(entry: HealthEntry): void {
  ensureSecureHomeDir();
  appendFileSync(healthFilePath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** Read the active profile's health timeline; tolerant of partial/corrupt lines. */
export function readHealthTimeline(): HealthEntry[] {
  let raw: string;
  try {
    raw = readFileSync(healthFilePath(), "utf8");
  } catch {
    return [];
  }
  const entries: HealthEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as HealthEntry);
    } catch {
      // Skip a torn line rather than failing the whole rollup.
    }
  }
  return entries;
}

/** Persist the snapshot behind a saved audit so the timeline can diff/attribute later. */
export function saveWorkspaceSnapshot(planId: string, snapshot: CanonicalGtmSnapshot): string {
  if (!/^[\w.-]+$/.test(planId)) throw new Error(`Invalid plan id: ${planId}`);
  ensureSecureHomeDir();
  const dir = snapshotsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${planId}.json`);
  writeSecureFile(path, `${JSON.stringify(snapshot)}\n`);
  return path;
}

/** The active profile name, for rollup labeling. */
export function activeWorkspaceProfile(): string {
  return activeProfile();
}
