import type { MarketConfig, ScaleSignal } from "./market.ts";
/**
 * Relative scale index over the mapped vendor set — the honest version of
 * "bubble size = market share". True segment market share is unknowable from
 * public data for mostly-private vendor sets, so this computes a composite
 * index from whatever citable signals exist per vendor (review counts,
 * headcount, disclosed revenue, self-reported customers), each of which is
 * biased in a different direction; the composite triangulates.
 *
 * Method, deterministic and auditable:
 *   1. Per metric, log10(value + 1) — these signals span orders of magnitude.
 *   2. Normalize each metric to [0, 1] across the vendors that HAVE it
 *      (min–max within the set; a metric only one vendor has is skipped —
 *      it cannot rank anyone).
 *   3. A vendor's index = arithmetic mean of its normalized metric scores
 *      (mean-of-normalized rather than geometric-of-raw so missing signals
 *      neither punish nor reward), reported with coverage (which metrics).
 *
 * Vendors with zero signals get index null — the report falls back to its
 * LOUD-count sizing for the whole map rather than mixing semantics.
 */
export type VendorScale = {
    vendorId: string;
    /** [0, 1] within the mapped set; null when the vendor has no usable signals. */
    index: number | null;
    /** Metrics that contributed, with their normalized scores. */
    coverage: Array<{
        metric: string;
        value: number;
        normalized: number;
    }>;
    signals: ScaleSignal[];
};
export type ScaleReport = {
    vendors: VendorScale[];
    /** Metrics used (present for ≥2 vendors) and metrics skipped (singletons). */
    metricsUsed: string[];
    metricsSkipped: string[];
    complete: boolean;
};
export declare function computeScaleIndex(config: MarketConfig): ScaleReport;
export declare function scaleReportToText(config: MarketConfig, report: ScaleReport): string;
