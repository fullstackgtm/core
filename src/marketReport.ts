import type {
  ClaimFront,
  FrontState,
  MarketConfig,
  MarketObservation,
  ObservationSet,
} from "./market.ts";
import { computeFrontStates } from "./market.ts";
import { assessAxes, messageBreadth, type AxesReport } from "./marketAxes.ts";
import { computeScaleIndex } from "./marketScale.ts";

/**
 * Render a market map as a client-ready deliverable: markdown for terminals
 * and PRs, and a self-contained printable HTML "field report" — front
 * summary, claim × vendor intensity matrix, and a verbatim-evidence
 * appendix. Deterministic: same observation set, same bytes. No webfonts,
 * no CDNs — the artifact must stand alone wherever it's sent.
 */

const FRONT_ORDER: Record<FrontState, number> = {
  open: 0,
  contested: 1,
  owned: 2,
  saturated: 3,
  vacant: 4,
};

const GLYPH: Record<string, string> = {
  loud: "■",
  quiet: "□",
  absent: "·",
  unobservable: "▨",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type MapModel = {
  config: MarketConfig;
  set: ObservationSet;
  fronts: ClaimFront[];
  /** claims sorted open-first, then by id — the report's reading order. */
  orderedClaimIds: string[];
  cell: (vendorId: string, claimId: string) => MarketObservation | undefined;
};

function buildModel(config: MarketConfig, set: ObservationSet): MapModel {
  const fronts = computeFrontStates(config, set);
  const stateByClaim = new Map(fronts.map((front) => [front.claimId, front.state]));
  const orderedClaimIds = config.claims
    .map((claim) => claim.id)
    .sort((a, b) => {
      const byFront = FRONT_ORDER[stateByClaim.get(a) ?? "vacant"] - FRONT_ORDER[stateByClaim.get(b) ?? "vacant"];
      return byFront !== 0 ? byFront : a.localeCompare(b);
    });
  const byCell = new Map(set.observations.map((obs) => [`${obs.vendorId}|${obs.claimId}`, obs]));
  return {
    config,
    set,
    fronts,
    orderedClaimIds,
    cell: (vendorId, claimId) => byCell.get(`${vendorId}|${claimId}`),
  };
}

export function marketMapToMarkdown(config: MarketConfig, set: ObservationSet): string {
  const model = buildModel(config, set);
  const stateByClaim = new Map(model.fronts.map((front) => [front.claimId, front.state]));
  const counts: Record<FrontState, number> = { open: 0, contested: 0, owned: 0, saturated: 0, vacant: 0 };
  for (const front of model.fronts) counts[front.state] += 1;

  const lines: string[] = [];
  lines.push(`# Market map — ${config.category} (${set.runLabel})`);
  lines.push("");
  lines.push(
    `Observed ${set.runAt} · ${config.vendors.length} vendors · ${config.claims.length} claims · ` +
      `${set.observations.length} readings · extractor ${set.extractor}`,
  );
  lines.push("");
  lines.push(
    `Fronts: ${counts.open + counts.vacant} open/vacant · ${counts.contested} contested · ` +
      `${counts.owned} owned · ${counts.saturated} saturated`,
  );
  lines.push("");
  lines.push(`Legend: ■ loud · □ quiet · · absent · ▨ unobservable`);
  lines.push("");
  const header = ["claim", ...config.vendors.map((v) => v.id), "front"];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const claimId of model.orderedClaimIds) {
    const cells = config.vendors.map((vendor) => GLYPH[model.cell(vendor.id, claimId)?.intensity ?? "unobservable"]);
    lines.push(`| ${claimId} | ${cells.join(" | ")} | ${stateByClaim.get(claimId)?.toUpperCase()} |`);
  }
  lines.push("");
  for (const front of model.fronts.filter((f) => f.state === "owned")) {
    lines.push(`- OWNED: ${front.claimId} → ${front.loudVendorIds[0]}`);
  }
  for (const front of model.fronts.filter((f) => f.state === "open" || f.state === "vacant")) {
    lines.push(`- ${front.state.toUpperCase()}: ${front.claimId} — no vendor is loud here`);
  }
  return `${lines.join("\n")}\n`;
}

