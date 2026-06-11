import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import {
  loadCaptureTexts,
  observationId,
  verifyEvidenceSpans,
  type CaptureEntry,
  type MarketConfig,
  type MarketObservation,
  type ObservationSet,
} from "../src/market.ts";
import { buildWorksheet, classifyMarket } from "../src/marketClassify.ts";

process.env.FSGTM_NO_BROWSER = "1";

const ACME_HOME_TEXT = "Acme — Ship faster\nThe hero claim: automated shipping for every team.\nPricing — $99/mo";
const ACME_DOCS_TEXT = "Docs\nBuried feature: carbon reporting is available on request.";

function config(): MarketConfig {
  return {
    category: "test-cat",
    anchorVendor: "acme",
    vendors: [
      { id: "acme", name: "Acme", urls: { home: "https://acme.test/", pricing: null, product: ["https://acme.test/docs"] } },
      { id: "ghost", name: "Ghost", urls: { home: "https://ghost.test/", pricing: null, product: [] } },
    ],
    claims: [
      { id: "auto-shipping", capability: "Automated shipping", icp: "smb", pricingStructure: "per-seat", definition: "LOUD if hero." },
      { id: "carbon-reporting", capability: "Carbon reporting", icp: "enterprise", pricingStructure: "platform-fee", definition: "LOUD if hero." },
    ],
    surfaceRule: "LOUD = hero; QUIET = below; ABSENT = nowhere; UNOBSERVABLE = failed capture.",
  };
}

/** Lay down a captures dir: manifest + content files. Returns the dir. */
function writeCaptures(dir: string) {
  mkdirSync(dir, { recursive: true });
  const entries: CaptureEntry[] = [
    { runLabel: "run-1", vendorId: "acme", kind: "home", url: "https://acme.test/", fetchedAt: "2026-06-11T00:00:00.000Z", httpStatus: 200, captureHash: "hash-acme-home", textChars: ACME_HOME_TEXT.length },
    { runLabel: "run-1", vendorId: "acme", kind: "product", url: "https://acme.test/docs", fetchedAt: "2026-06-11T00:00:00.000Z", httpStatus: 200, captureHash: "hash-acme-docs", textChars: ACME_DOCS_TEXT.length },
    { runLabel: "run-1", vendorId: "ghost", kind: "home", url: "https://ghost.test/", fetchedAt: "2026-06-11T00:00:00.000Z", httpStatus: 200, captureHash: null, textChars: 0 },
  ];
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(entries));
  writeFileSync(join(dir, "hash-acme-home.txt"), ACME_HOME_TEXT);
  writeFileSync(join(dir, "hash-acme-docs.txt"), ACME_DOCS_TEXT);
  return dir;
}

function obs(vendorId: string, claimId: string, quote: string | null, hash = "hash-acme-home"): MarketObservation {
  return {
    id: observationId("test-cat", "run-1", vendorId, claimId),
    vendorId,
    claimId,
    observedAt: "2026-06-11",
    intensity: quote ? "loud" : "absent",
    confidence: "high",
    reason: "test",
    evidence: quote
      ? [{ id: "ev1", sourceSystem: "web", sourceObjectType: "page", sourceObjectId: "https://acme.test/", text: quote, metadata: { url: "https://acme.test/", captureHash: hash } }]
      : [],
  };
}

