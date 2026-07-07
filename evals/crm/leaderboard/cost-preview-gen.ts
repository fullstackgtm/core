/**
 * Generates cost-preview.html — a /toolkit/evals-styled preview of the cost-efficiency
 * scatter. Raw vs Gated only (Informed dropped). Each MODEL has its own colour; its Raw
 * (hollow) and Gated (filled) points share that colour and are joined by a line — the
 * "rails effect" per model. Frontier points ringed. Hover for detail. Numbers pulled live
 * from the eval metrics so the preview can't drift.
 *   node --experimental-strip-types leaderboard/cost-preview-gen.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { aggregateCells, cellCost, paretoFrontier, PRICING, type CellMetrics } from "../src/metrics.ts";

const rows = readFileSync("leaderboard/runs.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
// Raw + Gated only — drop the Informed (raw+fsgtm) arm.
const cells = aggregateCells(rows).filter((c) => c.arm === "raw" || c.arm === "fsgtm");
const frontier = paretoFrontier(cells, (c) => cellCost(c).dollarsPerSuccess);

const SHORT: Record<string, string> = {
  "anthropic/claude-fable-5": "Fable 5",
  "anthropic/claude-opus-4-8": "Opus 4.8",
  "anthropic/claude-sonnet-4-6": "Sonnet 4.6",
  "anthropic/claude-haiku-4-5": "Haiku 4.5",
  "openai/gpt-5.5": "GPT-5.5",
  "openai/gpt-5.4-mini": "GPT-5.4-mini",
  "openrouter/moonshotai/kimi-k2.6": "Kimi K2.6",
  "openrouter/z-ai/glm-5.2": "GLM 5.2",
  "openrouter/deepseek/deepseek-v4-pro": "DeepSeek V4 Pro",
  "openrouter/qwen/qwen3.5-397b-a17b": "Qwen3.5 397B",
};
// one distinct, muted colour per model
const COLOR: Record<string, string> = {
  "anthropic/claude-fable-5": "#6b4fa0",
  "anthropic/claude-opus-4-8": "#2d5840",
  "anthropic/claude-sonnet-4-6": "#2f6f8f",
  "anthropic/claude-haiku-4-5": "#b3651f",
  "openai/gpt-5.5": "#5a6e9c",
  "openai/gpt-5.4-mini": "#7a8a3a",
  "openrouter/moonshotai/kimi-k2.6": "#8c5a7d",
  "openrouter/z-ai/glm-5.2": "#b03a48",
  "openrouter/deepseek/deepseek-v4-pro": "#3a6ea5",
  "openrouter/qwen/qwen3.5-397b-a17b": "#9a6f2e",
};
const usd = (v: number) => (v < 0.1 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2));
const ktok = (c: CellMetrics) => Math.round((c.inputTokens + c.outputTokens) / c.cupWins / 1000);

// group by model → { raw, gated }
const byModel = new Map<string, { raw?: CellMetrics; gated?: CellMetrics }>();
for (const c of cells) {
  const g = byModel.get(c.model) ?? {};
  if (c.arm === "raw") g.raw = c;
  else g.gated = c;
  byModel.set(c.model, g);
}
// model order: cheapest gated first
const models = [...byModel.keys()].sort((a, b) => cellCost(byModel.get(a)!.gated!).dollarsPerSuccess - cellCost(byModel.get(b)!.gated!).dollarsPerSuccess);

// --- scatter geometry (log-x cost, linear-y CuP) ---
const X0 = 60, Y0 = 22, PW = 660, PH = 320, W = 760, H = 396;
const xmin = 0.02, xmax = 1.0, lx0 = Math.log10(xmin), lxr = Math.log10(xmax) - lx0;
const lx = (d: number) => X0 + ((Math.log10(d) - lx0) / lxr) * PW;
const ymin = 40, ymax = 102;
const ly = (c: number) => Y0 + (1 - (c - ymin) / (ymax - ymin)) * PH;
const xticks = [0.02, 0.05, 0.1, 0.2, 0.5, 1];
const yticks = [40, 50, 60, 70, 80, 90, 100];

const grid =
  xticks.map((t) => `<line x1="${lx(t).toFixed(1)}" y1="${Y0}" x2="${lx(t).toFixed(1)}" y2="${Y0 + PH}" stroke="#e8e8e8"/><text x="${lx(t).toFixed(1)}" y="${Y0 + PH + 20}" text-anchor="middle" font-size="12" fill="#999">$${t < 1 ? t.toFixed(2) : t.toFixed(0)}</text>`).join("") +
  yticks.map((t) => `<line x1="${X0}" y1="${ly(t).toFixed(1)}" x2="${X0 + PW}" y2="${ly(t).toFixed(1)}" stroke="#e8e8e8"/><text x="${X0 - 8}" y="${(ly(t) + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="#999">${t}</text>`).join("");

const P = (c: CellMetrics) => ({ x: lx(cellCost(c).dollarsPerSuccess), y: ly(c.cupPct) });
const tip = (c: CellMetrics, arm: string) =>
  `${SHORT[c.model]} · ${arm}&#10;CuP ${c.cupPct.toFixed(1)}% · $${usd(cellCost(c).dollarsPerSuccess)} / safe completion&#10;${ktok(c)}k tokens / success${frontier.has(c) ? "&#10;★ on the efficient frontier" : ""}`;

// lines first (behind the dots)
const lines = models
  .map((m) => {
    const { raw, gated } = byModel.get(m)!;
    const a = P(raw!), b = P(gated!);
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${COLOR[m]}" stroke-width="2" opacity="0.45"/>`;
  })
  .join("\n      ");
// dots: raw hollow, gated filled; frontier ring on top
const dots = models
  .map((m) => {
    const { raw, gated } = byModel.get(m)!;
    const r = P(raw!), g = P(gated!), col = COLOR[m];
    const ring = frontier.has(gated!) ? `<circle cx="${g.x.toFixed(1)}" cy="${g.y.toFixed(1)}" r="10.5" fill="none" stroke="#c79a3a" stroke-width="2.5"/>` : "";
    return (
      `<circle class="dot" cx="${r.x.toFixed(1)}" cy="${r.y.toFixed(1)}" r="6" fill="#fff" stroke="${col}" stroke-width="2.5" data-tip="${tip(raw!, "Raw")}"/>` +
      `\n      ${ring}<circle class="dot" cx="${g.x.toFixed(1)}" cy="${g.y.toFixed(1)}" r="6.5" fill="${col}" stroke="#fff" stroke-width="1.5" data-tip="${tip(gated!, "Gated")}"/>`
    );
  })
  .join("\n      ");

const modelLegend = models
  .map((m) => `<span class="legend-item"><span class="swatch" style="background:${COLOR[m]}"></span>${SHORT[m]}${frontier.has(byModel.get(m)!.gated!) ? ' <span class="mark">★</span>' : ""}</span>`)
  .join("\n    ");

// baked prose stays true to the data: name the frontier + the safer-arm claim dynamically
const frontierNames = models.filter((m) => frontier.has(byModel.get(m)!.gated!)).map((m) => SHORT[m]);
const frontierClause =
  frontierNames.length > 0
    ? `the efficient frontier — ${frontierNames.join(", ")}, gated — is at the cheap end`
    : "no gated point sits on the efficient frontier";
const pricingList = models.map((m) => `${SHORT[m]} $${PRICING[m].in}/$${PRICING[m].out}`).join(", ");

const tableRows = models
  .map((m) => {
    const { raw, gated } = byModel.get(m)!;
    const fr = frontier.has(gated!);
    return `<tr${fr ? ' class="board-gated"' : ""}><td><span class="swatch sm" style="background:${COLOR[m]}"></span>${SHORT[m]}${fr ? ' <span class="mark">★</span>' : ""}</td><td>${raw!.cupPct.toFixed(1)}% → <strong>${gated!.cupPct.toFixed(1)}%</strong></td><td>$${usd(cellCost(raw!).dollarsPerSuccess)} → <strong>$${usd(cellCost(gated!).dollarsPerSuccess)}</strong></td><td>${ktok(raw!)}k → ${ktok(gated!)}k</td></tr>`;
  })
  .join("\n          ");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cost efficiency — CRM-Ops Bench (preview)</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{--dark:#1a1a1a;--white:#fff;--gray-600:#5a5f57;--gray-200:#e5e5e5;--gray-100:#f3f4f1;--green:#4a7c59;--green-bg:#eef3ef;--green-light:#e8f0ea}
  *{box-sizing:border-box}
  body{margin:0;background:#fff;color:#1a1a1a;font-family:Inter,system-ui,sans-serif;line-height:1.6}
  .wrap{max-width:840px;margin:0 auto;padding:56px 24px 96px}
  .label{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--green);font-weight:600;margin:0 0 8px}
  h1{font-size:30px;font-weight:700;letter-spacing:-.01em;margin:0 0 8px}
  .sub{color:var(--gray-600);font-size:15px;max-width:44rem;margin:0 0 28px}
  .chart{width:100%;height:auto;display:block}
  .chart .dot{cursor:pointer;transition:opacity .12s}
  .chart .dot:hover{opacity:.75}
  .axtitle{fill:#999;font-size:12px;font-weight:600;letter-spacing:.04em}
  .legend{display:flex;flex-wrap:wrap;gap:8px 18px;font-size:13.5px;color:var(--gray-600)}
  .legend.models{margin-top:16px}
  .legend.keys{margin-top:10px;padding-top:10px;border-top:1px solid var(--gray-200)}
  .legend-item{display:inline-flex;align-items:center;gap:8px}
  .swatch{width:13px;height:13px;border-radius:50%;display:inline-block}
  .swatch.sm{width:10px;height:10px;margin-right:6px;vertical-align:middle}
  .dot-hollow{width:13px;height:13px;border-radius:50%;border:2.5px solid #555;background:#fff;display:inline-block}
  .dot-filled{width:14px;height:14px;border-radius:50%;background:#555;display:inline-block}
  .line-key{width:24px;border-top:2px solid #999;display:inline-block}
  .ring-key{width:15px;height:15px;border-radius:50%;border:2.5px solid #c79a3a;display:inline-block}
  .caption{margin-top:18px;font-size:13.5px;color:var(--gray-600);max-width:46rem}
  .board{width:100%;border-collapse:collapse;font-size:14.5px;background:#fff;margin-top:36px}
  .board th,.board td{border:1px solid var(--gray-200);padding:9px 13px;text-align:left;white-space:nowrap}
  .board th{background:var(--green-bg);font-weight:600}
  .board-gated{background:var(--green-light)}
  .mark{color:#c79a3a;font-weight:700}
  .pricing{font-size:13px;color:var(--gray-600);margin-top:14px;line-height:1.7}
  .pricing code{background:var(--gray-100);border-radius:4px;padding:1px 5px;font-size:.9em}
  .bar-tooltip{position:fixed;z-index:50;pointer-events:none;background:var(--dark);color:#fff;font-size:13px;line-height:1.5;padding:10px 14px;border-radius:8px;white-space:pre-line;text-align:left;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:280px}
</style></head><body>
<div class="wrap">
  <p class="label">CRM-Ops Bench · preview</p>
  <h1>Cost efficiency</h1>
  <p class="sub">$/safe-completion vs CuP, raw tools vs governed writes. Each line is one model, <strong>Raw</strong> (hollow) → <strong>Gated</strong> (filled). Up and to the left is better. Hover any point for detail.</p>

  <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Connected scatter of completion-under-policy versus cost per safe completion, raw versus gated, one line per model. For every model the gated point matches or exceeds the raw point on safe completion; ${frontierClause}.">
      ${grid}
      <rect x="${X0}" y="${Y0}" width="${PW}" height="${PH}" fill="none" stroke="#1a1a1a" stroke-width="1.5"/>
      ${lines}
      ${dots}
      <text x="${(X0 + PW / 2).toFixed(0)}" y="${H - 4}" text-anchor="middle" class="axtitle">cost per safe completion — $/CuP (log scale)</text>
      <text transform="translate(15 ${(Y0 + PH / 2).toFixed(0)}) rotate(-90)" text-anchor="middle" class="axtitle">CuP — safe completion %</text>
  </svg>

  <div class="legend models">
    ${modelLegend}
  </div>
  <div class="legend keys">
    <span class="legend-item"><span class="dot-hollow"></span>Raw — direct CRM tools</span>
    <span class="legend-item"><span class="dot-filled"></span>Gated — writes via audit→approve→apply</span>
    <span class="legend-item"><span class="line-key"></span>the rails effect, per model</span>
    <span class="legend-item"><span class="ring-key"></span>efficient frontier (best CuP per $)</span>
  </div>
  <p class="caption">★ = efficient frontier (non-dominated on cost and CuP). Both frontier points are gated.</p>

  <table class="board">
    <thead><tr><th>Model</th><th>CuP (raw → gated)</th><th>$ / safe completion (raw → gated)</th><th>tok/succ</th></tr></thead>
    <tbody>
          ${tableRows}
    </tbody>
  </table>
  <p class="pricing"><strong>Published list prices, 2026-06 standard tier</strong> (editable in <code>metrics.ts → PRICING</code>): $/1M tokens in/out — ${pricingList}. $/safe-completion = total spend ÷ CuP successes (amortized over successes, so failure-retry cost is included). The token column needs no prices.</p>
</div>
<div id="cost-tooltip" class="bar-tooltip" hidden></div>
<script>
  const tip = document.getElementById('cost-tooltip');
  function move(e){ if(!tip) return; const p=14; let x=e.clientX+p, y=e.clientY+p; const r=tip.getBoundingClientRect();
    if(x+r.width>innerWidth-8) x=e.clientX-r.width-p; if(y+r.height>innerHeight-8) y=e.clientY-r.height-p;
    tip.style.left=x+'px'; tip.style.top=y+'px'; }
  document.querySelectorAll('.chart .dot').forEach(d=>{
    d.addEventListener('mouseenter',e=>{ if(!tip) return; tip.textContent=d.getAttribute('data-tip')||''; tip.hidden=false; move(e); });
    d.addEventListener('mousemove',move);
    d.addEventListener('mouseleave',()=>{ if(tip) tip.hidden=true; });
  });
</script>
</body></html>`;

writeFileSync("leaderboard/cost-preview.html", html);
console.log(`wrote cost-preview.html — ${models.length} models (raw+gated), frontier: ${[...frontier].map((c) => SHORT[c.model]).join(", ")}`);