/** size is normalized [0,1]; rendered area-proportionally (radius ∝ √size). */
type ScatterPoint = { vendorId: string; name: string; x: number; y: number; size: number };
type ScatterAxis = { label: string; negativePole: string; positivePole: string; signed: boolean };

/**
 * Okabe–Ito palette: categorical, colorblind-safe, print-stable. Vendors are
 * numbered in legend order so a dense cluster stays readable — the number in
 * the bubble resolves what overlapping labels never could.
 */
const VENDOR_COLORS = [
  "#0072b2", "#e69f00", "#009e73", "#d55e00", "#cc79a7",
  "#56b4e9", "#b8a000", "#717171", "#882255", "#44aa99",
];

/** Dark numerals on light fills, white on dark — simple luminance cut. */
function numeralColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#1c1c1c" : "#ffffff";
}

/**
 * Wrap an axis-pole label into at most two short lines. Parentheticals are
 * dropped first — poles like "REGULATED LEAD-GEN OPERATIONS (sales-led PEO)"
 * keep their head, and nothing ever runs into the opposite corner.
 */
function wrapPole(text: string, maxChars = 20): string[] {
  let cleaned = text.replace(/\s*\([^)]*\)/g, "").trim();
  if (cleaned.length === 0) cleaned = text.trim();
  const words = cleaned.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && (current + " " + word).length > maxChars) {
      lines.push(current);
      current = word;
      if (lines.length === 2) break;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (lines.length < 2 && current) lines.push(current);
  if (lines.length === 2 && current && lines[1] !== current) lines[1] = `${lines[1]}…`;
  return lines;
}

function poleText(lines: string[], x: number, y: number, anchorMode: string, fs: number): string {
  const e = escapeHtml;
  const spans = lines
    .map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : fs + 2}">${e(line)}</tspan>`)
    .join("");
  return `<text class="ax-label" style="font-size:${fs}px" x="${x}" y="${y}" text-anchor="${anchorMode}">${spans}</text>`;
}

