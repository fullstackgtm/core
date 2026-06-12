export function computeScaleIndex(config) {
    const byMetric = new Map();
    for (const vendor of config.vendors) {
        for (const signal of vendor.scaleSignals ?? []) {
            if (!Number.isFinite(signal.value) || signal.value < 0)
                continue;
            const rows = byMetric.get(signal.metric) ?? [];
            rows.push({ vendorId: vendor.id, value: signal.value });
            byMetric.set(signal.metric, rows);
        }
    }
    const metricsUsed = [];
    const metricsSkipped = [];
    const normalized = new Map();
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
        const scores = new Map();
        for (const [vendorId, log] of logs) {
            scores.set(vendorId, { value: perVendor.get(vendorId), normalized: (log - lo) / span });
        }
        normalized.set(metric, scores);
    }
    metricsUsed.sort();
    metricsSkipped.sort();
    const vendors = config.vendors.map((vendor) => {
        const coverage = [];
        for (const metric of metricsUsed) {
            const score = normalized.get(metric)?.get(vendor.id);
            if (score)
                coverage.push({ metric, value: score.value, normalized: Number(score.normalized.toFixed(4)) });
        }
        const index = coverage.length > 0
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
export function scaleReportToText(config, report) {
    const names = new Map(config.vendors.map((vendor) => [vendor.id, vendor.name]));
    const lines = [];
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
