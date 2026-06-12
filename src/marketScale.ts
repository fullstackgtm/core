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

const DIMENSION_WEIGHT: Record<ScaleDimension, number> = { revenue: 3, headcount: 2, customers: 1 };

/** Used only when headcount has zero calibration pairs in the whole set. */
const FALLBACK_REVENUE_PER_EMPLOYEE = 200_000;

export function dimensionForMetric(metric: string): ScaleDimension {
  const name = metric.toLowerCase();
  if (name.includes("revenue") || name.includes("arr")) return "revenue";
  if (name.includes("employee") || name.includes("headcount")) return "headcount";
  return "customers"; // reviews, customers, installs — count-of-customers proxies
}

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
  calibrations: Array<{ metric: string; stratum: string; revenuePerUnit: number; pairs: number }>;
  complete: boolean;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeScaleIndex(config: MarketConfig): ScaleReport {
  type Row = { vendorId: string; band: string; metric: string; dimension: ScaleDimension; value: number };
  const rows: Row[] = [];
  for (const vendor of config.vendors) {
    for (const signal of vendor.scaleSignals ?? []) {
      if (!Number.isFinite(signal.value) || signal.value <= 0) continue;
      rows.push({
        vendorId: vendor.id,
        band: vendor.acvBand ?? "unknown",
        metric: signal.metric,
        dimension: signal.dimension ?? dimensionForMetric(signal.metric),
        value: signal.value,
      });
    }
  }

  // A vendor's reference revenue for calibration: median of its revenue signals.
  const revenueByVendor = new Map<string, number>();
  for (const vendor of config.vendors) {
    const revenues = rows
      .filter((row) => row.vendorId === vendor.id && row.dimension === "revenue")
      .map((row) => row.value);
    if (revenues.length > 0) revenueByVendor.set(vendor.id, median(revenues));
  }

  // Per-metric calibration. Customer-dimension metrics stratify by acvBand;
  // headcount calibrates globally (revenue-per-employee is the most stable
  // ratio in B2B software, which is also why headcount outweighs customers).
  const calibrations: ScaleReport["calibrations"] = [];
  const ratioFor = new Map<string, { global: number | null; byBand: Map<string, number> }>();
  const nonRevenueMetrics = [...new Set(rows.filter((row) => row.dimension !== "revenue").map((row) => row.metric))].sort();
  for (const metric of nonRevenueMetrics) {
    const pairs = rows
      .filter((row) => row.metric === metric && revenueByVendor.has(row.vendorId))
      .map((row) => ({ band: row.band, ratio: (revenueByVendor.get(row.vendorId) as number) / row.value }));
    const byBand = new Map<string, number>();
    if (dimensionForMetric(metric) === "customers") {
      for (const band of [...new Set(pairs.map((pair) => pair.band))]) {
        const bandRatios = pairs.filter((pair) => pair.band === band).map((pair) => pair.ratio);
        if (bandRatios.length >= 1) {
          byBand.set(band, median(bandRatios));
          calibrations.push({ metric, stratum: `band:${band}`, revenuePerUnit: Math.round(median(bandRatios)), pairs: bandRatios.length });
        }
      }
    }
    const global = pairs.length > 0 ? median(pairs.map((pair) => pair.ratio)) : null;
    if (global !== null) calibrations.push({ metric, stratum: "global", revenuePerUnit: Math.round(global), pairs: pairs.length });
    ratioFor.set(metric, { global, byBand });
  }

  const metricsUsed = new Set<string>();
  const metricsSkipped = new Set<string>();

  const vendors: VendorScale[] = config.vendors.map((vendor) => {
    const vendorRows = rows.filter((row) => row.vendorId === vendor.id);
    const estimates: SignalEstimate[] = vendorRows.map((row) => {
      if (row.dimension === "revenue") {
        metricsUsed.add(row.metric);
        return { metric: row.metric, dimension: row.dimension, rawValue: row.value, ratio: 1, estimatedRevenue: row.value, calibration: "direct" };
      }
      const calibration = ratioFor.get(row.metric);
      let ratio: number | null = null;
      let stratum = "fallback";
      if (calibration) {
        if (row.dimension === "customers" && calibration.byBand.has(row.band)) {
          ratio = calibration.byBand.get(row.band) as number;
          stratum = `band:${row.band}`;
        } else if (calibration.global !== null) {
          ratio = calibration.global;
          stratum = "global";
        }
      }
      if (ratio === null && row.dimension === "headcount") {
        ratio = FALLBACK_REVENUE_PER_EMPLOYEE;
        stratum = "fallback";
      }
      if (ratio === null) {
        metricsSkipped.add(row.metric);
        return { metric: row.metric, dimension: row.dimension, rawValue: row.value, ratio: null, estimatedRevenue: null, calibration: "uncalibratable" };
      }
      metricsUsed.add(row.metric);
      return { metric: row.metric, dimension: row.dimension, rawValue: row.value, ratio, estimatedRevenue: row.value * ratio, calibration: stratum };
    });

    const usable = estimates.filter(
      (estimate): estimate is SignalEstimate & { estimatedRevenue: number } => estimate.estimatedRevenue !== null,
    );
    let estimatedRevenue: number | null = null;
    let uncertainty: number | null = null;
    if (usable.length > 0) {
      let weightSum = 0;
      let logSum = 0;
      for (const estimate of usable) {
        const weight = DIMENSION_WEIGHT[estimate.dimension];
        weightSum += weight;
        logSum += weight * Math.log(estimate.estimatedRevenue);
      }
      estimatedRevenue = Math.exp(logSum / weightSum);
      const values = usable.map((estimate) => estimate.estimatedRevenue);
      uncertainty = Number((Math.max(...values) / Math.min(...values)).toFixed(2));
    }
    return {
      vendorId: vendor.id,
      acvBand: vendor.acvBand,
      estimates,
      estimatedRevenue,
      uncertainty,
      index: null,
      signals: vendor.scaleSignals ?? [],
    };
  });

  const total = vendors.reduce((sum, vendor) => sum + (vendor.estimatedRevenue ?? 0), 0);
  for (const vendor of vendors) {
    vendor.index = vendor.estimatedRevenue !== null && total > 0 ? Number((vendor.estimatedRevenue / total).toFixed(4)) : null;
  }

  return {
    vendors,
    metricsUsed: [...metricsUsed].sort(),
    metricsSkipped: [...metricsSkipped].filter((metric) => !metricsUsed.has(metric)).sort(),
    calibrations,
    complete: vendors.every((vendor) => vendor.index !== null),
  };
}