function svgScatter(
  points: ScatterPoint[],
  ax: ScatterAxis,
  ay: ScatterAxis,
  anchor: string | undefined,
  colorByVendor: Map<string, string>,
  numberByVendor: Map<string, number>,
): string {
  const W = 640;
  const H = 480;
  const PAD_X = 56;
  const PAD_TOP = 44;
  const PAD_BOTTOM = 56;
  const range = (axis: ScatterAxis, values: number[]): [number, number] => {
    if (axis.signed) return [-1.1, 1.1];
    if (values.length === 0) return [0, 1];
    return [Math.min(0, Math.min(...values) - 0.05), Math.max(...values) + 0.08];
  };
  const [xLo, xHi] = range(ax, points.map((p) => p.x));
  const [yLo, yHi] = range(ay, points.map((p) => p.y));
  const sx = (x: number) => PAD_X + ((x - xLo) / (xHi - xLo)) * (W - 2 * PAD_X);
  const sy = (y: number) => H - PAD_BOTTOM - ((y - yLo) / (yHi - yLo)) * (H - PAD_TOP - PAD_BOTTOM);
  const e = escapeHtml;

  // Big bubbles first so small ones stay clickable/visible on top.
  const ordered = [...points].sort((a, b) => b.size - a.size);
  const dots = ordered
    .map((p) => {
      const r = 7 + 24 * Math.sqrt(p.size);
      const color = colorByVendor.get(p.vendorId) ?? "#717171";
      const ring = p.vendorId === anchor ? ` stroke="#1c1c1c" stroke-width="2.5"` : ` stroke="#ffffff" stroke-width="1.5"`;
      const number = numberByVendor.get(p.vendorId) ?? 0;
      const fs = Math.max(10, Math.min(14, r * 0.9));
      return (
        `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.88"${ring}>` +
        `<title>${e(p.name)}</title></circle>` +
        `<text x="${sx(p.x).toFixed(1)}" y="${(sy(p.y) + fs * 0.36).toFixed(1)}" text-anchor="middle" ` +
        `font-size="${fs.toFixed(1)}" font-weight="700" fill="${numeralColor(color)}" style="pointer-events:none">${number}</text>`
      );
    })
    .join("");

  const midX = ax.signed ? `<line class="grid" x1="${sx(0).toFixed(0)}" y1="${PAD_TOP}" x2="${sx(0).toFixed(0)}" y2="${H - PAD_BOTTOM}"/>` : "";
  const midY = ay.signed ? `<line class="grid" x1="${PAD_X}" y1="${sy(0).toFixed(0)}" x2="${W - PAD_X}" y2="${sy(0).toFixed(0)}"/>` : "";

  // Pole labels in four positions that cannot collide: x poles horizontal at
  // the bottom corners; y poles rotated along the left margin (positive
  // reading up toward the top, negative near the bottom) — the standard
  // chart convention, wrapped to ≤2 short lines each.
  const fsPole = 10;
  const xNeg = poleText(wrapPole(ax.negativePole), PAD_X, H - PAD_BOTTOM + 20, "start", fsPole);
  const xPos = poleText(wrapPole(ax.positivePole), W - PAD_X, H - PAD_BOTTOM + 20, "end", fsPole);
  const yLabel = (lines: string[], yEdge: number, anchorMode: "start" | "end") => {
    const spans = lines
      .map((line, index) => `<tspan x="${-yEdge}" dy="${index === 0 ? 0 : fsPole + 2}">${e(line)}</tspan>`)
      .join("");
    return `<text class="ax-label" style="font-size:${fsPole}px" transform="rotate(-90)" x="${-yEdge}" y="16" text-anchor="${anchorMode}">${spans}</text>`;
  };
  const yPos = yLabel(wrapPole(ay.positivePole, 26), PAD_TOP, "end");
  const yNeg = ay.signed ? yLabel(wrapPole(ay.negativePole, 26), H - PAD_BOTTOM, "start") : "";

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${e(ax.label)} vs ${e(ay.label)}">
    <rect x="${PAD_X}" y="${PAD_TOP}" width="${W - 2 * PAD_X}" height="${H - PAD_TOP - PAD_BOTTOM}" class="plot"/>
    ${midX}${midY}
    ${xNeg}${xPos}
    ${yPos}${yNeg}
    ${dots}</svg>`;
}

function axisSectionsHtml(
  config: MarketConfig,
  set: ObservationSet,
): { strategicMap: string; report: AxesReport | null } {
  const axes = config.axes ?? [];
  if (axes.length === 0) return { strategicMap: "", report: null };
  const e = escapeHtml;
  const report = assessAxes(config, set);
  const vendorNames = new Map(config.vendors.map((vendor) => [vendor.id, vendor.name]));

  // Bubble size: scale index (relative market scale from citable signals)
  // when every placeable vendor has one; LOUD count otherwise — never mix
  // the two semantics on one chart.
  const scale = computeScaleIndex(config);
  const scaleIndex = new Map(scale.vendors.map((vendor) => [vendor.vendorId, vendor.index]));
  const useScale = report.vendors.length > 0 && report.vendors.every((vendorId) => scaleIndex.get(vendorId) !== null && scaleIndex.get(vendorId) !== undefined);
  const loudCounts = new Map(report.vendors.map((vendorId) => [vendorId, messageBreadth(vendorId, set.observations).loudCount]));
  const maxLoud = Math.max(1, ...loudCounts.values());
  // Bubble areas stay proportional to the metric; dividing by the max just
  // spends the full visual range without distorting any ratio.
  const maxShare = Math.max(1e-9, ...report.vendors.map((vendorId) => scaleIndex.get(vendorId) ?? 0));
  const sizeOf = (vendorId: string): number =>
    useScale ? (scaleIndex.get(vendorId) as number) / maxShare : (loudCounts.get(vendorId) ?? 0) / maxLoud;
  const sizeCaption = useScale
    ? `Dot area &#8733; estimated revenue share of this vendor set (signals: ${e(scale.metricsUsed.join(", "))}; calibrated within-set, ACV-band stratified, citable but NOT audited — see \`market scale\` for estimates and spreads)`
    : "Dot area &#8733; LOUD count";

  const breadthAxis: ScatterAxis & { id: string } = {
    id: "breadth",
    label: "Message breadth",
    negativePole: "FOCUSED",
    positivePole: "BROAD (share of claims voiced)",
    signed: false,
  };
  const axisInfo = new Map<string, ScatterAxis & { id: string }>([
    ...axes.map((axis) => [axis.id, { id: axis.id, label: axis.label, negativePole: axis.negativePole, positivePole: axis.positivePole, signed: true }] as const),
    [breadthAxis.id, breadthAxis],
  ]);
  const positions = new Map<string, Map<string, number>>();
  for (const assessment of report.assessments) {
    positions.set(
      assessment.axis.id,
      new Map(
        assessment.positions
          .filter((entry): entry is { vendorId: string; position: number } => entry.position !== null)
          .map((entry) => [entry.vendorId, entry.position]),
      ),
    );
  }
  const breadthMap = new Map<string, number>();
  for (const vendorId of report.vendors) {
    const { breadth } = messageBreadth(vendorId, set.observations);
    if (breadth !== null) breadthMap.set(vendorId, breadth);
  }
  positions.set("breadth", breadthMap);

  const pointsFor = (xId: string, yId: string): ScatterPoint[] => {
    const xs = positions.get(xId);
    const ys = positions.get(yId);
    if (!xs || !ys) return [];
    return report.vendors
      .filter((vendorId) => xs.has(vendorId) && ys.has(vendorId))
      .map((vendorId) => ({
        vendorId,
        name: vendorNames.get(vendorId) ?? vendorId,
        x: xs.get(vendorId) as number,
        y: ys.get(vendorId) as number,
        size: sizeOf(vendorId),
      }));
  };

  const [px, py] = config.primaryAxes ?? [axes[0].id, axes[1]?.id ?? "breadth"];
  const axInfo = axisInfo.get(px) as ScatterAxis & { id: string };
  const ayInfo = axisInfo.get(py) as ScatterAxis & { id: string };
  const statusOf = (id: string) => axes.find((axis) => axis.id === id)?.status ?? (id === "breadth" ? "derived" : "");

  // Legend order doubles as bubble numbering: largest first, anchor bolded.
  // The number inside each bubble resolves dense clusters that name labels
  // never could; color is Okabe–Ito (colorblind-safe) keyed in the legend.
  const points = pointsFor(px, py);
  const legendOrder = [...points].sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  const numberByVendor = new Map(legendOrder.map((point, index) => [point.vendorId, index + 1]));
  const colorByVendor = new Map(legendOrder.map((point, index) => [point.vendorId, VENDOR_COLORS[index % VENDOR_COLORS.length]]));
  const legendRows = legendOrder
    .map((point) => {
      const number = numberByVendor.get(point.vendorId);
      const color = colorByVendor.get(point.vendorId) as string;
      const isAnchor = point.vendorId === config.anchorVendor;
      const measure = useScale
        ? `${(((scaleIndex.get(point.vendorId) as number) ?? 0) * 100).toFixed(1)}%`
        : `${loudCounts.get(point.vendorId) ?? 0} loud`;
      return `<tr${isAnchor ? ' class="anchor-row"' : ""}><td><span class="swatch" style="background:${color};color:${numeralColor(color)}">${number}</span></td><td>${e(point.name)}${isAnchor ? " ·&nbsp;anchor" : ""}</td><td class="num">${measure}</td></tr>`;
    })
    .join("");
  const legendMeasureHead = useScale ? "est. share" : "loud";

  const strategicMap = `<section>
  <h2>Strategic map: ${e(axInfo.label)} &#215; ${e(ayInfo.label)}</h2>
  <figure class="map">
    <div class="map-row">
      ${svgScatter(points, axInfo, ayInfo, config.anchorVendor, colorByVendor, numberByVendor)}
      <table class="legend"><thead><tr><th></th><th>vendor</th><th class="num">${legendMeasureHead}</th></tr></thead><tbody>${legendRows}</tbody></table>
    </div>
  <figcaption>Positions computed from run ${e(set.runLabel)} observations: each axis is a per-claim scoring rubric
  in the market config; a vendor sits at the intensity-weighted mean (loud=1, quiet=&#189;) of the claims it
  voices. ${sizeCaption}. Axis status — ${e(axInfo.label)}: ${e(statusOf(px))}; ${e(ayInfo.label)}: ${e(statusOf(py))}.</figcaption>
  </figure>
</section>`;

  // Deliberately no axis-pairing gallery here: the report is the client-facing
  // artifact, best foot forward — one earned 2x2. Axis exploration (PCA,
  // triangulation, the orthogonality screen over every pairing) lives in
  // `market axes` for the analyst or agent doing the iterating.
  return { strategicMap, report };
}

