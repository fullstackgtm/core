import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import {
  createFileObservationStore,
  parseMarketConfig,
  type MarketConfig,
  type MarketObservation,
  type ObservationSet,
} from "../src/market.ts";
import {
  assessAxes,
  axesReportToText,
  axisPosition,
  messageBreadth,
  pcaTop2,
  pearson,
} from "../src/marketAxes.ts";
import { marketMapToHtml } from "../src/marketReport.ts";

process.env.FSGTM_NO_BROWSER = "1";

/** The 280-cell creative-intelligence validation dataset — the golden regression. */
const GOLDEN = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "marketCreativeIntel.json"), "utf8")) as {
  config: MarketConfig;
  set: ObservationSet;
};

function obs(vendorId: string, claimId: string, intensity: MarketObservation["intensity"]): MarketObservation {
  return {
    id: `o_${vendorId}_${claimId}`,
    vendorId,
    claimId,
    observedAt: "2026-06-11",
    intensity,
    confidence: "high",
    reason: "",
    evidence: [],
  };
}

test("axisPosition: intensity-weighted mean, null scores excluded, null when nothing voiced", () => {
  const observations = [
    obs("v1", "a", "loud"), // score +1, weight 1
    obs("v1", "b", "quiet"), // score -1, weight 0.5
    obs("v1", "c", "loud"), // score null — excluded entirely
    obs("v1", "d", "absent"), // weight 0 — excluded
    obs("v2", "a", "absent"),
  ];
  const scores = { a: 1, b: -1, c: null, d: 1 };
  const position = axisPosition("v1", scores, observations);
  assert.ok(position !== null);
  assert.ok(Math.abs(position - (1 * 1 + -1 * 0.5) / 1.5) < 1e-9);
  assert.equal(axisPosition("v2", scores, observations), null, "vendor voicing nothing scoreable has no position");
});

test("messageBreadth: voiced share over observable claims, unobservable excluded", () => {
  const observations = [obs("v1", "a", "loud"), obs("v1", "b", "quiet"), obs("v1", "c", "absent"), obs("v1", "d", "unobservable")];
  const { breadth, loudCount } = messageBreadth("v1", observations);
  assert.ok(breadth !== null && Math.abs(breadth - 1.5 / 3) < 1e-9);
  assert.equal(loudCount, 1);
});

test("pcaTop2 separates two synthetic vendor blocs on PC1", () => {
  const claims = ["c1", "c2", "c3", "c4", "c5", "c6"].map((id) => ({
    id,
    capability: id,
    icp: "x",
    pricingStructure: "y",
    definition: "d",
  }));
  const vendors = ["v1", "v2", "v3", "v4", "v5", "v6"].map((id) => ({
    id,
    name: id,
    urls: { home: `https://${id}.test/`, pricing: null, product: [] },
  }));
  const config: MarketConfig = { category: "synth", vendors, claims };
  const observations: MarketObservation[] = [];
  for (const vendor of vendors) {
    const blocA = ["v1", "v2", "v3"].includes(vendor.id);
    for (const claim of claims) {
      const claimInA = ["c1", "c2", "c3"].includes(claim.id);
      observations.push(obs(vendor.id, claim.id, blocA === claimInA ? "loud" : "absent"));
    }
  }
  const set: ObservationSet = { id: "s", category: "synth", runLabel: "run-1", runAt: "", extractor: "manual", observations };
  const { pc1 } = pcaTop2(config, set);
  const scoreOf = new Map(pc1.scores.map((entry) => [entry.vendorId, entry.score]));
  const blocAScores = ["v1", "v2", "v3"].map((v) => scoreOf.get(v) as number);
  const blocBScores = ["v4", "v5", "v6"].map((v) => scoreOf.get(v) as number);
  // Sign is arbitrary; the blocs must land on opposite sides with a real gap.
  assert.ok(blocAScores.every((s) => s * blocBScores[0] < 0), "blocs separate in sign");
  assert.ok(Math.abs(blocAScores[0] - blocBScores[0]) > 0.5, "blocs separate in magnitude");
  // Within-bloc scores are equal by symmetry.
  assert.ok(Math.abs(blocAScores[0] - blocAScores[2]) < 1e-6);
});

