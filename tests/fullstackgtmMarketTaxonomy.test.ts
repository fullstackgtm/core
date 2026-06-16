import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FetchPage } from "../src/market.ts";
import { suggestMarketConfig } from "../src/marketTaxonomy.ts";

const ACME_HTML =
  "<html><body><h1>Acme — automated shipping for every team</h1><p>Usage-based pricing for SMBs.</p></body></html>";
const BOLT_HTML =
  "<html><body><h1>Bolt — carbon reporting built in</h1><p>Enterprise platform fee.</p></body></html>";

const pages: Record<string, string> = {
  "https://acme.test/": ACME_HTML,
  "https://www.bolt.test/": BOLT_HTML,
};
const fetchPage: FetchPage = async (url) => ({ status: pages[url] ? 200 : 404, body: pages[url] ?? "" });

const anthropicToolResponse = (input: unknown) =>
  new Response(JSON.stringify({ content: [{ type: "tool_use", input }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

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

const TAXONOMY = {
  surfaceRule: "LOUD = hero; QUIET = below the fold; ABSENT = nowhere.",
  claims: [
    {
      capability: "Automated shipping",
      icp: "smb",
      pricingStructure: "usage-based",
      definition: "LOUD if shipping automation is hero copy; QUIET if only on a deeper page; ABSENT if nowhere.",
      terms: ["automated shipping", "ship faster"],
    },
    {
      capability: "Carbon reporting",
      icp: "enterprise",
      pricingStructure: "platform-fee",
      definition: "LOUD if carbon reporting is named in hero/nav; QUIET if buried; ABSENT if nowhere.",
      terms: ["carbon reporting"],
    },
  ],
  vendors: [
    { seedUrl: "https://acme.test/", name: "Acme Inc.", pricingUrl: "https://acme.test/pricing" },
    { seedUrl: "https://www.bolt.test/", name: "Bolt", pricingUrl: "not-a-url" },
  ],
};

test("suggestMarketConfig: assembles a full config from seed captures + proposed taxonomy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-tax-"));
  const { fetchImpl, bodies } = mockLlm([TAXONOMY]);

  const { config, unreadableVendorIds, model } = await suggestMarketConfig({
    category: "shipping-software",
    vendors: [
      { url: "https://acme.test/", anchor: true },
      { url: "https://www.bolt.test/" },
    ],
    llm: { provider: "anthropic", apiKey: "sk-ant-test", fetchImpl },
    fetchPage,
    capturesDir: dir,
    now: () => new Date("2026-06-15T00:00:00.000Z"),
  });

  // Grounding: the proposer prompt carried the captured page text, not raw HTML.
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /automated shipping for every team/);
  assert.doesNotMatch(bodies[0], /<h1>/, "raw HTML must be stripped before grounding");

  assert.equal(config.category, "shipping-software");
  assert.equal(unreadableVendorIds.length, 0);
  assert.equal(model, "claude-haiku-4-5");

  // Vendor ids derived from the host's second-level domain; www stripped.
  assert.deepEqual(config.vendors.map((v) => v.id), ["acme", "bolt"]);
  // Anchor recorded.
  assert.equal(config.anchorVendor, "acme");
  // Refinements applied: clean name + valid pricing URL; the bad pricing URL is ignored.
  assert.equal(config.vendors[0].name, "Acme Inc.");
  assert.equal(config.vendors[0].urls.pricing, "https://acme.test/pricing");
  assert.equal(config.vendors[1].urls.pricing, null);

  // Claims: slug ids, required fields, terms carried.
  assert.deepEqual(config.claims.map((c) => c.id), ["automated-shipping", "carbon-reporting"]);
  assert.equal(config.claims[0].icp, "smb");
  assert.ok(config.claims[0].definition.length > 0);
  assert.deepEqual(config.claims[0].terms, ["automated shipping", "ship faster"]);
  assert.equal(config.surfaceRule, "LOUD = hero; QUIET = below the fold; ABSENT = nowhere.");
});

test("suggestMarketConfig: caps proposed claims at maxClaims", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-tax-"));
  const { fetchImpl } = mockLlm([TAXONOMY]);
  const { config } = await suggestMarketConfig({
    category: "shipping-software",
    vendors: [{ url: "https://acme.test/" }],
    llm: { provider: "anthropic", apiKey: "sk-ant-test", fetchImpl },
    fetchPage,
    capturesDir: dir,
    maxClaims: 1,
  });
  assert.equal(config.claims.length, 1);
  assert.equal(config.claims[0].id, "automated-shipping");
});

test("suggestMarketConfig: throws when no seed page returns readable text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-tax-"));
  const { fetchImpl } = mockLlm([TAXONOMY]);
  await assert.rejects(
    suggestMarketConfig({
      category: "shipping-software",
      vendors: [{ url: "https://missing.test/" }],
      llm: { provider: "anthropic", apiKey: "sk-ant-test", fetchImpl },
      fetchPage,
      capturesDir: dir,
    }),
    /none of the .* seed pages returned readable text/,
  );
});

test("suggestMarketConfig: throws when the model proposes no usable claims", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-tax-"));
  const { fetchImpl } = mockLlm([{ claims: [] }]);
  await assert.rejects(
    suggestMarketConfig({
      category: "shipping-software",
      vendors: [{ url: "https://acme.test/" }],
      llm: { provider: "anthropic", apiKey: "sk-ant-test", fetchImpl },
      fetchPage,
      capturesDir: dir,
    }),
    /proposed no usable claims/,
  );
});
