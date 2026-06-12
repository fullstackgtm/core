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
  coverage: Array<{ metric: string; value: number; normalized: number }>;
  signals: ScaleSignal[];
};

export type ScaleReport = {
  vendors: VendorScale[];
  /** Metrics used (present for ≥2 vendors) and metrics skipped (singletons). */
  metricsUsed: string[];
  metricsSkipped: string[];
  complete: boolean;
};

export function computeScaleIndex(config: MarketConfig): ScaleReport {
  const byMetric = new Map<string, Array<{ vendorId: string; value: number }>>();
  for (const vendor of config.vendors) {
    for (const signal of vendor.scaleSignals ?? []) {
      if (!Number.isFinite(signal.value) || signal.value < 0) continue;
      const rows = byMetric.get(signal.metric) ?? [];
      rows.push({ vendorId: vendor.id, value: signal.value });
      byMetric.set(signal.metric, rows);
    }
  }

  const metricsUsed: string[] = [];
  const metricsSkipped: string[] = [];
  const normalized = new Map<string, Map<string, { value: number; normalized: number }>>();
  for (const [metric, rows] of byMetric) {
    // Last write wins if a vendor lists the same metric twice.
    const perVendor = new Map(rows.map((row) => [row.vendorId, row.value]));
    if (perVendor.size < 2) {
      metricsSkipped.push(metric);
      continue;
    }
    metricsUsed.push(metric);
    const logs = new Map([...perVendor].map(([vendorId, value]) => [vendorId, Math.log10(value + 1)]));
    const values = [...logs.values()];
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 1;
    const scores = new Map<string, { value: number; normalized: number }>();
    for (const [vendorId, log] of logs) {
      scores.set(vendorId, { value: perVendor.get(vendorId) as number, normalized: (log - lo) / span });
    }
    normalized.set(metric, scores);
  }
  metricsUsed.sort();
  metricsSkipped.sort();

  const vendors: VendorScale[] = config.vendors.map((vendor) => {
    const coverage: VendorScale["coverage"] = [];
    for (const metric of metricsUsed) {
      const score = normalized.get(metric)?.get(vendor.id);
      if (score) coverage.push({ metric, value: score.value, normalized: Number(score.normalized.toFixed(4)) });
    }
    const index =
      coverage.length > 0
        ? Number((coverage.reduce((sum, entry) => sum + entry.normalized, 0) / coverage.length).toFixed(4))
        : null;
    return { vendorId: vendor.id, index, coverage, signals: vendor.scaleSignals ?? [] };
  });

  return {
    vendors,
    metricsUsed,
    metricsSkipped,
    complete: vendors.every((vendor) => vendor.index !== null),
  };
}

export function scaleReportToText(config: MarketConfig, report: ScaleReport): string {
  const names = new Map(config.vendors.map((vendor) => [vendor.id, vendor.name]));
  const lines: string[] = [];
  lines.push(`Scale index (relative, within this ${config.vendors.length}-vendor set — not market share):`);
  lines.push(`metrics used: ${report.metricsUsed.join(", ") || "none"}${report.metricsSkipped.length ? ` · skipped (single-vendor): ${report.metricsSkipped.join(", ")}` : ""}`);
  lines.push("");
  const ranked = [...report.vendors].sort((a, b) => (b.index ?? -1) - (a.index ?? -1));
  for (const vendor of ranked) {
    const idx = vendor.index === null ? "  n/a" : vendor.index.toFixed(2);
    const cov = vendor.coverage.map((entry) => `${entry.metric}=${entry.value}`).join(", ") || "no signals";
    lines.push(`  ${idx}  ${(names.get(vendor.vendorId) ?? vendor.vendorId).padEnd(22)} ${cov}`);
  }
  return `${lines.join("\n")}\n`;
}
