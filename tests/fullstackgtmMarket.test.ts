import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import {
  captureMarket,
  computeFrontStates,
  createFileObservationStore,
  diffFrontStates,
  extractReadableText,
  observationId,
  parseMarketConfig,
  validateObservationSet,
  type MarketConfig,
  type MarketObservation,
  type ObservationSet,
} from "../src/market.ts";
import { marketMapToHtml, marketMapToMarkdown } from "../src/marketReport.ts";

function config(overrides: Partial<MarketConfig> = {}): MarketConfig {
  return {
    category: "test-category",
    anchorVendor: "acme",
    vendors: [
      { id: "acme", name: "Acme", urls: { home: "https://acme.test/", pricing: "https://acme.test/pricing", product: [] } },
      { id: "globex", name: "Globex", urls: { home: "https://globex.test/", pricing: null, product: ["https://globex.test/product"] } },
      { id: "initech", name: "Initech", urls: { home: "https://initech.test/", pricing: null, product: [] } },
      { id: "umbrella", name: "Umbrella", urls: { home: "https://umbrella.test/", pricing: null, product: [] } },
      { id: "hooli", name: "Hooli", urls: { home: "https://hooli.test/", pricing: null, product: [] } },
    ],
    claims: [
      { id: "claim-a", capability: "Capability A: the loud one", icp: "enterprise", pricingStructure: "platform-fee", definition: "LOUD if hero." },
      { id: "claim-b", capability: "Capability B", icp: "smb", pricingStructure: "per-seat", definition: "LOUD if hero." },
      { id: "claim-c", capability: "Capability C", icp: "smb", pricingStructure: "per-seat", definition: "LOUD if hero." },
      { id: "claim-d", capability: "Capability D", icp: "smb", pricingStructure: "per-seat", definition: "LOUD if hero." },
      { id: "claim-e", capability: "Capability E", icp: "smb", pricingStructure: "per-seat", definition: "LOUD if hero." },
    ],
    ...overrides,
  };
}

function observation(
  vendorId: string,
  claimId: string,
  intensity: MarketObservation["intensity"],
  quote?: string,
): MarketObservation {
  return {
    id: observationId("test-category", "run-1", vendorId, claimId),
    vendorId,
    claimId,
    observedAt: "2026-06-11",
    intensity,
    confidence: "high",
    reason: `${vendorId} reads ${intensity} on ${claimId}`,
    evidence:
      intensity === "loud" || intensity === "quiet"
        ? [
            {
              id: `ev_${vendorId}_${claimId}`,
              sourceSystem: "web",
              sourceObjectType: "page",
              sourceObjectId: `https://${vendorId}.test/`,
              text: quote ?? `${vendorId} says <${claimId}> & more`,
              metadata: { url: `https://${vendorId}.test/`, captureHash: "abc123def456" },
            },
          ]
        : [],
  };
}

/**
 * Front fixtures: claim-a 1 loud (owned by acme), claim-b 4 loud (saturated),
 * claim-c 2 loud (contested), claim-d 0 loud 1 quiet (open), claim-e nothing
 * voiced (vacant) — with one unobservable cell proving a failed capture never
 * counts as absence.
 */
function fullSet(): ObservationSet {
  const vendors = ["acme", "globex", "initech", "umbrella", "hooli"];
  const loudOn: Record<string, string[]> = {
    "claim-a": ["acme"],
    "claim-b": ["acme", "globex", "initech", "umbrella"],
    "claim-c": ["globex", "initech"],
    "claim-d": [],
    "claim-e": [],
  };
  const observations: MarketObservation[] = [];
  for (const claimId of Object.keys(loudOn)) {
    for (const vendorId of vendors) {
      let intensity: MarketObservation["intensity"] = loudOn[claimId].includes(vendorId) ? "loud" : "absent";
      if (claimId === "claim-d" && vendorId === "hooli") intensity = "quiet";
      if (claimId === "claim-e" && vendorId === "umbrella") intensity = "unobservable";
      observations.push(observation(vendorId, claimId, intensity));
    }
  }
  return {
    id: "set_run1",
    category: "test-category",
    runLabel: "run-1",
    runAt: "2026-06-11T00:00:00.000Z",
    extractor: "manual",
    observations,
  };
}