function money(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${Math.round(value / 1e3)}K`;
}

export function scaleReportToText(config: MarketConfig, report: ScaleReport): string {
  const names = new Map(config.vendors.map((vendor) => [vendor.id, vendor.name]));
  const lines: string[] = [];
  lines.push(`Estimated revenue share (of this ${config.vendors.length}-vendor set; calibrated from citable signals, NOT audited):`);
  lines.push(
    `metrics: ${report.metricsUsed.join(", ") || "none"}${report.metricsSkipped.length ? ` · uncalibratable: ${report.metricsSkipped.join(", ")}` : ""}`,
  );
  lines.push("");
  const ranked = [...report.vendors].sort((a, b) => (b.estimatedRevenue ?? -1) - (a.estimatedRevenue ?? -1));
  for (const vendor of ranked) {
    if (vendor.estimatedRevenue === null) {
      lines.push(`   n/a  ${(names.get(vendor.vendorId) ?? vendor.vendorId).padEnd(22)} no usable signals`);
      continue;
    }
    const share = `${((vendor.index ?? 0) * 100).toFixed(1)}%`.padStart(6);
    const spread = vendor.uncertainty !== null && vendor.uncertainty > 1 ? ` (×${vendor.uncertainty.toFixed(1)} signal spread)` : "";
    lines.push(
      `${share}  ${(names.get(vendor.vendorId) ?? vendor.vendorId).padEnd(22)} ~${money(vendor.estimatedRevenue)}${spread}  [${vendor.estimates
        .filter((estimate) => estimate.estimatedRevenue !== null)
        .map((estimate) => `${estimate.metric}→${money(estimate.estimatedRevenue as number)}`)
        .join(", ")}]`,
    );
  }
  lines.push("");
  lines.push("calibrations (median revenue-per-unit):");
  for (const calibration of report.calibrations) {
    lines.push(
      `  ${calibration.metric.padEnd(26)} ${calibration.stratum.padEnd(16)} ${money(calibration.revenuePerUnit)}/unit (${calibration.pairs} pair${calibration.pairs === 1 ? "" : "s"})`,
    );
  }
  return `${lines.join("\n")}\n`;
}
