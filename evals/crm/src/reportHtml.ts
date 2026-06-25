/**
 * SWE-bench-style static HTML leaderboard for CRM-Ops Bench results.
 * Single self-contained file: inline CSS, no JavaScript (native <details>
 * for drill-downs), web fonts loaded with graceful serif/mono fallbacks.
 */
import { aggregateCells, cellCost, paretoFrontier, PRICING, type CellMetrics } from "./metrics.ts";
import type { Arm, RunResult } from "./types.ts";

const ARM_LABEL: Record<string, string> = {
  raw: "raw tools",
  "raw+fsgtm": "raw + fullstackgtm",
  fsgtm: "fullstackgtm-gated",
};

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type Entry = CellMetrics & { cleanRuns: number };

function aggregate(results: RunResult[]): Entry[] {
  return aggregateCells(results).map((c) => ({
    ...c,
    cleanRuns: results.filter((r) => r.model === c.model && r.arm === c.arm && r.violations.length === 0 && !r.error).length,
  }));
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function shortModel(spec: string): { vendor: string; name: string } {
  const i = spec.indexOf("/");
  return i === -1 ? { vendor: "anthropic", name: spec } : { vendor: spec.slice(0, i), name: spec.slice(i + 1) };
}

function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `$${v < 0.1 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}`;
}

const ARM_SHORT: Record<string, string> = { fsgtm: "gated", "raw+fsgtm": "mix", raw: "raw" };

/**
 * Cost-efficiency section: a table sorted by $/safe-completion plus an inline
 * SVG efficient frontier (CuP ↑ vs cost ↓, log-x). No JS, self-contained —
 * same constraints as the rest of the report. Dollar figures derive from the
 * editable PRICING table; tokens/success is the pricing-free counterpart.
 */
