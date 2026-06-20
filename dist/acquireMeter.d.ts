/** Budget declared in enrich.config.json under `acquire.budget`. */
export type AcquireBudget = {
    records?: {
        perDay?: number;
        perMonth?: number;
    };
    spend?: {
        perDay?: number;
        perMonth?: number;
        currency?: string;
    };
};
export type AcquireMeterState = {
    /** UTC day bucket, YYYY-MM-DD. */
    day: string;
    /** UTC month bucket, YYYY-MM. */
    month: string;
    records: {
        day: number;
        month: number;
    };
    spendUsd: {
        day: number;
        month: number;
    };
};
export type AcquireRemaining = {
    /** Remaining headroom per window; null = no budget set for that dimension. */
    records: {
        day: number | null;
        month: number | null;
    };
    spendUsd: {
        day: number | null;
        month: number | null;
    };
    /**
     * The single number that matters: how many MORE records may be created right
     * now, given every budget dimension and the per-record cost. null = unlimited
     * (no budget constrains creation). 0 = budget exhausted.
     */
    maxRecords: number | null;
};
export declare function dayKey(now: Date): string;
export declare function monthKey(now: Date): string;
export declare function acquireMeterPath(baseDir?: string): string;
/**
 * Roll the window counters forward: a new UTC day zeroes the day buckets, a
 * new UTC month zeroes the month buckets. Returns a fresh object; never
 * mutates the input.
 */
export declare function rollWindows(state: AcquireMeterState, now: Date): AcquireMeterState;
/** Load the meter from disk, rolling stale windows forward. Missing = empty. */
export declare function loadMeter(now: Date, baseDir?: string): AcquireMeterState;
export declare function saveMeter(state: AcquireMeterState, baseDir?: string): void;
/**
 * Compute remaining headroom and the max additional records creatable now.
 * `costPerRecord` (USD) converts the spend budget into a record ceiling; when
 * it is 0 the spend budget cannot constrain record count.
 */
export declare function remaining(state: AcquireMeterState, budget: AcquireBudget | undefined, costPerRecord: number, now: Date): AcquireRemaining;
/**
 * Record a successful batch of creates against the budget and persist.
 * Returns the updated state. Call AFTER the writes land, so a failed apply
 * never charges the meter.
 */
export declare function recordConsumption(now: Date, recordsCreated: number, spendUsd: number, baseDir?: string): AcquireMeterState;