export function marketMapToHtml(config: MarketConfig, set: ObservationSet): string {
  const model = buildModel(config, set);
  const stateByClaim = new Map(model.fronts.map((front) => [front.claimId, front.state]));
  const claimsById = new Map(config.claims.map((claim) => [claim.id, claim]));
  const counts: Record<FrontState, number> = { open: 0, contested: 0, owned: 0, saturated: 0, vacant: 0 };
  for (const front of model.fronts) counts[front.state] += 1;
  const unobservable = set.observations.filter((obs) => obs.intensity === "unobservable").length;
  const anchor = config.anchorVendor;
  const e = escapeHtml;
  const axisHtml = axisSectionsHtml(config, set);

  const matrixRows = model.orderedClaimIds
    .map((claimId) => {
      const claim = claimsById.get(claimId);
      if (!claim) return "";
      const state = stateByClaim.get(claimId) ?? "vacant";
      const cells = config.vendors
        .map((vendor) => {
          const intensity = model.cell(vendor.id, claimId)?.intensity ?? "unobservable";
          const anchorClass = vendor.id === anchor ? " anchor-col" : "";
          return `<td class="cell${anchorClass}"><span class="g g-${intensity}" title="${e(vendor.name)}: ${intensity}"></span></td>`;
        })
        .join("");
      return (
        `<tr class="front-${state}"><th scope="row"><span class="claim-cap">${e(claim.capability.split(":")[0])}</span>` +
        `<span class="claim-meta">${e(claim.icp)} · ${e(claim.pricingStructure)}</span></th>${cells}` +
        `<td class="front"><span class="chip chip-${state}">${state.toUpperCase()}</span></td></tr>`
      );
    })
    .join("");

  const openList = model.orderedClaimIds
    .filter((claimId) => {
      const state = stateByClaim.get(claimId);
      return state === "open" || state === "vacant";
    })
    .map((claimId) => {
      const claim = claimsById.get(claimId);
      return `<li><b>${e(claim?.capability.split(":")[0] ?? claimId)}</b> <span class="why">— no vendor is loud here; ${e(claim?.icp ?? "")} cell</span></li>`;
    })
    .join("");

  const appendix = model.orderedClaimIds
    .flatMap((claimId) =>
      config.vendors.flatMap((vendor) => {
        const obs = model.cell(vendor.id, claimId);
        if (!obs || obs.evidence.length === 0) return [];
        return obs.evidence.map(
          (evidence) =>
            `<div class="ev"><span class="ev-head">${e(vendor.name)} · ${e(claimId)} · ${obs.intensity.toUpperCase()} (${obs.confidence})</span>` +
            `<blockquote>“${e(evidence.text)}”</blockquote>` +
            `<span class="ev-src">${e(String(evidence.metadata?.url ?? ""))} · capture ${e(String(evidence.metadata?.captureHash ?? "").slice(0, 12))}</span></div>`,
        );
      }),
    )
    .join("");

  const vendorHeads = config.vendors
    .map(
      (vendor) =>
        `<th class="vh${vendor.id === anchor ? " anchor-col" : ""}"><span>${e(vendor.name)}</span></th>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Market map — ${e(config.category)} — ${e(set.runLabel)}</title>
<style>
:root { --ink:#1c1c1c; --soft:#6b6b6b; --line:#e3e1dc; --faint:#f7f6f4; --accent:#b3491f; --green:#2e5e43; }
* { box-sizing:border-box; margin:0; }
body { font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif; color:var(--ink); background:#fff;
  max-width:1060px; margin:0 auto; padding:0 44px 80px; font-size:15px; line-height:1.5; }
.mono,.claim-meta,.ev-src,.key,.meta,th.vh span,.chip,.legend { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; }
header { padding:44px 0 20px; border-bottom:1px solid var(--ink); }
h1 { font-size:27px; font-weight:600; line-height:1.2; }
.meta { font-size:11px; color:var(--soft); display:flex; gap:18px; flex-wrap:wrap; margin-top:8px; }
section { margin-top:44px; }
h2 { font-size:17px; font-weight:600; border-bottom:1px solid var(--line); padding-bottom:7px; margin-bottom:4px; }
.fronts { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--line); border:1px solid var(--line); margin-top:16px; }
.fcard { background:#fff; padding:14px 16px 12px; }
.fcard b { display:block; font-size:30px; font-weight:600; line-height:1.1; }
.fcard span { font-size:11px; color:var(--soft); }
.fcard.open b { color:var(--accent); }
.openlist { margin-top:14px; font-size:14.5px; line-height:1.55; }
.openlist li { margin:3px 0 3px 20px; }
.openlist .why { color:var(--soft); font-size:13px; }
.key { display:flex; gap:20px; flex-wrap:wrap; margin:14px 0 8px; font-size:10.5px; color:var(--soft); }
.lg { display:inline-flex; align-items:center; gap:6px; }
table { border-collapse:collapse; width:100%; margin-top:6px; }
thead th { border-bottom:1.5px solid var(--ink); padding:6px 2px 8px; font-weight:600; }
th.vh span { writing-mode:vertical-rl; transform:rotate(195deg); font-size:10.5px; color:var(--soft); display:inline-block; }
th.vh.anchor-col span { color:var(--green); font-weight:700; }
tbody th { text-align:left; font-weight:400; padding:6px 14px 6px 0; border-bottom:1px solid var(--line); max-width:330px; }
.claim-cap { display:block; font-size:14px; }
.claim-meta { display:block; font-size:9.5px; color:var(--soft); margin-top:1px; }
td.cell { text-align:center; border-bottom:1px solid var(--line); padding:4px 2px; }
td.cell.anchor-col { background:var(--faint); }
td.front { border-bottom:1px solid var(--line); text-align:right; white-space:nowrap; }
.g { display:inline-block; width:14px; height:14px; vertical-align:middle; }
.g-loud { background:var(--ink); }
.g-quiet { box-shadow:inset 0 0 0 2px #9a9a9a; }
.g-absent { background:radial-gradient(circle at center, #cfcdc8 0 2.5px, transparent 3px); }
.g-unobservable { background:repeating-linear-gradient(45deg, #cfcdc8 0 2px, transparent 2px 5px); }
tr.front-open th .claim-cap { color:var(--accent); font-weight:600; }
.chip { font-size:9px; padding:2px 7px; border:1px solid currentColor; border-radius:2px; }
.chip-open { color:var(--accent); } .chip-contested { color:#8a6d1c; }
.chip-owned { color:var(--green); } .chip-saturated { color:var(--soft); } .chip-vacant { color:#9a9a9a; }
.ev { border-bottom:1px solid var(--line); padding:10px 0; }
.ev-head { font-size:10.5px; color:var(--soft); font-weight:600; }
.ev blockquote { margin:5px 0; font-size:13.5px; line-height:1.5; }
.ev-src { font-size:10px; color:var(--soft); word-break:break-all; }
figure.map { margin-top:16px; border:1px solid var(--line); }
.map-row { display:flex; gap:8px; align-items:flex-start; padding:10px 12px 0; }
.map-row svg { flex:1 1 62%; min-width:0; }
.plot { fill:var(--faint); stroke:var(--line); }
.grid { stroke:#d6d4cf; stroke-dasharray:3 5; }
.ax-label { fill:var(--soft); font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; }
table.legend { flex:0 0 auto; width:auto; margin:8px 0 12px; font-size:12px; }
table.legend thead th { font-size:10px; color:var(--soft); font-weight:600; border-bottom:1px solid var(--line); padding:2px 8px 5px 0; text-align:left; }
table.legend td { padding:4px 8px 4px 0; border-bottom:1px solid var(--faint); white-space:nowrap; }
table.legend td.num, table.legend th.num { text-align:right; }
table.legend tr.anchor-row td { font-weight:700; }
.swatch { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; border-radius:50%;
  color:#fff; font-size:10.5px; font-weight:700; }
figcaption { font-size:11.5px; color:var(--soft); padding:10px 14px 12px; border-top:1px solid var(--line); line-height:1.5; }
footer { margin-top:60px; border-top:1px solid var(--ink); padding-top:12px; font-size:11px; color:var(--soft);
  display:flex; justify-content:space-between; gap:20px; flex-wrap:wrap; }
@media print { body { max-width:none; padding:0 8mm; } section { break-inside:avoid-page; } tr { break-inside:avoid; } .map-row { display:block; } }
@media (max-width:760px) { .map-row { display:block; } }
</style></head><body>
<header>
  <h1>Market map — ${e(config.category.replace(/-/g, " "))}</h1>
  <div class="meta">
    <span>run ${e(set.runLabel)}</span><span>observed ${e(set.runAt)}</span>
    <span>${config.vendors.length} vendors · ${config.claims.length} claims · ${set.observations.length} readings · ${unobservable} unobservable</span>
    <span>extractor: ${e(set.extractor)}</span>
  </div>
</header>
<section>
  <h2>Front summary</h2>
  <div class="fronts">
    <div class="fcard open"><b>${counts.open + counts.vacant}</b><span>Open / vacant</span></div>
    <div class="fcard"><b>${counts.contested}</b><span>Contested</span></div>
    <div class="fcard"><b>${counts.owned}</b><span>Owned</span></div>
    <div class="fcard"><b>${counts.saturated}</b><span>Saturated</span></div>
  </div>
  <ul class="openlist">${openList}</ul>
</section>
<section>
  <h2>Claim × vendor intensity matrix</h2>
  <div class="key">
    <span class="lg"><i class="g g-loud"></i>LOUD — hero-level claim</span>
    <span class="lg"><i class="g g-quiet"></i>QUIET — shipped, buried</span>
    <span class="lg"><i class="g g-absent"></i>ABSENT</span>
    <span class="lg"><i class="g g-unobservable"></i>UNOBSERVABLE — capture failed</span>
  </div>
  <table>
    <thead><tr><th></th>${vendorHeads}<th></th></tr></thead>
    <tbody>${matrixRows}</tbody>
  </table>
</section>
${axisHtml.strategicMap}
<section>
  <h2>Evidence appendix</h2>
  ${appendix}
</section>
<footer>
  <span>Generated by fullstackgtm market · deterministic render of ${e(set.runLabel)}</span>
  <span>Front rule v1: 0 loud=open · 1=owned · 2–3=contested · ≥4=saturated</span>
</footer>
</body></html>`;
}