test("extractReadableText strips markup, scripts, and entities", () => {
  const html = `<html><head><title>nope</title></head><body>
    <script>var hidden = "should not appear";</script>
    <style>.x { color: red }</style>
    <h1>Creative &amp; Bold</h1><p>Ship more winning ads</p>
    <div>Pricing &mdash; $250/mo</div></body></html>`;
  const text = extractReadableText(html);
  assert.ok(!text.includes("hidden"));
  assert.ok(!text.includes("color: red"));
  assert.ok(!text.includes("nope"), "head content is stripped");
  assert.ok(text.includes("Creative & Bold"));
  assert.ok(text.includes("Pricing — $250/mo"));
  assert.ok(text.indexOf("Creative & Bold") < text.indexOf("Ship more winning ads"));
});

test("captureMarket content-addresses captures and records failures honestly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-market-"));
  const pages: Record<string, { status: number; body: string }> = {
    "https://acme.test/": { status: 200, body: "<h1>Same body</h1>" },
    "https://acme.test/pricing": { status: 200, body: "<h1>Same body</h1>" },
    "https://globex.test/": { status: 404, body: "" },
    "https://globex.test/product": { status: 200, body: "<script>x</script>" },
  };
  const twoVendors = config({
    vendors: config().vendors.slice(0, 2),
    claims: config().claims.slice(0, 1),
  });
  const result = await captureMarket(twoVendors, {
    dir,
    runLabel: "run-1",
    fetchPage: async (url) => pages[url] ?? { status: 500, body: "" },
    now: () => new Date("2026-06-11T00:00:00.000Z"),
  });

  assert.equal(result.entries.length, 4);
  const [acmeHome, acmePricing, globexHome, globexProduct] = result.entries;
  // Identical extracted text dedupes to the same content hash (the change detector).
  assert.equal(acmeHome.captureHash, acmePricing.captureHash);
  assert.ok(acmeHome.captureHash);
  assert.ok(existsSync(join(dir, `${acmeHome.captureHash}.txt`)));
  // A 404 and a script-only page both yield no capture — null hash, never a fake one.
  assert.equal(globexHome.captureHash, null);
  assert.equal(globexHome.httpStatus, 404);
  assert.equal(globexProduct.captureHash, null);
  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  assert.equal(manifest.length, 4);
});

test("parseMarketConfig rejects structural problems", () => {
  assert.throws(() => parseMarketConfig(JSON.stringify({ category: "x", vendors: [], claims: [] })), /at least one vendor/);
  const dupClaims = config();
  dupClaims.claims[1] = { ...dupClaims.claims[1], id: "claim-a" };
  assert.throws(() => parseMarketConfig(JSON.stringify(dupClaims)), /duplicate claim id/);
  assert.throws(() => parseMarketConfig(JSON.stringify(config({ anchorVendor: "nobody" }))), /anchorVendor/);
});

test("validateObservationSet enforces coverage and the verbatim-evidence rule", () => {
  const set = fullSet();
  assert.deepEqual(validateObservationSet(config(), set), []);

  const missingOne = { ...set, observations: set.observations.slice(1) };
  assert.ok(validateObservationSet(config(), missingOne).some((p) => p.includes("missing observation")));

  const loudWithoutEvidence = {
    ...set,
    observations: set.observations.map((obs) =>
      obs.vendorId === "acme" && obs.claimId === "claim-a" ? { ...obs, evidence: [] } : obs,
    ),
  };
  assert.ok(
    validateObservationSet(config(), loudWithoutEvidence).some((p) => p.includes("no quoted evidence")),
  );

  const unknownVendor = {
    ...set,
    observations: [...set.observations, observation("intruder", "claim-a", "absent")],
  };
  assert.ok(validateObservationSet(config(), unknownVendor).some((p) => p.includes('unknown vendor "intruder"')));
});

test("observation store is append-only and profile-shaped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-obs-"));
  const store = createFileObservationStore("test-category", dir);
  const set = fullSet();
  await store.append(set);
  assert.equal((await store.get("run-1"))?.observations.length, set.observations.length);
  await assert.rejects(store.append(set), /append-only/);
  await assert.rejects(
    store.append({ ...set, runLabel: "run-2", category: "other" }),
    /does not match store/,
  );
  await store.append({ ...set, runLabel: "run-2", runAt: "2026-06-18T00:00:00.000Z" });
  assert.equal((await store.latest())?.runLabel, "run-2");
  assert.equal((await store.list()).length, 2);
});

test("front rule v1: owned / saturated / contested / open / vacant, unobservable excluded", () => {
  const fronts = computeFrontStates(config(), fullSet());
  const byClaim = new Map(fronts.map((front) => [front.claimId, front]));
  assert.equal(byClaim.get("claim-a")?.state, "owned");
  assert.deepEqual(byClaim.get("claim-a")?.loudVendorIds, ["acme"]);
  assert.equal(byClaim.get("claim-b")?.state, "saturated");
  assert.equal(byClaim.get("claim-c")?.state, "contested");
  assert.equal(byClaim.get("claim-d")?.state, "open");
  // claim-e has an unobservable cell and no voice — vacant, not influenced by the failed capture.
  assert.equal(byClaim.get("claim-e")?.state, "vacant");
});

