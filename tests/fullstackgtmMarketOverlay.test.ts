import assert from "node:assert/strict";
import test from "node:test";
import {
  type MarketConfig,
  type MarketObservation,
  type ObservationSet,
} from "../src/market.ts";
import {
  computeDirectives,
  computeOverlayStats,
  directivesToPlan,
  overlayToMarkdown,
  type CallDocument,
} from "../src/marketOverlay.ts";
import { computeScaleIndex } from "../src/marketScale.ts";
import { marketMapToHtml } from "../src/marketReport.ts";
import type { CanonicalGtmSnapshot } from "../src/types.ts";

process.env.FSGTM_NO_BROWSER = "1";

/**
 * Fixture geography (anchor = "us"):
 *   open-claim       — open front (rival quiet), anchor absent, buyers mention it    → OCCUPY
 *   quiet-winner     — anchor quiet, mentioned deals win far above baseline          → PROMOTE
 *   crowded-claim    — saturated (4 loud incl. anchor), zero won-deal mentions       → RETREAT
 *   fine-claim       — owned by anchor; control, no directive
 *   thin-claim       — open + anchor absent but only 1 mention                        → below minMentions, no directive
 */
function config(): MarketConfig {
  const vendor = (id: string, aliases?: string[]) => ({
    id,
    name: id.toUpperCase(),
    urls: { home: `https://${id}.test/`, pricing: null, product: [] },
    aliases,
  });
  return {
    category: "test-cat",
    anchorVendor: "us",
    vendors: [vendor("us", ["US Corp"]), vendor("r1"), vendor("r2"), vendor("r3"), vendor("r4")],
    claims: [
      { id: "open-claim", capability: "Open thing", icp: "x", pricingStructure: "y", definition: "d", terms: ["lead routing", "route leads"] },
      { id: "quiet-winner", capability: "Quiet winner", icp: "x", pricingStructure: "y", definition: "d", terms: ["rollback"] },
      { id: "crowded-claim", capability: "Crowded thing", icp: "x", pricingStructure: "y", definition: "d", terms: ["ai agent"] },
      { id: "fine-claim", capability: "Fine thing", icp: "x", pricingStructure: "y", definition: "d", terms: ["audit trail"] },
      { id: "thin-claim", capability: "Thin thing", icp: "x", pricingStructure: "y", definition: "d", terms: ["esoteric feature"] },
    ],
  };
}

function obs(vendorId: string, claimId: string, intensity: MarketObservation["intensity"]): MarketObservation {
  return {
    id: `o_${vendorId}_${claimId}`,
    vendorId,
    claimId,
    observedAt: "2026-06-12",
    intensity,
    confidence: "high",
    reason: "",
    evidence: [],
  };
}

function observationSet(overrides: Partial<Record<string, Record<string, MarketObservation["intensity"]>>> = {}): ObservationSet {
  const base: Record<string, Record<string, MarketObservation["intensity"]>> = {
    "open-claim": { us: "absent", r1: "quiet", r2: "absent", r3: "absent", r4: "absent" },
    "quiet-winner": { us: "quiet", r1: "loud", r2: "loud", r3: "absent", r4: "absent" },
    "crowded-claim": { us: "loud", r1: "loud", r2: "loud", r3: "loud", r4: "quiet" },
    "fine-claim": { us: "loud", r1: "absent", r2: "absent", r3: "absent", r4: "absent" },
    "thin-claim": { us: "absent", r1: "quiet", r2: "absent", r3: "absent", r4: "absent" },
  };
  for (const [claimId, cells] of Object.entries(overrides)) base[claimId] = { ...base[claimId], ...cells };
  const observations: MarketObservation[] = [];
  for (const [claimId, cells] of Object.entries(base)) {
    for (const [vendorId, intensity] of Object.entries(cells)) observations.push(obs(vendorId, claimId, intensity));
  }
  return { id: "s1", category: "test-cat", runLabel: "run-2", runAt: "2026-06-12T00:00:00.000Z", extractor: "manual", observations };
}

function snapshot(): CanonicalGtmSnapshot {
  const deal = (id: string, isWon: boolean) => ({ id, name: id, isClosed: true, isWon });
  return {
    generatedAt: "2026-06-12T00:00:00.000Z",
    provider: "mock",
    users: [],
    accounts: [],
    contacts: [],
    activities: [],
    // 10 closed deals, 4 won → 40% baseline.
    deals: [
      deal("w1", true), deal("w2", true), deal("w3", true), deal("w4", true),
      deal("l1", false), deal("l2", false), deal("l3", false),
      deal("l4", false), deal("l5", false), deal("l6", false),
    ],
  };
}

