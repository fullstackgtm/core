import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureMarket,
  createFileMarketStore,
  createMemoryMarketStore,
  type MarketConfig,
} from "../src/market.ts";
import { classifyMarket } from "../src/marketClassify.ts";
import { createProgressEmitter, MARKET_CAPTURE_STAGES, type ProgressEvent } from "../src/progress.ts";

/**
 * The MarketStore seam: the file store and the in-memory store are two
 * implementations of one contract, and captureMarket/classifyMarket behave
 * identically through either. The file store must preserve the pre-seam
 * on-disk layout exactly (manifest.json + <hash>.txt), which the CLI and the
 * older tests depend on.
 */

const HOME_HTML = "<h1>Acme hero</h1><p>automated shipping for every team.</p>";

function config(): MarketConfig {
  return {
    category: "seam-cat",
    vendors: [
      { id: "acme", name: "Acme", urls: { home: "https://acme.test/", pricing: null, product: [] } },
      { id: "ghost", name: "Ghost", urls: { home: "https://ghost.test/", pricing: null, product: [] } },
    ],
    claims: [
      { id: "auto-shipping", capability: "Automated shipping", icp: "smb", pricingStructure: "per-seat", definition: "LOUD if hero." },
    ],
  };
}

const fetchPage = async (url: string) =>
  url === "https://acme.test/" ? { status: 200, body: HOME_HTML } : { status: 404, body: "" };

test("captureMarket through the file store preserves the on-disk layout (manifest + hash files)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-seam-file-"));
  const store = createFileMarketStore("seam-cat", { capturesDir: dir });
  const result = await captureMarket(config(), { store, runLabel: "run-1", fetchPage });
  assert.equal(result.manifestPath, join(dir, "manifest.json"));
  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  assert.equal(manifest.length, 2);
  const acme = result.entries.find((entry) => entry.vendorId === "acme");
  assert.ok(acme?.captureHash);
  assert.ok(existsSync(join(dir, `${acme?.captureHash}.txt`)));
  // Second run appends to the manifest instead of rewriting history.
  await captureMarket(config(), { store, runLabel: "run-2", fetchPage });
  assert.equal(JSON.parse(readFileSync(result.manifestPath, "utf8")).length, 4);
});

test("memory store round-trips captures and classifies with the same evidence gate", async () => {
  const store = createMemoryMarketStore("seam-cat");
  await captureMarket(config(), { store, runLabel: "run-1", fetchPage });
  const { entries, textByHash } = await store.loadCaptureTexts();
  assert.equal(entries.length, 2);
  assert.equal([...textByHash.values()][0].includes("automated shipping"), true);

  const good = {
    readings: [
      { claimId: "auto-shipping", intensity: "loud", confidence: "high", reason: "Hero.", evidence: [{ quote: "automated shipping for every team.", url: "https://acme.test/" }] },
    ],
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ content: [{ type: "tool_use", input: good }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  const result = await classifyMarket(config(), {
    llm: { provider: "anthropic", apiKey: "sk-ant-test", fetchImpl },
    runLabel: "run-1",
    store,
  });
  assert.equal(result.set.observations.length, 2);
  const ghost = result.set.observations.find((obs) => obs.vendorId === "ghost");
  assert.equal(ghost?.intensity, "unobservable");

  await store.observations.append(result.set);
  await assert.rejects(store.observations.append(result.set), /append-only/);
  assert.equal((await store.observations.latest())?.runLabel, "run-1");
});

test("capture + classify emit the shared MARKET_CAPTURE_STAGES progress vocabulary", async () => {
  const store = createMemoryMarketStore("seam-cat");
  const events: ProgressEvent[] = [];
  const progress = createProgressEmitter((event) => events.push(event), { throttleMs: 0 });
  await captureMarket(config(), { store, runLabel: "run-1", fetchPage, progress });
  const stages = events.filter((event) => event.kind === "stage").map((event) => (event as { stage: string }).stage);
  assert.deepEqual(stages, [MARKET_CAPTURE_STAGES[0], MARKET_CAPTURE_STAGES[1], MARKET_CAPTURE_STAGES[3]]);
  const items = events.filter((event) => event.kind === "items") as Array<{ done: number; total?: number }>;
  assert.deepEqual(items.map((event) => event.done), [1, 2]);
  assert.ok(items.every((event) => event.total === 2));

  const good = {
    readings: [
      { claimId: "auto-shipping", intensity: "loud", confidence: "high", reason: "Hero.", evidence: [{ quote: "automated shipping for every team.", url: "https://acme.test/" }] },
    ],
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ content: [{ type: "tool_use", input: good }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  const classifyEvents: ProgressEvent[] = [];
  await classifyMarket(config(), {
    llm: { provider: "anthropic", apiKey: "sk-ant-test", fetchImpl },
    runLabel: "run-2",
    store,
    progress: createProgressEmitter((event) => classifyEvents.push(event), { throttleMs: 0 }),
  });
  const classifyStages = classifyEvents.filter((event) => event.kind === "stage").map((event) => (event as { stage: string }).stage);
  assert.deepEqual(classifyStages, [MARKET_CAPTURE_STAGES[2]]);
  const classifyItems = classifyEvents.filter((event) => event.kind === "items") as Array<{ done: number }>;
  assert.deepEqual(classifyItems.map((event) => event.done), [1, 2]);
});
