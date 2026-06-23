import { aggregateCells, cellCost, paretoFrontier } from "./metrics.ts";
import type { RunResult } from "./types.ts";

type Cell = { runs: number; score: number; max: number; violations: number; byCode: Map<string, number>; errors: number };

export function buildReport(results: RunResult[]): string {
  const models = [...new Set(results.map((r) => r.model))];
  const arms = [...new Set(results.map((r) => r.arm))];
  const scenarios = [...new Set(results.map((r) => r.scenario))];

  const cell = (model: string, arm: string): Cell => {
    const rs = results.filter((r) => r.model === model && r.arm === arm);
    const byCode = new Map<string, number>();
    for (const r of rs) for (const v of r.violations) byCode.set(v.code, (byCode.get(v.code) ?? 0) + 1);
    return {
      runs: rs.length,
      score: rs.reduce((a, r) => a + r.taskScore, 0),
      max: rs.reduce((a, r) => a + r.maxScore, 0),
      violations: rs.reduce((a, r) => a + r.violations.length, 0),
      byCode,
      errors: rs.filter((r) => r.error).length,
    };
  };

  const pct = (c: Cell) => (c.max > 0 ? `${((100 * c.score) / c.max).toFixed(1)}%` : "—");

  const lines: string[] = [];
  lines.push("# CRM Ops Eval — Results");
  lines.push("");
  lines.push(`Scenarios: ${scenarios.join(", ")}`);
  lines.push("");
  lines.push("## Reliability (CuP = full completion with zero violations; pass^k over repeated trials)");
  lines.push("");
  lines.push("| Entry | CuP | Accuracy | pass^2 | pass^4 | Violations | Runs |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const c of aggregateCells(results)) {
    const p2 = c.passK.get(2); const p4 = c.passK.get(4);
    lines.push(`| ${c.model} · ${c.arm} | ${c.cupPct.toFixed(1)}% | ${c.accuracyPct.toFixed(1)}% | ${p2 === undefined ? "—" : (100 * p2).toFixed(0) + "%"} | ${p4 === undefined ? "—" : (100 * p4).toFixed(0) + "%"} | ${c.violations} | ${c.runs} |`);
  }
  lines.push("");
  lines.push("## Cost efficiency (list prices 2026-06 — see PRICING in metrics.ts)");
  lines.push("");
  lines.push("$/safe-completion = total spend / CuP successes (amortized — failures still cost). k-tok/success is pricing-free. ★ = Pareto-efficient (nothing beats it on both cost and CuP).");
  lines.push("");
  const cells = aggregateCells(results);
  const frontier = paretoFrontier(cells, (c) => cellCost(c).dollarsPerSuccess);
  lines.push("| Entry | CuP | $/run | $/safe completion | k-tok/success | |");
  lines.push("|---|---|---|---|---|---|");
  for (const c of [...cells].sort((a, b) => cellCost(a).dollarsPerSuccess - cellCost(b).dollarsPerSuccess)) {
    const cost = cellCost(c);
    const usd = (v: number) => (Number.isFinite(v) ? `$${v < 0.1 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}` : "—");
    const ktok = Number.isFinite(cost.tokensPerSuccess) ? `${(cost.tokensPerSuccess / 1000).toFixed(0)}k` : "—";
    lines.push(`| ${c.model} · ${c.arm} | ${c.cupPct.toFixed(1)}% | ${usd(cost.dollarsPerRun)} | ${usd(cost.dollarsPerSuccess)} | ${ktok} | ${frontier.has(c) ? "★" : ""} |`);
  }
  lines.push("");
  lines.push("## Task accuracy (points earned / available)");
  lines.push("");
  lines.push(`| Model | ${arms.join(" | ")} |`);
  lines.push(`|---|${arms.map(() => "---").join("|")}|`);
  for (const model of models) {
    const cells = arms.map((arm) => {
      const c = cell(model, arm);
      return c.runs === 0 ? "—" : `${pct(c)} (${c.score}/${c.max})${c.errors ? ` ⚠${c.errors} err` : ""}`;
    });
    lines.push(`| ${model} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Safety violations (lower is better)");
  lines.push("");
  lines.push(`| Model | ${arms.join(" | ")} |`);
  lines.push(`|---|${arms.map(() => "---").join("|")}|`);
  for (const model of models) {
    const cells = arms.map((arm) => {
      const c = cell(model, arm);
      if (c.runs === 0) return "—";
      if (c.violations === 0) return "0";
      const breakdown = [...c.byCode.entries()].map(([k, n]) => `${k}×${n}`).join(", ");
      return `${c.violations} (${breakdown})`;
    });
    lines.push(`| ${model} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Per-run detail");
  lines.push("");
  lines.push("| Scenario | Model | Arm | Score | Violations | Turns | Tool calls | Tokens in/out | Error |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(
      `| ${r.scenario} | ${r.model} | ${r.arm} | ${r.taskScore}/${r.maxScore} | ${r.violations.length} | ${r.turns} | ${r.toolCalls} | ${r.inputTokens}/${r.outputTokens} | ${r.error ?? ""} |`,
    );
  }
  lines.push("");
  const allViolations = results.flatMap((r) => r.violations.map((v) => ({ ...v, run: `${r.scenario} ${r.model} ${r.arm}` })));
  if (allViolations.length > 0) {
    lines.push("## Violation detail");
    lines.push("");
    for (const v of allViolations) lines.push(`- **${v.code}** [${v.run}]: ${v.detail}`);
    lines.push("");
  }
  return lines.join("\n");
}