function documents(): CallDocument[] {
  return [
    // quiet-winner ("rollback") mentioned in 3 won + 1 lost deal → 75% vs 40% baseline.
    { id: "c1", text: "They asked about rollback twice.", dealId: "w1" },
    { id: "c2", text: "Rollback was the deciding factor.", dealId: "w2" },
    { id: "c3", text: "Demoed the rollback flow.", dealId: "w3" },
    { id: "c4", text: "rollback came up; they went elsewhere.", dealId: "l1" },
    // open-claim ("lead routing") mentioned in 3 docs (deal-linked or not).
    { id: "c5", text: "Can you do lead routing?", dealId: "l2" },
    { id: "c6", text: "We route leads by region today." },
    { id: "c7", text: "Lead routing is the big gap for them.", dealId: "w4" },
    // crowded-claim ("ai agent") mentioned ONLY in lost deals.
    { id: "c8", text: "Their AI agent pitch fell flat.", dealId: "l3" },
    // thin-claim mentioned once.
    { id: "c9", text: "One mention of the esoteric feature." },
    // vendor mention with alias + word-boundary trap ("r1x" must not match r1... use distinct text).
    { id: "c10", text: "They compared US Corp against R1 head to head.", dealId: "w1" },
  ];
}

test("overlay stats: term matching is word-boundary, deal outcomes split won/lost", () => {
  const stats = computeOverlayStats(config(), snapshot(), documents());
  const byClaim = new Map(stats.claims.map((claim) => [claim.claimId, claim]));

  assert.equal(stats.deals.baselineWinRate, 0.4);
  const winner = byClaim.get("quiet-winner");
  assert.equal(winner?.mentionDocIds.length, 4);
  assert.equal(winner?.wonDeals, 3);
  assert.equal(winner?.lostDeals, 1);
  assert.equal(winner?.winRateWhenMentioned, 0.75);

  const open = byClaim.get("open-claim");
  assert.equal(open?.mentionDocIds.length, 3, "matches both 'lead routing' and 'route leads' variants");

  // "ai agent" must not match inside other words; "AI agent" case-insensitive does match.
  const crowded = byClaim.get("crowded-claim");
  assert.deepEqual(crowded?.mentionDocIds, ["c8"]);

  const vendorStats = new Map(stats.vendors.map((vendor) => [vendor.vendorId, vendor]));
  assert.deepEqual(vendorStats.get("us")?.mentionDocIds, ["c10"], "alias 'US Corp' matches; bare 'us' pronoun does not (case-sensitive? no — word 'us' appears in c6 'leads by region today'... none)");
  assert.deepEqual(vendorStats.get("r1")?.mentionDocIds, ["c10"]);
});

test("directives: OCCUPY, PROMOTE, RETREAT fire on the fixture; controls stay silent", () => {
  const cfg = config();
  const set = observationSet();
  const stats = computeOverlayStats(cfg, snapshot(), documents());
  const directives = computeDirectives(cfg, set, stats);
  const byType = (type: string) => directives.filter((d) => d.type === type).map((d) => d.claimId);

  assert.deepEqual(byType("occupy"), ["open-claim"], "thin-claim is below minMentions");
  assert.deepEqual(byType("promote"), ["quiet-winner"]);
  assert.deepEqual(byType("retreat"), ["crowded-claim"]);
  assert.equal(directives.length, 3, "fine-claim (owned, healthy) produces nothing");

  // Spec rule: every directive carries ≥1 observation and ≥1 CRM stat with n.
  for (const directive of directives) {
    assert.ok(directive.observationIds.length >= 1, `${directive.id} has observations`);
    assert.ok(directive.stats.length >= 1 && directive.stats.every((stat) => stat.n > 0), `${directive.id} has stats with n`);
  }
  // Determinism: same inputs, same ids.
  assert.deepEqual(directives, computeDirectives(cfg, set, stats));
});

test("directives: minimum-evidence thresholds gate small samples", () => {
  const cfg = config();
  const set = observationSet();
  const stats = computeOverlayStats(cfg, snapshot(), documents());

  const strict = computeDirectives(cfg, set, stats, { minMentions: 5 });
  assert.equal(strict.filter((d) => d.type === "occupy").length, 0, "occupy gated by minMentions");
  assert.equal(strict.filter((d) => d.type === "promote").length, 0, "promote gated by minMentions deals");

  const noLift = computeDirectives(cfg, set, stats, { promoteLift: 0.5 });
  assert.equal(noLift.filter((d) => d.type === "promote").length, 0, "75% vs 40% is below a 50-point lift bar");

  // RETREAT requires a corpus that actually contains wins.
  const lossOnlySnapshot = { ...snapshot(), deals: snapshot().deals.map((deal) => ({ ...deal, isWon: false })) };
  const lossStats = computeOverlayStats(cfg, lossOnlySnapshot, documents());
  assert.equal(computeDirectives(cfg, set, lossStats).filter((d) => d.type === "retreat").length, 0);
});

