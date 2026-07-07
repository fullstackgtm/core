import type { CanonicalGtmSnapshot } from "./types.ts";
import type { HealthEntry } from "./healthScore.ts";
export { computeHealth, summarizeHealth, healthToMarkdown, type HealthEntry, type HealthRuleDelta, type HealthRollup, } from "./healthScore.ts";
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
/** `$FSGTM_HOME[/profiles/<name>]/health.jsonl` — append-only, one entry per audit-save. */
export declare function healthFilePath(): string;
/** `$FSGTM_HOME[/profiles/<name>]/snapshots/` — canonical snapshots correlated by plan id. */
export declare function snapshotsDir(): string;
/** Append a health entry to the active profile's timeline (0600, owner-only). */
export declare function appendHealthEntry(entry: HealthEntry): void;
/** Read the active profile's health timeline; tolerant of partial/corrupt lines. */
export declare function readHealthTimeline(): HealthEntry[];
/** Persist the snapshot behind a saved audit so the timeline can diff/attribute later. */
export declare function saveWorkspaceSnapshot(planId: string, snapshot: CanonicalGtmSnapshot): string;
/** The active profile name, for rollup labeling. */
export declare function activeWorkspaceProfile(): string;
