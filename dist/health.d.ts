import type { AuditFindingSeverity, CanonicalGtmSnapshot, PatchPlan } from "./types.ts";
export type HealthEntry = {
    /** ISO timestamp of the audit that produced this entry. */
    at: string;
    /** The saved plan this entry summarizes (correlates to plans/ and snapshots/). */
    planId: string;
    /** Deterministic 0–100 hygiene score (higher is healthier). */
    score: number;
    /** Total finding count across all rules. */
    findings: number;
    /** Severity-weighted finding total (drives the score). */
    weightedFindings: number;
    /** Record counts at audit time — the denominator that normalizes the score. */
    records: {
        accounts: number;
        contacts: number;
        deals: number;
        total: number;
    };
    /** Finding count per rule id. */
    byRule: Record<string, number>;
    /** Finding count per severity. */
    severityCounts: Record<AuditFindingSeverity, number>;
    /**
     * Per-object-type breakdown — so "is my contact data clean but my pipeline
     * messy?" is answerable without re-auditing. Each type carries its own
     * record-normalized score (same curve as the overall score, scoped to that
     * type's records + findings).
     */
    byObjectType: Record<"account" | "contact" | "deal", {
        records: number;
        findings: number;
        weightedFindings: number;
        score: number;
    }>;
};
export type HealthRuleDelta = {
    ruleId: string;
    current: number;
    previous: number;
    /** current − previous: positive = more findings (worse), negative = fewer (better). */
    delta: number;
};
export type HealthRollup = {
    profile: string;
    auditCount: number;
    first: string;
    latest: string;
    current: HealthEntry;
    previous: HealthEntry | null;
    /** current.score − previous.score: positive = improving. null on the first audit. */
    scoreDelta: number | null;
    ruleDeltas: HealthRuleDelta[];
    history: Array<{
        at: string;
        score: number;
        findings: number;
    }>;
};
/**
 * Deterministically score a saved audit. score = 100 / (1 + weighted findings
 * per record): 0 findings → 100; one weighted finding per record → 50; the
 * curve is bounded (0, 100], monotonic, and needs no clamping or magic
 * constants. A messy 50-record CRM scores worse than the same finding count
 * across 5,000 records, which is the point.
 */
export declare function computeHealth(plan: PatchPlan, snapshot: CanonicalGtmSnapshot, at: string): HealthEntry;
/** Roll a timeline up into the current state, the change since last time, and per-rule deltas. */
export declare function summarizeHealth(entries: HealthEntry[], profile: string): HealthRollup | null;
/** Human-readable rollup: headline score + trend, then per-rule change since last audit. */
export declare function healthToMarkdown(rollup: HealthRollup): string;
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