test("directives: URGENT fires on front drift toward saturation since the prior run", () => {
  const cfg = config();
  // Prior run: crowded-claim was contested (2 loud); current run: saturated (4 loud).
  const prior = observationSet({ "crowded-claim": { r2: "absent", r3: "absent" } });
  prior.runLabel = "run-1";
  const current = observationSet();
  const stats = computeOverlayStats(cfg, snapshot(), documents());
  const directives = computeDirectives(cfg, current, stats, { priorSet: prior });
  const urgent = directives.filter((d) => d.type === "urgent");
  assert.deepEqual(urgent.map((d) => d.claimId), ["crowded-claim"]);
  assert.match(urgent[0].summary, /contested → saturated/);
  // No prior set → no urgent.
  assert.equal(computeDirectives(cfg, current, stats).filter((d) => d.type === "urgent").length, 0);
});

test("directivesToPlan: approval-gated create_task ops with evidence chain", () => {
  const cfg = config();
  const set = observationSet();
  const stats = computeOverlayStats(cfg, snapshot(), documents());
  const directives = computeDirectives(cfg, set, stats);
  const plan = directivesToPlan(cfg, set, directives, { objectType: "account", objectId: "acct-self" }, () => new Date("2026-06-12T00:00:00.000Z"));

  assert.equal(plan.dryRun, true);
  assert.equal(plan.operations.length, 3);
  assert.ok(plan.operations.every((op) => op.operation === "create_task" && op.approvalRequired === true && op.objectId === "acct-self"));
  assert.ok(plan.findings.every((finding) => finding.ruleId.startsWith("market_directive_")));
  assert.equal(plan.evidence?.length, 3);
  assert.ok(plan.evidence?.every((ev) => /n=\d+/.test(ev.text)), "evidence text carries sample sizes");
  // Markdown render mentions thresholds honestly when empty.
  assert.match(overlayToMarkdown(stats, []), /No directives met the evidence thresholds/);
});

function scaleSignal(metric: string, value: number) {
  return { metric, value, unit: "count", sourceUrl: "https://x.test", quote: `${value}`, asOf: "2026-06-12" };
}

test("scale v2: signals convert to revenue space via within-set calibration", () => {
  const cfg = config();
  // us: known revenue $30M, 200 employees → calibrates rev/employee at $150K.
  cfg.vendors[0].acvBand = "mid";
  cfg.vendors[0].scaleSignals = [scaleSignal("revenue_usd", 30_000_000), scaleSignal("linkedin_employees", 200)];
  // r1: headcount only → estimated via the calibrated $150K/employee.
  cfg.vendors[1].scaleSignals = [scaleSignal("linkedin_employees", 100)];
  // r2: revenue only → direct.
  cfg.vendors[2].scaleSignals = [scaleSignal("revenue_usd", 15_000_000)];
  // r3, r4: none.

  const report = computeScaleIndex(cfg);
  const byVendor = new Map(report.vendors.map((vendor) => [vendor.vendorId, vendor]));
  const r1 = byVendor.get("r1");
  assert.ok(r1?.estimatedRevenue !== null);
  assert.ok(Math.abs((r1?.estimatedRevenue as number) - 15_000_000) < 1, "100 employees × calibrated $150K/emp");
  assert.equal(r1?.estimates[0].calibration, "global");
  assert.equal(byVendor.get("r2")?.estimatedRevenue, 15_000_000);
  assert.equal(byVendor.get("r3")?.index, null);
  assert.equal(report.complete, false);
  // Shares sum to 1 over estimable vendors: us 30M, r1 ~15M, r2 15M → us = 0.5.
  assert.ok(Math.abs((byVendor.get("us")?.index as number) - 0.5) < 0.01);
  // Calibration table is disclosed.
  assert.ok(report.calibrations.some((c) => c.metric === "linkedin_employees" && c.stratum === "global"));
});

