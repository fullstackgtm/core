const DIMENSION_WEIGHT = { revenue: 3, headcount: 2, customers: 1 };
/** Used only when headcount has zero calibration pairs in the whole set. */
const FALLBACK_REVENUE_PER_EMPLOYEE = 200_000;
export function dimensionForMetric(metric) {
    const name = metric.toLowerCase();
    if (name.includes("revenue") || name.includes("arr"))
        return "revenue";
    if (name.includes("employee") || name.includes("headcount"))
        return "headcount";
    return "customers"; // reviews, customers, installs — count-of-customers proxies
}
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
export function computeScaleIndex(config) {
    const rows = [];
    for (const vendor of config.vendors) {
        for (const signal of vendor.scaleSignals ?? []) {
            if (!Number.isFinite(signal.value) || signal.value <= 0)
                continue;
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
    const revenueByVendor = new Map();
    for (const vendor of config.vendors) {
        const revenues = rows
            .filter((row) => row.vendorId === vendor.id && row.dimension === "revenue")
            .map((row) => row.value);
        if (revenues.length > 0)
            revenueByVendor.set(vendor.id, median(revenues));
    }
    // Per-metric calibration. Customer-dimension metrics stratify by acvBand;
    // headcount calibrates globally (revenue-per-employee is the most stable
    // ratio in B2B software, which is also why headcount outweighs customers).
    const calibrations = [];
    const ratioFor = new Map();
    const nonRevenueMetrics = [...new Set(rows.filter((row) => row.dimension !== "revenue").map((row) => row.metric))].sort();
    for (const metric of nonRevenueMetrics) {
        const pairs = rows
            .filter((row) => row.metric === metric && revenueByVendor.has(row.vendorId))
            .map((row) => ({ band: row.band, ratio: revenueByVendor.get(row.vendorId) / row.value }));
        const byBand = new Map();
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
        if (global !== null)
            calibrations.push({ metric, stratum: "global", revenuePerUnit: Math.round(global), pairs: pairs.length });
        ratioFor.set(metric, { global, byBand });
    }
    const metricsUsed = new Set();
    const metricsSkipped = new Set();
    const vendors = config.vendors.map((vendor) => {
        const vendorRows = rows.filter((row) => row.vendorId === vendor.id);
        const estimates = vendorRows.map((row) => {
            if (row.dimension === "revenue") {
                metricsUsed.add(row.metric);
                return { metric: row.metric, dimension: row.dimension, rawValue: row.value, ratio: 1, estimatedRevenue: row.value, calibration: "direct" };
            }
            const calibration = ratioFor.get(row.metric);
            let ratio = null;
            let stratum = "fallback";
            if (calibration) {
                if (row.dimension === "customers" && calibration.byBand.has(row.band)) {
                    ratio = calibration.byBand.get(row.band);
                    stratum = `band:${row.band}`;
                }
                else if (calibration.global !== null) {
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
        const usable = estimates.filter((estimate) => estimate.estimatedRevenue !== null);
        let estimatedRevenue = null;
        let uncertainty = null;
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
function money(value) {
    if (value >= 1e9)
        return `$${(value / 1e9).toFixed(1)}B`;
    if (value >= 1e6)
        return `$${(value / 1e6).toFixed(1)}M`;
    return `$${Math.round(value / 1e3)}K`;
}
export function scaleReportToText(config, report) {
    const names = new Map(config.vendors.map((vendor) => [vendor.id, vendor.name]));
    const lines = [];
    lines.push(`Estimated revenue share (of this ${config.vendors.length}-vendor set; calibrated from citable signals, NOT audited):`);
    lines.push(`metrics: ${report.metricsUsed.join(", ") || "none"}${report.metricsSkipped.length ? ` · uncalibratable: ${report.metricsSkipped.join(", ")}` : ""}`);
    lines.push("");
    const ranked = [...report.vendors].sort((a, b) => (b.estimatedRevenue ?? -1) - (a.estimatedRevenue ?? -1));
    for (const vendor of ranked) {
        if (vendor.estimatedRevenue === null) {
            lines.push(`   n/a  ${(names.get(vendor.vendorId) ?? vendor.vendorId).padEnd(22)} no usable signals`);
            continue;
        }
        const share = `${((vendor.index ?? 0) * 100).toFixed(1)}%`.padStart(6);
        const spread = vendor.uncertainty !== null && vendor.uncertainty > 1 ? ` (×${vendor.uncertainty.toFixed(1)} signal spread)` : "";
        lines.push(`${share}  ${(names.get(vendor.vendorId) ?? vendor.vendorId).padEnd(22)} ~${money(vendor.estimatedRevenue)}${spread}  [${vendor.estimates
            .filter((estimate) => estimate.estimatedRevenue !== null)
            .map((estimate) => `${estimate.metric}→${money(estimate.estimatedRevenue)}`)
            .join(", ")}]`);
    }
    lines.push("");
    lines.push("calibrations (median revenue-per-unit):");
    for (const calibration of report.calibrations) {
        lines.push(`  ${calibration.metric.padEnd(26)} ${calibration.stratum.padEnd(16)} ${money(calibration.revenuePerUnit)}/unit (${calibration.pairs} pair${calibration.pairs === 1 ? "" : "s"})`);
    }
    return `${lines.join("\n")}\n`;
}
