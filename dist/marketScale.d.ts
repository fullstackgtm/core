import type { MarketConfig, ScaleSignal } from "./market.ts";
/**
 * Relative scale estimation over the mapped vendor set — v2, dimensional.
 *
 * v1 normalized every signal onto [0,1] and averaged, which quietly mixed
 * dimensions: review/customer counts proxy CUSTOMER COUNT (N), while
 * employees and revenue proxy REVENUE (N × ACV). Averaging the two inflates
 * many-small-customer vendors against few-big-customer ones — the SMB bias.
 *
 * v2 converts every signal into REVENUE SPACE before combining:
 *
 *   1. Signals are classed by dimension: revenue (used directly),
 *      headcount (× revenue-per-employee), customers (× revenue-per-customer).
 *   2. Conversion ratios are CALIBRATED within the set, per metric, as the
 *      median ratio over vendors that have both the metric and a revenue
 *      signal — and customer-dimension ratios are stratified by each
 *      vendor's `acvBand` (smb / mid / enterprise), because revenue-per-
 *      review spans ~75× between SMB tools and enterprise suites. A band
 *      without calibration pairs falls back to the global median; a metric
 *      with no pairs anywhere is unusable and reported as skipped.
 *   3. A vendor's estimated revenue is the weighted geometric mean of its
 *      per-signal estimates (revenue weight 3, headcount 2, customers 1 —
 *      reliability order), with an uncertainty band = max/min estimate
 *      ratio, reported, never hidden.
 *   4. index = share of the set's summed estimated revenue; bubbles render
 *      area-proportional to it. Labeled "estimated revenue share" with the
 *      calibration disclosed — still never "market share" unqualified:
 *      it is revenue share OF THE MAPPED SET, from citable-but-unaudited
 *      signals.
 *
 * Deterministic and auditable end to end: same config, same estimates.
 */
export type ScaleDimension = "revenue" | "headcount" | "customers";
export declare function dimensionForMetric(metric: string): ScaleDimension;
export type SignalEstimate = {
    metric: string;
    dimension: ScaleDimension;
    rawValue: number;
    /** Revenue-per-unit ratio applied (1 for revenue signals); null = unusable. */
    ratio: number | null;
    estimatedRevenue: number | null;
    /** What calibrated the ratio: "direct", "band:<name>", "global", "fallback". */
    calibration: string;
};
export type VendorScale = {
    vendorId: string;
    acvBand?: string;
    estimates: SignalEstimate[];
    /** Weighted geometric mean of usable estimates; null with no usable signals. */
    estimatedRevenue: number | null;
    /** max/min across usable estimates — 1 = perfect agreement among signals. */
    uncertainty: number | null;
    /** Share of the set's summed estimated revenue; drives bubble area. */
    index: number | null;
    signals: ScaleSignal[];
};
export type ScaleReport = {
    vendors: VendorScale[];
    metricsUsed: string[];
    metricsSkipped: string[];
    /** Calibrated ratios for the appendix: metric × stratum → revenue-per-unit. */
    calibrations: Array<{
        metric: string;
        stratum: string;
        revenuePerUnit: number;
        pairs: number;
    }>;
    complete: boolean;
};
export declare function computeScaleIndex(config: MarketConfig): ScaleReport;
export declare function scaleReportToText(config: MarketConfig, report: ScaleReport): string;