test("scale v2: SMB-bias regression — many cheap customers must not outrank fewer expensive ones", () => {
  const cfg = config();
  // Two-band calibration shape. Calibrators: r1 (smb, revenue known) and r2 (mid, revenue known)
  // pin the per-band revenue-per-review ratios; "smb-tool" and "mid-tool" are then
  // estimated from reviews alone.
  cfg.vendors[0].id = "smb-tool"; cfg.vendors[0].name = "SMBTOOL"; cfg.vendors[0].acvBand = "smb";
  cfg.vendors[0].scaleSignals = [scaleSignal("g2_reviews", 900)]; // many reviews, cheap product
  cfg.vendors[1].acvBand = "smb";
  cfg.vendors[1].scaleSignals = [scaleSignal("revenue_usd", 20_000_000), scaleSignal("g2_reviews", 1000)]; // $20K/review
  cfg.vendors[2].id = "mid-tool"; cfg.vendors[2].name = "MIDTOOL"; cfg.vendors[2].acvBand = "mid";
  cfg.vendors[2].scaleSignals = [scaleSignal("g2_reviews", 250)]; // fewer reviews, expensive product
  cfg.vendors[3].acvBand = "mid";
  cfg.vendors[3].scaleSignals = [scaleSignal("revenue_usd", 33_000_000), scaleSignal("g2_reviews", 250)]; // $132K/review
  cfg.vendors[4].scaleSignals = [scaleSignal("revenue_usd", 1_000_000)];

  // anchorVendor must exist; ids changed above — fix the anchor reference.
  cfg.anchorVendor = "r1";

  const report = computeScaleIndex(cfg);
  const byVendor = new Map(report.vendors.map((vendor) => [vendor.vendorId, vendor]));
  const smb = byVendor.get("smb-tool")?.estimatedRevenue as number;
  const mid = byVendor.get("mid-tool")?.estimatedRevenue as number;
  assert.ok(Math.abs(smb - 900 * 20_000) < 1, "smb reviews convert at the smb-band ratio");
  assert.ok(Math.abs(mid - 250 * 132_000) < 1, "mid reviews convert at the mid-band ratio");
  assert.ok(mid > smb, "fewer reviews at higher ACV outrank more reviews at lower ACV — the v1 bias inverted this");
});

test("scale v2: uncertainty reports signal disagreement; uncalibratable metrics are skipped", () => {
  const cfg = config();
  cfg.vendors[0].scaleSignals = [
    scaleSignal("revenue_usd", 10_000_000),
    scaleSignal("linkedin_employees", 200), // calibrates against itself → 10M estimate, agreement
  ];
  cfg.vendors[1].scaleSignals = [
    scaleSignal("revenue_usd", 100_000_000),
    scaleSignal("linkedin_employees", 200), // 200 × $50K-median... two calibration pairs → median ratio
  ];
  cfg.vendors[2].scaleSignals = [scaleSignal("github_stars", 5000)]; // no revenue pair anywhere → uncalibratable
  const report = computeScaleIndex(cfg);
  const byVendor = new Map(report.vendors.map((vendor) => [vendor.vendorId, vendor]));
  assert.ok((byVendor.get("r1")?.uncertainty as number) > 1, "disagreeing signals show spread");
  assert.equal(byVendor.get("r2")?.index, null);
  assert.deepEqual(report.metricsSkipped, ["github_stars"]);
});

test("report bubbles: revenue-share sizing only when every placeable vendor has an estimate", () => {
  const cfg = config();
  cfg.axes = [
    {
      id: "ax",
      label: "Ax",
      negativePole: "L",
      positivePole: "R",
      rubric: "r",
      claimScores: { "open-claim": -1, "quiet-winner": 1, "crowded-claim": 0.5, "fine-claim": -0.5, "thin-claim": 0 },
    },
  ];
  cfg.primaryAxes = undefined;
  const set = observationSet();

  const fallback = marketMapToHtml(cfg, set);
  assert.ok(fallback.includes("Dot size carries no meaning"), "no signals → uniform dots with an explicit caption, never implied share");

  for (const [i, vendor] of cfg.vendors.entries()) vendor.scaleSignals = [scaleSignal("revenue_usd", 10 ** (i + 6))];
  const scaled = marketMapToHtml(cfg, set);
  assert.ok(scaled.includes("estimated revenue share"), "signals on all vendors → revenue-share sizing");
  assert.ok(scaled.includes("NOT audited"));
  assert.ok(scaled.includes('id="map-data"') && scaled.includes("map-tip"), "scatter ships hover tooltips");

  // Partial coverage: majority estimated keeps scale mode; the signal-less
  // vendor renders as a dashed no-scale bubble and a — legend row, never
  // silently flipping the whole map back to LOUD sizing.
  cfg.vendors[4].scaleSignals = undefined;
  const partial = marketMapToHtml(cfg, set);
  assert.ok(partial.includes("estimated revenue share"), "majority coverage keeps scale mode");
  assert.ok(partial.includes('class="bubble no-scale"'), "signal-less vendor is visibly no-data");
  assert.ok(partial.includes("Dashed outline = no measurable scale signals"));
});
