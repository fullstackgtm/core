/**
 * Pure, node-free health scoring. Split from health.ts (which owns the
 * fs-backed profile timeline) so V8-runtime consumers — the hosted app's
 * Convex queries — can import the scoring math without pulling node built-ins,
 * the same pattern as audit.ts/format.ts.
 *
 * The score is DETERMINISTIC (no LLM): same plan + same snapshot → same score,
 * so it is stable in CI and comparable run-over-run.
 */
// Severity weights: a critical finding costs ~3× a warning, ~10× an info.
const SEVERITY_WEIGHT = { info: 1, warning: 3, critical: 10 };
/**
 * Deterministically score a saved audit. score = 100 / (1 + weighted findings
 * per record): 0 findings → 100; one weighted finding per record → 50; the
 * curve is bounded (0, 100], monotonic, and needs no clamping or magic
 * constants. A messy 50-record CRM scores worse than the same finding count
 * across 5,000 records, which is the point.
 */
export function computeHealth(plan, snapshot, at) {
    const byRule = {};
    const severityCounts = { info: 0, warning: 0, critical: 0 };
    const typeTally = {
        account: { findings: 0, weightedFindings: 0 },
        contact: { findings: 0, weightedFindings: 0 },
        deal: { findings: 0, weightedFindings: 0 },
    };
    let weightedFindings = 0;
    for (const finding of plan.findings) {
        byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
        severityCounts[finding.severity] += 1;
        weightedFindings += SEVERITY_WEIGHT[finding.severity];
        const t = finding.objectType;
        if (t === "account" || t === "contact" || t === "deal") {
            typeTally[t].findings += 1;
            typeTally[t].weightedFindings += SEVERITY_WEIGHT[finding.severity];
        }
    }
    const records = {
        accounts: snapshot.accounts.length,
        contacts: snapshot.contacts.length,
        deals: snapshot.deals.length,
        total: snapshot.accounts.length + snapshot.contacts.length + snapshot.deals.length,
    };
    const scoreFor = (weighted, recordCount) => Math.round(100 / (1 + weighted / Math.max(recordCount, 1)));
    const recordsByType = { account: records.accounts, contact: records.contacts, deal: records.deals };
    const byObjectType = ["account", "contact", "deal"].reduce((acc, t) => {
        acc[t] = {
            records: recordsByType[t],
            findings: typeTally[t].findings,
            weightedFindings: typeTally[t].weightedFindings,
            score: scoreFor(typeTally[t].weightedFindings, recordsByType[t]),
        };
        return acc;
    }, {});
    const score = scoreFor(weightedFindings, records.total);
    return {
        at,
        planId: plan.id,
        score,
        findings: plan.findings.length,
        weightedFindings,
        records,
        byRule,
        severityCounts,
        byObjectType,
    };
}
/** Roll a timeline up into the current state, the change since last time, and per-rule deltas. */
export function summarizeHealth(entries, profile) {
    if (entries.length === 0)
        return null;
    // Oldest → newest, so `current` is the last entry.
    const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));
    const current = sorted[sorted.length - 1];
    const previous = sorted.length > 1 ? sorted[sorted.length - 2] : null;
    const ruleIds = new Set([
        ...Object.keys(current.byRule),
        ...(previous ? Object.keys(previous.byRule) : []),
    ]);
    const ruleDeltas = [...ruleIds]
        .map((ruleId) => {
        const cur = current.byRule[ruleId] ?? 0;
        const prev = previous?.byRule[ruleId] ?? 0;
        return { ruleId, current: cur, previous: prev, delta: cur - prev };
    })
        .sort((a, b) => b.current - a.current || a.ruleId.localeCompare(b.ruleId));
    return {
        profile,
        auditCount: sorted.length,
        first: sorted[0].at,
        latest: current.at,
        current,
        previous,
        scoreDelta: previous ? current.score - previous.score : null,
        ruleDeltas,
        history: sorted.map((entry) => ({ at: entry.at, score: entry.score, findings: entry.findings })),
    };
}
// Sign-based and uniform: ▲ = the number went up, ▼ = down. The reader supplies
// the meaning (score up = good; findings up = bad) — mixing arrow direction with
// good/bad reads as contradictory ("▲ -3").
function arrow(delta) {
    if (delta === 0)
        return "·";
    return delta > 0 ? "▲" : "▼";
}
/** Human-readable rollup: headline score + trend, then per-rule change since last audit. */
export function healthToMarkdown(rollup) {
    const { current, scoreDelta } = rollup;
    const lines = [`# GTM health — profile \`${rollup.profile}\``, ""];
    const deltaText = scoreDelta === null
        ? "(first audit — no prior reading)"
        : `${arrow(scoreDelta)} ${scoreDelta >= 0 ? "+" : ""}${scoreDelta} since the previous audit`;
    lines.push(`Score: **${current.score}/100** ${deltaText}`, `Audits: ${rollup.auditCount} over ${shortDate(rollup.first)} → ${shortDate(rollup.latest)}`, `Findings: ${current.findings} (${current.severityCounts.critical} critical, ${current.severityCounts.warning} warning, ${current.severityCounts.info} info)`, `Records: ${current.records.accounts} accounts, ${current.records.contacts} contacts, ${current.records.deals} deals`, "");
    lines.push("## By object type", "", "| Type | Score | Findings | Records |", "| --- | --- | --- | --- |");
    for (const t of ["account", "contact", "deal"]) {
        const b = current.byObjectType[t];
        lines.push(`| ${t} | ${b.score}/100 | ${b.findings} | ${b.records} |`);
    }
    lines.push("");
    if (rollup.history.length > 1) {
        lines.push("## Trend", "");
        for (const point of rollup.history) {
            const marker = point.at === rollup.latest ? "  ← latest" : "";
            lines.push(`- ${shortDate(point.at)}  score ${point.score}  (${point.findings} findings)${marker}`);
        }
        lines.push("");
    }
    if (rollup.ruleDeltas.length > 0) {
        lines.push("## By rule (Δ since previous audit)", "", "| Rule | Findings | Δ |", "| --- | --- | --- |");
        for (const rule of rollup.ruleDeltas) {
            const sign = rule.delta > 0 ? `+${rule.delta}` : `${rule.delta}`;
            const cell = rule.delta === 0 ? "·" : `${arrow(rule.delta)} ${sign}`;
            lines.push(`| ${rule.ruleId} | ${rule.current} | ${cell} |`);
        }
        lines.push("");
    }
    lines.push("> Score is deterministic: 100 / (1 + severity-weighted findings per record). Lower findings or more clean records ⇒ higher score.");
    return `${lines.join("\n")}\n`;
}
function shortDate(iso) {
    return iso.slice(0, 10);
}