const anthropicToolResponse = (input: unknown) =>
  new Response(JSON.stringify({ content: [{ type: "tool_use", input }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** Sequenced fetch mock that records request bodies. */
function mockLlm(responses: unknown[]) {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    const next = responses.shift();
    if (next === undefined) throw new Error("mock exhausted");
    return anthropicToolResponse(next);
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

test("verifyEvidenceSpans: verbatim and whitespace-normalized pass, everything else fails loudly", () => {
  const dir = writeCaptures(mkdtempSync(join(tmpdir(), "fsgtm-caps-")));
  const { textByHash } = loadCaptureTexts("test-cat", dir);

  assert.deepEqual(verifyEvidenceSpans([obs("acme", "auto-shipping", "automated shipping for every team.")], textByHash), []);
  // Whitespace differences are forgiven — the capture has a newline where the quote has a space.
  assert.deepEqual(
    verifyEvidenceSpans([obs("acme", "auto-shipping", "Ship faster The hero claim: automated shipping")], textByHash),
    [],
  );
  // Extraction artifact forgiven: line break before punctuation in the capture.
  assert.deepEqual(
    verifyEvidenceSpans([obs("acme", "auto-shipping", "automated shipping for every team .")], textByHash),
    [],
  );
  const paraphrased = verifyEvidenceSpans([obs("acme", "auto-shipping", "Acme automates your shipping")], textByHash);
  assert.equal(paraphrased.length, 1);
  assert.match(paraphrased[0].problem, /not found verbatim/);
  // A truncated quote with an invented sentence-ending period is NOT verbatim.
  assert.equal(verifyEvidenceSpans([obs("acme", "auto-shipping", "automated shipping for every. ")], textByHash).length, 1);

  const missingCapture = verifyEvidenceSpans([obs("acme", "auto-shipping", "anything", "hash-gone")], textByHash);
  assert.match(missingCapture[0].problem, /not found — evidence must stay resolvable/);

  const noHash = verifyEvidenceSpans([obs("acme", "auto-shipping", "anything", "")], textByHash);
  assert.match(noHash[0].problem, /no captureHash/);
});

test("classifyMarket: verified readings stored, capture-less vendors unobservable without an LLM call", async () => {
  const dir = writeCaptures(mkdtempSync(join(tmpdir(), "fsgtm-caps-")));
  const { fetchImpl, bodies } = mockLlm([
    {
      readings: [
        { claimId: "auto-shipping", intensity: "loud", confidence: "high", reason: "Hero claim.", evidence: [{ quote: "automated shipping for every team.", url: "https://acme.test/" }] },
        { claimId: "carbon-reporting", intensity: "quiet", confidence: "medium", reason: "Docs only.", evidence: [{ quote: "carbon reporting is available on request.", url: "https://acme.test/docs" }] },
      ],
    },
  ]);

  const result = await classifyMarket(config(), {
    llm: { provider: "anthropic", apiKey: "sk-ant-test", fetchImpl },
    runLabel: "run-1",
    capturesDir: dir,
    now: () => new Date("2026-06-11T00:00:00.000Z"),
  });

  assert.equal(bodies.length, 1, "ghost (no usable captures) must not consume an LLM call");
  assert.equal(result.set.extractor, "llm:anthropic:claude-haiku-4-5");
  assert.equal(result.set.observations.length, 4);
  const acmeCarbon = result.set.observations.find((o) => o.vendorId === "acme" && o.claimId === "carbon-reporting");
  assert.equal(acmeCarbon?.intensity, "quiet");
  // url → captureHash resolution from the manifest
  assert.equal(acmeCarbon?.evidence[0]?.metadata?.captureHash, "hash-acme-docs");
  const ghost = result.set.observations.filter((o) => o.vendorId === "ghost");
  assert.equal(ghost.length, 2);
  assert.ok(ghost.every((o) => o.intensity === "unobservable"));
  assert.deepEqual(result.retriedVendorIds, []);
});

test("classifyMarket: paraphrased quote bounces with feedback, verbatim retry passes", async () => {
  const dir = writeCaptures(mkdtempSync(join(tmpdir(), "fsgtm-caps-")));
  const good = {
    readings: [
      { claimId: "auto-shipping", intensity: "loud", confidence: "high", reason: "Hero.", evidence: [{ quote: "automated shipping for every team.", url: "https://acme.test/" }] },
      { claimId: "carbon-reporting", intensity: "absent", confidence: "high", reason: "Nowhere.", evidence: [] },
    ],
  };
  const bad = {
    readings: [
      { claimId: "auto-shipping", intensity: "loud", confidence: "high", reason: "Hero.", evidence: [{ quote: "Acme totally automates all shipping", url: "https://acme.test/" }] },
      good.readings[1],
    ],
  };
  const { fetchImpl, bodies } = mockLlm([bad, good]);

  const result = await classifyMarket(config(), {
    llm: { provider: "anthropic", apiKey: "sk-ant-test", fetchImpl },
    runLabel: "run-1",
    vendors: ["acme"],
    capturesDir: dir,
  });

  assert.deepEqual(result.retriedVendorIds, ["acme"]);
  assert.equal(bodies.length, 2);
  assert.match(bodies[1], /previous answer had problems/);
  assert.match(bodies[1], /not found verbatim/);
  assert.equal(result.set.observations.length, 2);
});

test("classifyMarket: persistent verification failure stores nothing and names the cells", async () => {
  const dir = writeCaptures(mkdtempSync(join(tmpdir(), "fsgtm-caps-")));
  const bad = {
    readings: [
      { claimId: "auto-shipping", intensity: "loud", confidence: "high", reason: "Hero.", evidence: [{ quote: "made-up quote", url: "https://acme.test/" }] },
      { claimId: "carbon-reporting", intensity: "absent", confidence: "high", reason: "Nowhere.", evidence: [] },
    ],
  };
  const { fetchImpl } = mockLlm([bad, bad]);
  await assert.rejects(
    classifyMarket(config(), {
      llm: { provider: "anthropic", apiKey: "sk-ant-test", fetchImpl },
      runLabel: "run-1",
      vendors: ["acme"],
      capturesDir: dir,
    }),
    /failed mechanical verification[\s\S]*auto-shipping/,
  );
});

test("classifyMarket: missing claims in the response trigger the retry", async () => {
  const dir = writeCaptures(mkdtempSync(join(tmpdir(), "fsgtm-caps-")));
  const partial = {
    readings: [
      { claimId: "auto-shipping", intensity: "loud", confidence: "high", reason: "Hero.", evidence: [{ quote: "automated shipping for every team.", url: "https://acme.test/" }] },
    ],
  };
  const full = {
    readings: [
      partial.readings[0],
      { claimId: "carbon-reporting", intensity: "absent", confidence: "high", reason: "Nowhere.", evidence: [] },
    ],
  };
  const { fetchImpl, bodies } = mockLlm([partial, full]);
  const result = await classifyMarket(config(), {
    llm: { provider: "anthropic", apiKey: "sk-ant-test", fetchImpl },
    runLabel: "run-1",
    vendors: ["acme"],
    capturesDir: dir,
  });
  assert.match(bodies[1], /missing reading for carbon-reporting/);
  assert.equal(result.set.observations.length, 2);
});

test("buildWorksheet carries claims, surface rule, and capture texts for one vendor", () => {
  const dir = writeCaptures(mkdtempSync(join(tmpdir(), "fsgtm-caps-")));
  const worksheet = buildWorksheet(config(), "acme", { capturesDir: dir });
  assert.equal(worksheet.vendor.id, "acme");
  assert.equal(worksheet.claims.length, 2);
  assert.equal(worksheet.pages.length, 2);
  assert.ok(worksheet.pages[0].text.includes("automated shipping"));
  assert.match(worksheet.instructions, /verbatim/);
  assert.throws(() => buildWorksheet(config(), "nobody", { capturesDir: dir }), /Unknown vendor/);
});

test("cli: market observe verifies spans against the profile captures (and --unverified skips)", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-home-"));
  const work = mkdtempSync(join(tmpdir(), "fsgtm-work-"));
  process.env.FSGTM_HOME = home;
  const cwd = process.cwd();
  process.chdir(work);
  const previousExitCode = process.exitCode;
  try {
    writeCaptures(join(home, "market", "test-cat", "captures"));
    writeFileSync(join(work, "market.config.json"), JSON.stringify(config()));
    const badSet: ObservationSet = {
      id: "s1",
      category: "test-cat",
      runLabel: "run-1",
      runAt: "2026-06-11T00:00:00.000Z",
      extractor: "manual",
      observations: [
        obs("acme", "auto-shipping", "a quote that is not on the page"),
        obs("acme", "carbon-reporting", null),
        obs("ghost", "auto-shipping", null),
        obs("ghost", "carbon-reporting", null),
      ],
    };
    writeFileSync(join(work, "bad.json"), JSON.stringify(badSet));
    await runCli(["market", "observe", "--from", "bad.json"]);
    assert.equal(process.exitCode, 1, "unverifiable quote must be rejected");
    assert.ok(!existsSync(join(home, "market", "test-cat", "observations", "run-1.json")));

    process.exitCode = previousExitCode;
    await runCli(["market", "observe", "--from", "bad.json", "--unverified"]);
    assert.ok(existsSync(join(home, "market", "test-cat", "observations", "run-1.json")));

    // A verbatim set passes the gate without the escape hatch.
    const goodSet: ObservationSet = {
      ...badSet,
      runLabel: "run-2",
      observations: [
        obs("acme", "auto-shipping", "automated shipping for every team."),
        badSet.observations[1],
        badSet.observations[2],
        badSet.observations[3],
      ],
    };
    writeFileSync(join(work, "good.json"), JSON.stringify(goodSet));
    await runCli(["market", "observe", "--from", "good.json"]);
    assert.ok(existsSync(join(home, "market", "test-cat", "observations", "run-2.json")));
  } finally {
    process.exitCode = previousExitCode;
    process.chdir(cwd);
    delete process.env.FSGTM_HOME;
  }
});

test("cli: market worksheet emits the per-vendor packet", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-home-"));
  const work = mkdtempSync(join(tmpdir(), "fsgtm-work-"));
  process.env.FSGTM_HOME = home;
  const cwd = process.cwd();
  process.chdir(work);
  try {
    writeCaptures(join(home, "market", "test-cat", "captures"));
    writeFileSync(join(work, "market.config.json"), JSON.stringify(config()));
    await runCli(["market", "worksheet", "--vendor", "acme", "--out", "ws.json"]);
    const worksheet = JSON.parse(String(await import("node:fs").then((fs) => fs.readFileSync(join(work, "ws.json"), "utf8"))));
    assert.equal(worksheet.vendor.id, "acme");
    assert.equal(worksheet.pages.length, 2);
  } finally {
    process.chdir(cwd);
    delete process.env.FSGTM_HOME;
  }
});