test("diffFrontStates reports only changed claims", () => {
  const before = computeFrontStates(config(), fullSet());
  const evolved = fullSet();
  for (const obs of evolved.observations) {
    if (obs.claimId === "claim-d" && obs.vendorId === "hooli") obs.intensity = "loud";
    if (obs.claimId === "claim-d" && obs.vendorId === "hooli") {
      obs.evidence = observation("hooli", "claim-d", "loud").evidence;
    }
  }
  const drift = diffFrontStates(before, computeFrontStates(config(), evolved));
  assert.deepEqual(drift, [{ claimId: "claim-d", before: "open", after: "owned" }]);
});

test("report renders deterministically with matrix, fronts, and quoted evidence", () => {
  const markdown = marketMapToMarkdown(config(), fullSet());
  assert.ok(markdown.includes("# Market map — test-category (run-1)"));
  assert.ok(markdown.includes("OWNED: claim-a → acme"));
  assert.ok(markdown.includes("OPEN: claim-d"));

  const html = marketMapToHtml(config(), fullSet());
  assert.equal(html, marketMapToHtml(config(), fullSet()), "same observations render the same bytes");
  assert.ok(html.includes("Market map — "), "plain analyst header, no dossier theatrics");
  assert.ok(html.includes("g-unobservable"), "failed captures render as hatched, not absent");
  // Verbatim quotes survive into the appendix, escaped.
  assert.ok(html.includes("acme says &lt;claim-a&gt; &amp; more"));
  assert.ok(!html.includes("<claim-a> & more"), "evidence is HTML-escaped");
  assert.ok(html.indexOf("Open ground") < html.indexOf("Saturated fronts"), "open-front group renders before saturated");
  assert.ok(html.includes("Where to attack"), "report closes on the takeaway");
  assert.ok(!html.includes("${"), "no unrendered template placeholders leak into the HTML");
  assert.ok(html.includes("<h2>Market Claims</h2>"));
  assert.ok(html.match(/<details class="claim-group">[\s\S]*?<th class="vh"><span>Globex<\/span><\/th>/), "expanded claim groups carry the vendor header row");
});

test("cli: market init, observe, fronts, report round-trip", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-home-"));
  const work = mkdtempSync(join(tmpdir(), "fsgtm-work-"));
  process.env.FSGTM_HOME = home;
  const cwd = process.cwd();
  process.chdir(work);
  try {
    await runCli(["market", "init", "--category", "test-category"]);
    assert.ok(existsSync(join(work, "market.config.json")));
    // init refuses to clobber
    await assert.rejects(runCli(["market", "init", "--category", "test-category"]), /refusing to overwrite/);

    writeFileSync(join(work, "market.config.json"), `${JSON.stringify(config(), null, 2)}\n`);
    writeFileSync(join(work, "observations.json"), JSON.stringify(fullSet()));
    // The fixture set cites captures that don't exist in this empty profile home;
    // span verification has its own tests — this one exercises the round-trip.
    await runCli(["market", "observe", "--from", "observations.json", "--unverified"]);
    assert.ok(existsSync(join(home, "market", "test-category", "observations", "run-1.json")));

    await runCli(["market", "fronts", "--json"]);
    await runCli(["market", "report", "--format", "html", "--out", "map.html"]);
    const html = readFileSync(join(work, "map.html"), "utf8");
    assert.ok(html.includes("test category"));
  } finally {
    process.chdir(cwd);
    delete process.env.FSGTM_HOME;
  }
});

test("cli: market observe rejects invalid sets without writing", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-home-"));
  const work = mkdtempSync(join(tmpdir(), "fsgtm-work-"));
  process.env.FSGTM_HOME = home;
  const cwd = process.cwd();
  process.chdir(work);
  const previousExitCode = process.exitCode;
  try {
    writeFileSync(join(work, "market.config.json"), `${JSON.stringify(config(), null, 2)}\n`);
    const bad = fullSet();
    bad.observations = bad.observations.slice(5);
    writeFileSync(join(work, "bad.json"), JSON.stringify(bad));
    await runCli(["market", "observe", "--from", "bad.json"]);
    assert.equal(process.exitCode, 1);
    assert.ok(!existsSync(join(home, "market", "test-category", "observations", "run-1.json")));
  } finally {
    process.exitCode = previousExitCode;
    process.chdir(cwd);
    delete process.env.FSGTM_HOME;
  }
});