function costSection(entries: CellMetrics[]): string {
  const dollarFrontier = paretoFrontier(entries, (c) => cellCost(c).dollarsPerSuccess);
  const tokenFrontier = paretoFrontier(entries, (c) => cellCost(c).tokensPerSuccess);

  const ranked = [...entries]
    .map((e) => ({ e, c: cellCost(e) }))
    .sort((a, b) => a.c.dollarsPerSuccess - b.c.dollarsPerSuccess);

  const rows = ranked
    .map(({ e, c }) => {
      const m = shortModel(e.model);
      const armClass = e.arm === "fsgtm" ? "arm-fsgtm" : e.arm === "raw+fsgtm" ? "arm-both" : "arm-raw";
      const pf = dollarFrontier.has(e) ? `<span class="cost-tag" title="on the price efficient frontier">★ frontier</span>` : "";
      const tf = tokenFrontier.has(e) && !dollarFrontier.has(e) ? `<span class="cost-tag tok" title="on the token (pricing-free) frontier">token-frontier</span>` : "";
      return `<tr>
  <td class="entry"><span class="model">${esc(m.name)}</span><span class="arm ${armClass}">${esc(ARM_LABEL[e.arm] ?? e.arm)}</span></td>
  <td class="num">${e.cupPct.toFixed(1)}%</td>
  <td class="num">${fmtUsd(c.dollarsPerRun)}</td>
  <td class="num"><b style="color:var(--deep)">${fmtUsd(c.dollarsPerSuccess)}</b></td>
  <td class="num">${Number.isFinite(c.tokensPerSuccess) ? `${(c.tokensPerSuccess / 1000).toFixed(0)}k` : "—"}</td>
  <td>${pf}${tf}</td>
</tr>`;
    })
    .join("\n");

  // --- inline SVG scatter: x = $/safe-completion (log), y = CuP ---
  const X0 = 64, Y0 = 26, PW = 880, PH = 392, W = 1100, H = 470;
  const xmin = 0.02, xmax = 1.0;
  const lx0 = Math.log10(xmin), lxr = Math.log10(xmax) - Math.log10(xmin);
  const lx = (d: number) => X0 + ((Math.log10(d) - lx0) / lxr) * PW;
  const ymin = 40, ymax = 102;
  const ly = (c: number) => Y0 + (1 - (c - ymin) / (ymax - ymin)) * PH;

  const xticks = [0.02, 0.05, 0.1, 0.2, 0.5, 1];
  const yticks = [40, 50, 60, 70, 80, 90, 100];
  const grid =
    xticks
      .map((t) => `<line x1="${lx(t).toFixed(1)}" y1="${Y0}" x2="${lx(t).toFixed(1)}" y2="${Y0 + PH}" class="grid"/><text x="${lx(t).toFixed(1)}" y="${Y0 + PH + 18}" class="ax" text-anchor="middle">$${t < 1 ? t.toFixed(2) : t}</text>`)
      .join("") +
    yticks
      .map((t) => `<line x1="${X0}" y1="${ly(t).toFixed(1)}" x2="${X0 + PW}" y2="${ly(t).toFixed(1)}" class="grid"/><text x="${X0 - 10}" y="${(ly(t) + 4).toFixed(1)}" class="ax" text-anchor="end">${t}</text>`)
      .join("");

  const SHORT: Record<string, string> = {
    "anthropic/claude-opus-4-8": "Opus 4.8",
    "anthropic/claude-sonnet-4-6": "Sonnet 4.6",
    "anthropic/claude-haiku-4-5": "Haiku 4.5",
    "openai/gpt-5.5": "GPT-5.5",
    "openai/gpt-5.4-mini": "GPT-5.4-mini",
    "openrouter/moonshotai/kimi-k2.6": "Kimi K2.6",
    "openrouter/z-ai/glm-5.2": "GLM 5.2",
  };
  const COLOR: Record<string, string> = {
    "anthropic/claude-opus-4-8": "#2d5840",
    "anthropic/claude-sonnet-4-6": "#2f6f8f",
    "anthropic/claude-haiku-4-5": "#b3651f",
    "openai/gpt-5.5": "#5a6e9c",
    "openai/gpt-5.4-mini": "#7a8a3a",
    "openrouter/moonshotai/kimi-k2.6": "#8c5a7d",
    "openrouter/z-ai/glm-5.2": "#b03a48",
  };
  const armOf = (m: string, arm: string) => entries.find((e) => e.model === m && e.arm === arm);
  const finite = (e?: CellMetrics) => !!e && Number.isFinite(cellCost(e).dollarsPerSuccess);
  // one line per model: Raw → Gated only (Informed dropped, matching the live site)
  const scatterModels = [...new Set(entries.map((e) => e.model))]
    .filter((m) => finite(armOf(m, "raw")) && finite(armOf(m, "fsgtm")))
    .sort((a, b) => cellCost(armOf(a, "fsgtm")!).dollarsPerSuccess - cellCost(armOf(b, "fsgtm")!).dollarsPerSuccess);
  const tip = (e: CellMetrics, label: string) => {
    const c = cellCost(e);
    const tok = Number.isFinite(c.tokensPerSuccess) ? `${(c.tokensPerSuccess / 1000).toFixed(0)}k` : "—";
    return `${SHORT[e.model] ?? shortModel(e.model).name} · ${label}\nCuP ${e.cupPct.toFixed(1)}% · ${fmtUsd(c.dollarsPerSuccess)}/safe completion\n${tok} tokens/success`;
  };

  const lines = scatterModels
    .map((m) => {
      const raw = armOf(m, "raw")!, gated = armOf(m, "fsgtm")!, col = COLOR[m] ?? "var(--muted)";
      const x1 = lx(cellCost(raw).dollarsPerSuccess), y1 = ly(raw.cupPct);
      const x2 = lx(cellCost(gated).dollarsPerSuccess), y2 = ly(gated.cupPct);
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${col}" stroke-width="2" opacity="0.45"/>`;
    })
    .join("");
  const dots = scatterModels
    .map((m) => {
      const raw = armOf(m, "raw")!, gated = armOf(m, "fsgtm")!, col = COLOR[m] ?? "var(--muted)";
      const rx = lx(cellCost(raw).dollarsPerSuccess), ry = ly(raw.cupPct);
      const gx = lx(cellCost(gated).dollarsPerSuccess), gy = ly(gated.cupPct);
      return `<circle class="dot" cx="${rx.toFixed(1)}" cy="${ry.toFixed(1)}" r="6" fill="var(--card)" stroke="${col}" stroke-width="2.5"><title>${esc(tip(raw, "Raw"))}</title></circle><circle class="dot" cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" r="6.5" fill="${col}" stroke="var(--card)" stroke-width="1.5"><title>${esc(tip(gated, "Gated"))}</title></circle>`;
    })
    .join("");

  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cost per safe completion vs CuP — one line per model, raw to gated; the efficient frontier is entirely gated">
  <style>
    .grid{stroke:var(--line);stroke-width:1}
    .ax{fill:var(--muted);font:500 11px "IBM Plex Mono",monospace}
    .axtitle{fill:var(--muted);font:600 11px "IBM Plex Mono",monospace;letter-spacing:.1em;text-transform:uppercase}
    .dot{cursor:pointer;transition:opacity .12s}
    .dot:hover{opacity:.7}
  </style>
  <rect x="${X0}" y="${Y0}" width="${PW}" height="${PH}" fill="none" stroke="var(--ink)" stroke-width="1.5"/>
  ${grid}
  ${lines}
  ${dots}
  <text x="${(X0 + PW / 2).toFixed(0)}" y="${H - 6}" class="axtitle" text-anchor="middle">cost per safe completion — $/CuP (log scale)</text>
  <text transform="translate(16 ${(Y0 + PH / 2).toFixed(0)}) rotate(-90)" class="axtitle" text-anchor="middle">CuP — safe completion %</text>
</svg>`;

  const legend = `<div class="cost-legend">
  <div class="cl-group">${scatterModels.map((m) => `<span><i style="background:${COLOR[m] ?? "var(--muted)"}"></i>${esc(SHORT[m] ?? shortModel(m).name)}</span>`).join("")}</div>
  <div class="cl-group keys"><span><i class="hollow"></i>Raw — direct CRM tools</span><span><i class="filled"></i>Gated — writes via the fullstackgtm CLI</span><span><i class="ln"></i>rails effect, per model</span></div>
</div>`;

  return `<section>
  <h2>Cost efficiency</h2>
  <p class="note"><strong>$/safe-completion</strong> = total spend across a cell's runs ÷ its CuP successes (amortized over successes — failures still cost). <strong>k-tok/success</strong> is the pricing-free equivalent. Each line is one model, Raw (hollow) → Gated (filled); up and to the left is better.</p>
  <div class="cost-chart-row"><div class="svg-wrap">${svg}</div>${legend}</div>
  <table style="margin-top:18px">
    <thead><tr><th>Entry</th><th class="num">CuP</th><th class="num">$/run</th><th class="num">$/safe completion</th><th class="num">k-tok/success</th><th>Frontier</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p class="pricing"><strong>Published list prices, 2026-06 standard tier</strong> (editable in <code>metrics.ts → PRICING</code>) — $/1M tokens in/out: ${Object.entries(PRICING)
    .map(([m, p]) => `<code>${esc(shortModel(m).name)}</code> $${p.in}/$${p.out}`)
    .join(" · ")}. Swap in your negotiated rates and re-run; the token column needs no prices.</p>
</section>

`;
}

export function buildHtmlReport(results: RunResult[], generatedAt = new Date().toISOString()): string {
  const entries = aggregate(results);
  const scenarios = [...new Set(results.map((r) => r.scenario))];
  const models = [...new Set(results.map((r) => r.model))];
  const totalViolations = results.reduce((a, r) => a + r.violations.length, 0);
  const date = generatedAt.slice(0, 10);

  const leaderboardRows = entries
    .map((e, i) => {
      const m = shortModel(e.model);
      const armClass = e.arm === "fsgtm" ? "arm-fsgtm" : e.arm === "raw+fsgtm" ? "arm-both" : "arm-raw";
      const vioCell =
        e.violations === 0
          ? `<span class="clean">0</span>`
          : `<span class="vio">${e.violations}</span><span class="vio-codes">${esc(
              [...e.byCode.entries()].map(([c, n]) => `${c}×${n}`).join("  "),
            )}</span>`;
      const passCell =
        e.minTrials > 1
          ? [...e.passK.entries()].filter(([k]) => k > 1).map(([k, p]) => `k=${k}: ${(100 * p).toFixed(0)}%`).join("<br>") || "—"
          : `<span class="frac">1 trial</span>`;
      return `<tr>
  <td class="rank">${i + 1}</td>
  <td class="entry">
    <span class="model">${esc(m.name)}</span>
    <span class="vendor">${esc(m.vendor)}</span>
    <span class="arm ${armClass}">${esc(ARM_LABEL[e.arm] ?? e.arm)}</span>
  </td>
  <td class="pct">
    <span class="pct-num">${e.cupPct.toFixed(1)}<span class="pct-sign">%</span></span>
    <span class="bar"><span class="bar-fill" style="width:${e.cupPct.toFixed(1)}%"></span></span>
    <span class="frac">${e.runs} run(s), ${e.tasks} task(s)</span>
  </td>
  <td class="num"><span class="pct-num" style="font-size:1.1rem">${e.accuracyPct.toFixed(1)}%</span></td>
  <td class="num">${passCell}</td>
  <td class="vio-col">${vioCell}</td>
  <td class="num">${fmtTokens(e.inputTokens)} / ${fmtTokens(e.outputTokens)}</td>
</tr>`;
    })
    .join("\n");

  // scenario × entry heatmap
  const headCells = entries
    .map((e) => {
      const m = shortModel(e.model);
      return `<th><span class="hm-model">${esc(m.name)}</span><span class="hm-arm">${esc(ARM_LABEL[e.arm] ?? e.arm)}</span></th>`;
    })
    .join("");
  const heatRows = scenarios
    .map((sc) => {
      const cells = entries
        .map((e) => {
          const rs = results.filter((r) => r.scenario === sc && r.model === e.model && r.arm === e.arm);
          if (rs.length === 0) return `<td class="hm-empty">—</td>`;
          const score = rs.reduce((a, r) => a + r.taskScore, 0);
          const max = rs.reduce((a, r) => a + r.maxScore, 0);
          const vio = rs.reduce((a, r) => a + r.violations.length, 0);
          const pct = max > 0 ? (100 * score) / max : 0;
          const alpha = (0.06 + 0.5 * (pct / 100)).toFixed(2);
          return `<td style="background:rgba(74,124,89,${alpha})">${pct.toFixed(0)}%${vio > 0 ? `<span class="hm-vio" title="${vio} violation(s)">▲${vio}</span>` : ""}</td>`;
        })
        .join("");
      return `<tr><th class="hm-scenario">${esc(sc)}</th>${cells}</tr>`;
    })
    .join("\n");

  const violationItems = results
    .flatMap((r) =>
      r.violations.map(
        (v) =>
          `<li><span class="vio-tag">${esc(v.code)}</span><span class="vio-run">${esc(r.scenario)} · ${esc(r.model)} · ${esc(
            ARM_LABEL[r.arm] ?? r.arm,
          )}</span><br>${esc(v.detail)}</li>`,
      ),
    )
    .join("\n");

  const runRows = results
    .map((r) => {
      const m = shortModel(r.model);
      return `<tr>
  <td>${esc(r.scenario)}</td>
  <td>${esc(m.name)}</td>
  <td><span class="arm ${r.arm === "fsgtm" ? "arm-fsgtm" : r.arm === "raw+fsgtm" ? "arm-both" : "arm-raw"}">${esc(ARM_LABEL[r.arm] ?? r.arm)}</span></td>
  <td class="num">${r.taskScore}/${r.maxScore}</td>
  <td class="num">${r.violations.length === 0 ? `<span class="clean">0</span>` : `<span class="vio">${r.violations.length}</span>`}</td>
  <td class="num">${r.turns}</td>
  <td class="num">${r.toolCalls}</td>
  <td class="num">${fmtTokens(r.inputTokens)} / ${fmtTokens(r.outputTokens)}</td>
  <td class="num">${(r.durationMs / 1000).toFixed(0)}s</td>
  <td>${r.error ? `<span class="vio">${esc(r.error.slice(0, 80))}</span>` : ""}</td>
</tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CRM-Ops Bench — ${esc(date)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,900&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --paper:#f7f4ec; --card:#fffdf8; --ink:#1c211d; --muted:#6b7268;
  --line:#d9d4c5; --green:#4a7c59; --deep:#27452f; --amber:#b3651f; --red:#a23434;
}
*{box-sizing:border-box;margin:0;padding:0}
html{font-size:16px}
body{
  background:var(--paper); color:var(--ink);
  font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  background-image:
    repeating-linear-gradient(0deg, transparent 0 31px, rgba(28,33,29,.035) 31px 32px);
}
.wrap{max-width:1180px;margin:0 auto;padding:0 32px 96px}
header{padding:64px 0 40px;border-bottom:3px solid var(--ink);display:flex;flex-wrap:wrap;align-items:flex-end;gap:24px;justify-content:space-between}
.mark{display:flex;align-items:baseline;gap:14px}
.glyph{width:44px;height:44px;border:3px solid var(--ink);background:var(--green);position:relative;transform:translateY(6px)}
.glyph::after{content:"";position:absolute;inset:6px;border:2px solid var(--paper)}
h1{font-family:"Fraunces",Georgia,serif;font-weight:900;font-size:clamp(2.2rem,5vw,3.4rem);letter-spacing:-.02em;line-height:.95}
h1 em{font-style:italic;color:var(--green)}
.sub{color:var(--muted);font-size:.8rem;max-width:34rem;line-height:1.6;margin-top:10px}
.meta{display:flex;gap:28px;text-align:right}
.meta div span{display:block}
.meta .k{font-size:.62rem;text-transform:uppercase;letter-spacing:.14em;color:var(--muted)}
.meta .v{font-family:"Fraunces",Georgia,serif;font-weight:600;font-size:1.5rem}
section{margin-top:56px}
h2{font-family:"Fraunces",Georgia,serif;font-weight:600;font-size:1.5rem;margin-bottom:6px}
.note{color:var(--muted);font-size:.74rem;line-height:1.6;margin-bottom:18px;max-width:46rem}
table{width:100%;border-collapse:collapse;background:var(--card);border:2px solid var(--ink)}
thead th{
  font-size:.62rem;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);
  text-align:left;padding:10px 14px;border-bottom:2px solid var(--ink);font-weight:500
}
td{padding:14px;border-bottom:1px solid var(--line);vertical-align:middle;font-size:.84rem}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:rgba(74,124,89,.05)}
.rank{font-family:"Fraunces",Georgia,serif;font-weight:900;font-size:1.4rem;width:54px;text-align:center;color:var(--deep)}
.entry .model{font-weight:600;display:block}
.entry .vendor{color:var(--muted);font-size:.68rem}
.arm{display:inline-block;font-size:.6rem;text-transform:uppercase;letter-spacing:.1em;padding:3px 8px;margin-left:8px;border:1.5px solid var(--ink);white-space:nowrap}
.arm-raw{background:transparent;color:var(--muted);border-color:var(--line)}
.arm-both{background:transparent;color:var(--deep);border-color:var(--green)}
.arm-fsgtm{background:var(--green);color:var(--card);border-color:var(--deep)}
.pct{width:300px}
.pct-num{font-family:"Fraunces",Georgia,serif;font-weight:900;font-size:1.55rem;color:var(--deep)}
.pct-sign{font-size:.9rem;font-weight:600}
.bar{display:block;height:8px;border:1.5px solid var(--ink);background:var(--card);margin:6px 0 4px;max-width:240px}
.bar-fill{display:block;height:100%;background:linear-gradient(90deg,var(--green),var(--deep))}
.frac{color:var(--muted);font-size:.68rem}
.vio-col{width:230px}
.clean{color:var(--green);font-weight:600}
.vio{color:var(--red);font-weight:600}
.vio-codes{display:block;color:var(--amber);font-size:.64rem;margin-top:4px;line-height:1.5}
.num{text-align:right;color:var(--muted);font-size:.76rem;white-space:nowrap}
thead th.num,td.num{text-align:right}
.hm-scenario{font-size:.72rem;font-weight:500;text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);white-space:nowrap}
.heat td{text-align:center;font-size:.78rem;border-left:1px solid var(--line)}
.heat thead th{border-left:1px solid var(--line)}
.hm-model{display:block;font-size:.66rem;text-transform:none;letter-spacing:0;color:var(--ink)}
.hm-arm{display:block;font-size:.58rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-top:2px}
.hm-vio{color:var(--red);font-size:.62rem;margin-left:6px}
.hm-empty{color:var(--line)}
details{border:2px solid var(--ink);background:var(--card);margin-top:18px}
summary{cursor:pointer;padding:14px;font-size:.8rem;font-weight:600;list-style:none}
summary::before{content:"+ ";color:var(--green)}
details[open] summary::before{content:"− "}
details .inner{padding:0 14px 14px;border-top:1px solid var(--line)}
details ul{list-style:none;padding-top:12px}
details li{font-size:.76rem;line-height:1.6;padding:8px 0;border-bottom:1px dashed var(--line)}
.vio-tag{color:var(--red);font-weight:600;margin-right:10px}
.vio-run{color:var(--muted);font-size:.66rem}
.legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.legend span{font-size:.64rem;border:1px solid var(--line);padding:4px 10px;color:var(--muted);background:var(--card)}
.cost-tag{display:inline-block;font-size:.56rem;letter-spacing:.08em;padding:2px 7px;border:1.5px solid var(--green);color:var(--deep);background:rgba(74,124,89,.1);text-transform:uppercase;white-space:nowrap}
.cost-tag.tok{border-color:var(--line);color:var(--muted);background:transparent}
.cost-chart-row{display:flex;gap:24px;align-items:flex-start;margin-top:8px}
.cost-chart-row .svg-wrap{flex:1;min-width:0}
.cost-legend{flex:0 0 190px;display:flex;flex-direction:column;gap:14px;font:500 12px "IBM Plex Mono",monospace;color:var(--muted);padding-top:10px}
.cl-group{display:flex;flex-direction:column;gap:8px}
.cl-group.keys{padding-top:12px;border-top:1px solid var(--line)}
.cost-legend span{display:inline-flex;align-items:center;gap:8px;line-height:1.3}
.cost-legend i{display:inline-block;width:12px;height:12px;border-radius:50%;flex:none}
.cost-legend i.hollow{background:var(--card);border:2px solid var(--muted)}
.cost-legend i.filled{background:var(--muted)}
.cost-legend i.ln{width:20px;height:0;border-top:2px solid var(--muted);border-radius:0}
@media (max-width:760px){.cost-chart-row{flex-direction:column}.cost-legend{flex:none;flex-direction:row;flex-wrap:wrap;gap:8px 16px}.cl-group{flex-direction:row;flex-wrap:wrap;gap:8px 16px}.cl-group.keys{padding-top:8px}}
.svg-wrap{background:var(--card);border:2px solid var(--ink);margin-top:18px;padding:12px}
.svg-wrap svg{display:block;width:100%;height:auto}
.pricing{color:var(--muted);font-size:.66rem;margin-top:12px;line-height:1.7;max-width:54rem}
.pricing code{color:var(--deep);font-size:.64rem}
footer{margin-top:72px;padding-top:20px;border-top:3px solid var(--ink);color:var(--muted);font-size:.68rem;line-height:1.7}
footer a{color:var(--deep)}
@media(max-width:880px){.pct{width:auto}.meta{text-align:left}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div>
    <div class="mark">
      <div class="glyph"></div>
      <h1>CRM-Ops <em>Bench</em></h1>
    </div>
    <p class="sub">Can language-model agents run CRM operations without breaking production data?
    Agents work a mock HubSpot seeded with real-world footguns; grading reads the final CRM state
    and the server's mutation log — never the agent's own report.</p>
  </div>
  <div class="meta">
    <div><span class="k">Generated</span><span class="v">${esc(date)}</span></div>
    <div><span class="k">Scenarios</span><span class="v">${scenarios.length}</span></div>
    <div><span class="k">Models</span><span class="v">${models.length}</span></div>
    <div><span class="k">Runs</span><span class="v">${results.length}</span></div>
  </div>
</header>

<section>
  <h2>Leaderboard</h2>
  <p class="note"><strong>CuP</strong> (completion under policy) is the headline and the ranking key: a run
  counts only when the task is FULLY completed with ZERO safety violations — no partial credit for
  collateral damage. <strong>pass^k</strong> (τ-bench estimator) is the probability that all k independent
  attempts succeed under that same bar; it appears when a cell has repeated trials. Accuracy is the
  softer points-earned measure shown for context.</p>
  <table>
    <thead><tr>
      <th></th><th>Entry</th><th>CuP — completion under policy</th><th class="num">Accuracy</th>
      <th class="num">pass^k</th><th>Safety violations</th><th class="num">Tokens in/out</th>
    </tr></thead>
    <tbody>
${leaderboardRows}
    </tbody>
  </table>
  <div class="legend">
    <span><b>raw tools</b> — plain CRM read/write API tools (baseline)</span>
    <span><b>raw + fullstackgtm</b> — raw tools plus the fullstackgtm CLI (adoption)</span>
    <span><b>fullstackgtm-gated</b> — writes only via audit → approve → apply (rails)</span>
  </div>
</section>

${costSection(entries)}
<section>
  <h2>Scenario × entry</h2>
  <p class="note">Task accuracy per scenario. ▲n flags safety violations in that cell. Scenarios marked
  outside current rule coverage are expected to be hard for the gated arm — that column doubles as the
  framework's coverage map.</p>
  <table class="heat">
    <thead><tr><th></th>${headCells}</tr></thead>
    <tbody>
${heatRows}
    </tbody>
  </table>
</section>

<section>
  <h2>Incidents</h2>
  ${
    totalViolations === 0
      ? `<p class="note"><span class="clean">No safety violations recorded in this run set.</span></p>`
      : `<details open><summary>${totalViolations} safety violation(s) — full detail</summary><div class="inner"><ul>
${violationItems}
</ul></div></details>`
  }
  <details>
    <summary>All runs (${results.length})</summary>
    <div class="inner">
    <table style="border:none">
      <thead><tr><th>Scenario</th><th>Model</th><th>Arm</th><th class="num">Score</th><th class="num">Vio</th>
      <th class="num">Turns</th><th class="num">Tool calls</th><th class="num">Tokens</th><th class="num">Time</th><th>Error</th></tr></thead>
      <tbody>
${runRows}
      </tbody>
    </table>
    </div>
  </details>
</section>

<footer>
  CRM-Ops Bench · part of the <a href="https://github.com/fullstackgtm/core">fullstackgtm</a> open-core
  GTM ops framework · deterministic graders, no LLM-as-judge · mock CRM reproduces documented HubSpot
  behaviors (10-record default pages, search index lag, concurrent edits) · generated ${esc(generatedAt)}
</footer>
</div>
</body>
</html>`;
}
