/**
 * The resolve gate: exit 0 = safe to create, exit 2 = match found (exists or
 * ambiguous — do NOT blind-create), exit 1 = error. Built for sync jobs and
 * webhook handlers to call before any record creation.
 */
export declare function resolveCommand(args: string[]): Promise<void>;
/**
 * Governed generic writes: build a dry-run patch plan from a snapshot filter
 * plus field assignments (or --archive). Never writes — approve and apply the
 * plan like any audit plan; compare-and-set protects every operation.
 */
export declare function bulkUpdateCommand(args: string[]): Promise<void>;
/**
 * Governed duplicate cleanup: group by a normalized identity key, propose one
 * merge_records per duplicate group with a deterministic survivor. Never
 * writes — approve and apply the plan like any audit plan.
 */
export declare function dedupeCommand(args: string[]): Promise<void>;
/**
 * Ownership handoff playbook: compile one bulk-update-style plan per object
 * type. Each plan carries its full filter, so eligibility (including the
 * --except-deal-stage exclusion) is re-verified per record at apply time.
 */
export declare function reassignCommand(args: string[]): Promise<void>;
/**
 * One-shot composite for a single audit rule: audit → save → suggest →
 * approve only suggestion-backed operations meeting the confidence bar (plus
 * operations that carry concrete values and need no human input) → apply
 * (only with --yes). Every stage goes through the same gates as the manual
 * chain; placeholder values below the bar stay unapproved.
 */
export declare function fixCommand(args: string[]): Promise<void>;
export declare function suggest(args: string[]): Promise<void>;
export declare function routeCommand(args: string[]): Promise<void>;
export declare function hierarchyCommand(args: string[]): Promise<void>;
export declare function relationshipsCommand(args: string[]): Promise<void>;