test("GOLDEN creative-intelligence: PCA recovers buyer as PC1 and value-mode as PC2", () => {
  const report = assessAxes(GOLDEN.config, GOLDEN.set);
  const byId = new Map(report.assessments.map((assessment) => [assessment.axis.id, assessment]));

  const buyer = byId.get("buyer");
  const valueMode = byId.get("value-mode");
  assert.ok(buyer && valueMode);
  // Measured on the prototype: buyer↔PC1 r=+0.96, value-mode↔PC2 r=+0.93 (signs arbitrary).
  assert.ok(Math.abs(buyer.rVsPc1) >= 0.9, `buyer should be PC1 (got ${buyer.rVsPc1.toFixed(2)})`);
  assert.ok(Math.abs(valueMode.rVsPc2) >= 0.85, `value-mode should be PC2 (got ${valueMode.rVsPc2.toFixed(2)})`);
  assert.ok(buyer.spread >= 0.25, "buyer axis separates vendors");

  // The orthogonality screen: buyer × value-mode is the working pair;
  // buyer × operating-model was the documented redundancy finding (r≈0.97).
  const pair = (a: string, b: string) =>
    report.pairings.find((p) => (p.aId === a && p.bId === b) || (p.aId === b && p.bId === a));
  assert.ok(Math.abs(pair("buyer", "value-mode")?.r ?? 1) < 0.4, "primary pair is near-orthogonal");
  assert.equal(pair("buyer", "operating-model")?.verdict, "redundant — same axis twice");

  // DAIVID is fully unobservable in this dataset and must be excluded, not zeroed.
  assert.ok(!report.vendors.includes("daivid"));

  // The text report renders deterministically.
  const text = axesReportToText(report);
  assert.equal(text, axesReportToText(assessAxes(GOLDEN.config, GOLDEN.set)));
  assert.match(text, /PC1 — claim loadings/);
  assert.match(text, /orthogonality screen/);
});

test("config validation: axis scoring unknown claims and bad primaryAxes are rejected", () => {
  const bad = JSON.parse(JSON.stringify(GOLDEN.config)) as MarketConfig;
  (bad.axes as NonNullable<MarketConfig["axes"]>)[0].claimScores["not-a-claim"] = 1;
  assert.throws(() => parseMarketConfig(JSON.stringify(bad)), /scores unknown claim/);

  const badPrimary = JSON.parse(JSON.stringify(GOLDEN.config)) as MarketConfig;
  badPrimary.primaryAxes = ["buyer", "nope"] as [string, string];
  assert.throws(() => parseMarketConfig(JSON.stringify(badPrimary)), /primaryAxes/);

  // Pole-less axes used to validate everywhere and then crash only the HTML
  // renderer (escapeHtml(undefined)) — fail at parse time instead.
  const poleless = JSON.parse(JSON.stringify(GOLDEN.config)) as MarketConfig;
  (poleless.axes as NonNullable<MarketConfig["axes"]>)[0].positivePole = "";
  assert.throws(() => parseMarketConfig(JSON.stringify(poleless)), /negativePole and positivePole/);
});

test("market <sub> --help prints usage without executing; audit --help no longer runs the sample audit", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-home-help-"));
  const work = mkdtempSync(join(tmpdir(), "fsgtm-work-help-"));
  process.env.FSGTM_HOME = home;
  const cwd = process.cwd();
  process.chdir(work); // deliberately no market.config.json: execution would throw, capture would fetch
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg: unknown) => logs.push(String(msg));
  try {
    await runCli(["market", "capture", "--help"]);
    await runCli(["market", "axes", "--help"]);
    await runCli(["market", "classify", "--help"]); // used to demand a key first
    assert.equal(logs.length, 3);
    for (const line of logs) assert.match(line, /market capture \[--config/);

    logs.length = 0;
    await runCli(["audit", "--help"]);
    assert.match(logs.join("\n"), /Usage/i);
    assert.doesNotMatch(logs.join("\n"), /\d+ finding/i, "audit --help must not run the sample audit");
  } finally {
    console.log = origLog;
    process.chdir(cwd);
    delete process.env.FSGTM_HOME;
  }
});

test("report renders the strategic map (and only that — no axis lab) when axes are configured", () => {
  const html = marketMapToHtml(GOLDEN.config, GOLDEN.set);
  assert.ok(html.includes("Strategic map"));
  // Best foot forward: the client-facing report carries one earned 2x2.
  // Axis exploration (pairings, verdicts) lives in `market axes`, not here.
  assert.ok(!html.includes("Axis lab"));
  assert.ok(html.includes("<h2>Evidence appendix</h2>"));
  assert.ok(html.includes("table class=\"legend\""), "scatter ships a numbered color legend");
  assert.equal(html, marketMapToHtml(GOLDEN.config, GOLDEN.set), "deterministic bytes");

  const noAxes = { ...GOLDEN.config, axes: undefined, primaryAxes: undefined };
  const plain = marketMapToHtml(noAxes, GOLDEN.set);
  assert.ok(!plain.includes("Strategic map"));
  assert.ok(plain.includes("<h2>Evidence appendix</h2>"));
});

test("pearson basics", () => {
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-9);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), 0, "zero variance is not a correlation");
});

test("cli: market axes prints the discovery report from the store", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-home-"));
  const work = mkdtempSync(join(tmpdir(), "fsgtm-work-"));
  process.env.FSGTM_HOME = home;
  const cwd = process.cwd();
  process.chdir(work);
  try {
    writeFileSync(join(work, "market.config.json"), JSON.stringify(GOLDEN.config));
    await createFileObservationStore(GOLDEN.config.category).append(GOLDEN.set);
    await runCli(["market", "axes"]);
    await runCli(["market", "axes", "--json"]);
  } finally {
    process.chdir(cwd);
    delete process.env.FSGTM_HOME;
  }
});
