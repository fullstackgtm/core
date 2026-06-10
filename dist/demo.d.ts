import type { CanonicalGtmSnapshot } from "./types.ts";
export type DemoSnapshotOptions = {
    /** PRNG seed; the same seed always produces the same snapshot. */
    seed?: number;
    /** Anchor date (YYYY-MM-DD) all relative dates derive from. */
    today?: string;
    accounts?: number;
    deals?: number;
};
/**
 * Generate a realistic, deliberately messy mid-market CRM snapshot.
 *
 * The mess is injected at fixed indices so audits over a given seed produce
 * stable, testable findings, while the PRNG varies names, amounts, and dates:
 * - every 8th account is an orphan (no contacts, no deals)
 * - every 9th deal references a departed owner that no longer exists
 * - every 11th deal lost its account association
 * - open deals carry a realistic spread of past close dates and stale activity
 */
export declare function generateDemoSnapshot(options?: DemoSnapshotOptions): CanonicalGtmSnapshot;
