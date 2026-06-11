import { computeFrontStates } from "./market.js";
/**
 * Render a market map as a client-ready deliverable: markdown for terminals
 * and PRs, and a self-contained printable HTML "field report" — front
 * summary, claim × vendor intensity matrix, and a verbatim-evidence
 * appendix. Deterministic: same observation set, same bytes. No webfonts,
 * no CDNs — the artifact must stand alone wherever it's sent.
 */
const FRONT_ORDER = {
    open: 0,
    contested: 1,
    owned: 2,
    saturated: 3,
    vacant: 4,
};
const GLYPH = {
    loud: "■",
    quiet: "□",
    absent: "·",
    unobservable: "▨",
};
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function buildModel(config, set) {
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
export function marketMapToMarkdown(config, set) {
    const model = buildModel(config, set);
    const stateByClaim = new Map(model.fronts.map((front) => [front.claimId, front.state]));
    const counts = { open: 0, contested: 0, owned: 0, saturated: 0, vacant: 0 };
    for (const front of model.fronts)
        counts[front.state] += 1;
    const lines = [];
    lines.push(`# Market map — ${config.category} (${set.runLabel})`);
    lines.push("");
    lines.push(`Observed ${set.runAt} · ${config.vendors.length} vendors · ${config.claims.length} claims · ` +
        `${set.observations.length} readings · extractor ${set.extractor}`);
    lines.push("");
    lines.push(`Fronts: ${counts.open + counts.vacant} open/vacant · ${counts.contested} contested · ` +
        `${counts.owned} owned · ${counts.saturated} saturated`);
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
export function marketMapToHtml(config, set) {
    const model = buildModel(config, set);
    const stateByClaim = new Map(model.fronts.map((front) => [front.claimId, front.state]));
    const claimsById = new Map(config.claims.map((claim) => [claim.id, claim]));
    const counts = { open: 0, contested: 0, owned: 0, saturated: 0, vacant: 0 };
    for (const front of model.fronts)
        counts[front.state] += 1;
    const unobservable = set.observations.filter((obs) => obs.intensity === "unobservable").length;
    const anchor = config.anchorVendor;
    const e = escapeHtml;
    const matrixRows = model.orderedClaimIds
        .map((claimId) => {
        const claim = claimsById.get(claimId);
        if (!claim)
            return "";
        const state = stateByClaim.get(claimId) ?? "vacant";
        const cells = config.vendors
            .map((vendor) => {
            const intensity = model.cell(vendor.id, claimId)?.intensity ?? "unobservable";
            const anchorClass = vendor.id === anchor ? " anchor-col" : "";
            return `<td class="cell${anchorClass}"><span class="g g-${intensity}" title="${e(vendor.name)}: ${intensity}"></span></td>`;
        })
            .join("");
        return (`<tr class="front-${state}"><th scope="row"><span class="claim-cap">${e(claim.capability.split(":")[0])}</span>` +
            `<span class="claim-meta">${e(claim.icp)} · ${e(claim.pricingStructure)}</span></th>${cells}` +
            `<td class="front"><span class="chip chip-${state}">${state.toUpperCase()}</span></td></tr>`);
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
        .flatMap((claimId) => config.vendors.flatMap((vendor) => {
        const obs = model.cell(vendor.id, claimId);
        if (!obs || obs.evidence.length === 0)
            return [];
        return obs.evidence.map((evidence) => `<div class="ev"><span class="ev-head">${e(vendor.name)} · ${e(claimId)} · ${obs.intensity.toUpperCase()} (${obs.confidence})</span>` +
            `<blockquote>“${e(evidence.text)}”</blockquote>` +
            `<span class="ev-src">${e(String(evidence.metadata?.url ?? ""))} · capture ${e(String(evidence.metadata?.captureHash ?? "").slice(0, 12))}</span></div>`);
    }))
        .join("");
    const vendorHeads = config.vendors
        .map((vendor) => `<th class="vh${vendor.id === anchor ? " anchor-col" : ""}"><span>${e(vendor.name)}</span></th>`)
        .join("");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Market map — ${e(config.category)} — ${e(set.runLabel)}</title>
<style>
:root { --paper:#f4efe4; --ink:#211d16; --ink-soft:#5a5244; --line:#c9bfa9; --accent:#b4441b; --green:#2e5339; --quiet:#8a7d63; }
* { box-sizing:border-box; margin:0; }
body { font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif; color:var(--ink); background:var(--paper);
  max-width:1080px; margin:0 auto; padding:0 48px 96px;
  background-image:radial-gradient(rgba(33,29,22,.028) 1px, transparent 1.2px); background-size:5px 5px; }
.chip,.claim-meta,.ev-src,.lg,.stamp,.meta,th.vh span { font-family:"SF Mono",Menlo,Consolas,monospace; }
header { padding:56px 0 28px; border-bottom:3px double var(--ink); position:relative; }
.kicker { font-size:11px; letter-spacing:.32em; color:var(--accent); text-transform:uppercase; }
h1 { font-size:44px; line-height:1.05; font-weight:600; margin:10px 0 6px; }
h1 em { font-style:italic; color:var(--green); }
.meta { font-size:11.5px; color:var(--ink-soft); display:flex; gap:24px; flex-wrap:wrap; margin-top:14px; }
.stamp { position:absolute; right:0; top:58px; border:2px solid var(--accent); color:var(--accent); padding:7px 13px;
  font-size:11px; letter-spacing:.22em; transform:rotate(3.5deg); text-transform:uppercase; }
section { margin-top:56px; }
h2 { font-size:13px; letter-spacing:.26em; text-transform:uppercase; color:var(--ink-soft);
  border-bottom:1px solid var(--line); padding-bottom:9px; display:flex; gap:14px; align-items:baseline; }
h2 .no { color:var(--accent); font-style:italic; font-size:15px; letter-spacing:0; }
.fronts { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--line); border:1px solid var(--line); margin-top:22px; }
.fcard { background:var(--paper); padding:18px 18px 14px; }
.fcard b { display:block; font-size:42px; font-weight:600; line-height:1; }
.fcard span { font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:var(--ink-soft); }
.fcard.open b { color:var(--accent); }
.openlist { margin-top:18px; font-size:15.5px; line-height:1.55; }
.openlist li { margin:4px 0 4px 20px; }
.openlist .why { color:var(--ink-soft); font-size:13px; font-style:italic; }
.legend { display:flex; gap:22px; flex-wrap:wrap; margin:18px 0 10px; font-size:10.5px; color:var(--ink-soft); }
.lg { display:inline-flex; align-items:center; gap:7px; }
table { border-collapse:collapse; width:100%; margin-top:6px; }
thead th { border-bottom:2px solid var(--ink); padding:6px 2px 10px; }
th.vh span { writing-mode:vertical-rl; transform:rotate(195deg); font-size:10.5px; letter-spacing:.12em;
  text-transform:uppercase; color:var(--ink-soft); display:inline-block; }
th.vh.anchor-col span { color:var(--green); font-weight:700; }
tbody th { text-align:left; font-weight:400; padding:7px 14px 7px 0; border-bottom:1px solid var(--line); max-width:330px; }
.claim-cap { display:block; font-size:14.5px; }
.claim-meta { display:block; font-size:9.5px; color:var(--quiet); letter-spacing:.08em; margin-top:2px; }
td.cell { text-align:center; border-bottom:1px solid var(--line); padding:4px 2px; }
td.cell.anchor-col { background:rgba(46,83,57,.06); }
td.front { border-bottom:1px solid var(--line); text-align:right; white-space:nowrap; }
.g { display:inline-block; width:15px; height:15px; vertical-align:middle; }
.g-loud { background:var(--ink); }
.g-quiet { box-shadow:inset 0 0 0 2px var(--quiet); }
.g-absent { background:radial-gradient(circle at center, var(--line) 0 2.5px, transparent 3px); }
.g-unobservable { background:repeating-linear-gradient(45deg, var(--line) 0 2px, transparent 2px 5px); }
tr.front-open th .claim-cap { color:var(--accent); font-weight:600; }
.chip { font-size:9px; letter-spacing:.16em; padding:3px 8px; border:1px solid currentColor; }
.chip-open { color:var(--accent); } .chip-contested { color:#7a5a12; }
.chip-owned { color:var(--green); } .chip-saturated { color:var(--ink-soft); } .chip-vacant { color:var(--quiet); }
.ev { border-bottom:1px solid var(--line); padding:12px 0; }
.ev-head { font-size:10.5px; letter-spacing:.1em; color:var(--accent); }
.ev blockquote { font-style:italic; margin:6px 0; font-size:13.5px; line-height:1.5; }
.ev-src { font-size:10px; color:var(--ink-soft); word-break:break-all; }
footer { margin-top:72px; border-top:3px double var(--ink); padding-top:14px; font-size:11px; color:var(--ink-soft);
  display:flex; justify-content:space-between; gap:20px; flex-wrap:wrap; }
@media print { body { max-width:none; padding:0 8mm; background:white; } section { break-inside:avoid-page; } tr { break-inside:avoid; } }
</style></head><body>
<header>
  <div class="kicker">Full Stack GTM · Market Map</div>
  <h1>The <em>${e(config.category.replace(/-/g, " "))}</em> front map</h1>
  <div class="meta">
    <span>RUN ${e(set.runLabel.toUpperCase())}</span><span>OBSERVED ${e(set.runAt)}</span>
    <span>${config.vendors.length} VENDORS · ${config.claims.length} CLAIMS · ${set.observations.length} READINGS</span>
    <span>${unobservable} UNOBSERVABLE · EXTRACTOR ${e(set.extractor)}</span>
  </div>
  <div class="stamp">Field Report</div>
</header>
<section>
  <h2><span class="no">01</span> Front summary</h2>
  <div class="fronts">
    <div class="fcard open"><b>${counts.open + counts.vacant}</b><span>Open / vacant</span></div>
    <div class="fcard"><b>${counts.contested}</b><span>Contested</span></div>
    <div class="fcard"><b>${counts.owned}</b><span>Owned</span></div>
    <div class="fcard"><b>${counts.saturated}</b><span>Saturated</span></div>
  </div>
  <ul class="openlist">${openList}</ul>
</section>
<section>
  <h2><span class="no">02</span> Claim × vendor intensity matrix</h2>
  <div class="legend">
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
<section>
  <h2><span class="no">03</span> Evidence appendix</h2>
  ${appendix}
</section>
<footer>
  <span>Generated by fullstackgtm market · deterministic render of ${e(set.runLabel)}</span>
  <span>Front rule v1: 0 loud=open · 1=owned · 2–3=contested · ≥4=saturated</span>
</footer>
</body></html>`;
}
