import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readTheirStackTotal,
  theirStackCountCompanies,
  theirStackSearchCompanies,
} from "../src/connectors/theirstack.ts";
import { employeeBandsToRange, icpToTheirStackFilters } from "../src/icp.ts";
import { runCli } from "../src/cli.ts";

test("readTheirStackTotal finds the total across envelope shapes; null when absent", () => {
  assert.equal(readTheirStackTotal({ metadata: { total_results: 8200 } }), 8200);
  assert.equal(readTheirStackTotal({ total_companies: 42 }), 42);
  assert.equal(readTheirStackTotal({ meta: { total: 7 } }), 7);
  assert.equal(readTheirStackTotal({ data: [{}, {}] }), null, "rows are not a total");
  assert.equal(readTheirStackTotal(null), null);
});

test("employeeBandsToRange collapses bands to a min/max envelope; open top → no max", () => {
  assert.deepEqual(employeeBandsToRange(["51-200", "201-500", "501-1000"]), { min: 51, max: 1000 });
  assert.deepEqual(employeeBandsToRange(["1001-5000", "10001+"]), { min: 1001, max: undefined });
  assert.deepEqual(employeeBandsToRange([]), {});
  assert.deepEqual(employeeBandsToRange(undefined), {});
});

test("icpToTheirStackFilters maps tech (lowercased), geos (UPPER ISO2), bands→min/max", () => {
  const f = icpToTheirStackFilters({
    name: "RevOps",
    firmographics: { geos: ["us"], employeeBands: ["51-200", "201-500", "501-1000"], technologies: ["Salesforce", "HubSpot"] },
    persona: { titleKeywords: ["revops"] },
  });
  assert.deepEqual(f.company_technology_slug_or, ["salesforce", "hubspot"]);
  assert.deepEqual(f.company_country_code_or, ["US"]);
  assert.equal(f.min_employee_count, 51);
  assert.equal(f.max_employee_count, 1000);
});

test("theirStackCountCompanies reads the total from an injected response", async () => {
  let sentBody: unknown;
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ metadata: { total_results: 8200 } }) };
  }) as unknown as typeof fetch;
  const total = await theirStackCountCompanies({
    apiKey: "k",
    filters: { company_technology_slug_or: ["salesforce"], company_country_code_or: ["US"], min_employee_count: 51 },
    fetchImpl,
  });
  assert.equal(total, 8200);
  // The count request asks for the total + the minimum 1 row (the API 422s on
  // limit:0 — verified live).
  assert.equal((sentBody as { limit: number }).limit, 1);
  assert.equal((sentBody as { include_total_results: boolean }).include_total_results, true);
});

test("theirStackSearchCompanies maps real company records + the total", async () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      metadata: { total_results: 8200 },
      data: [
        { name: "Acme", domain: "acme.com", employee_count: 240, country_code: "US", linkedin_url: "https://linkedin.com/company/acme", technology_slugs: ["salesforce"] },
        { name: "Globex", domain: "globex.io", employee_count: 700 },
      ],
    }),
  })) as unknown as typeof fetch;
  const { companies, total } = await theirStackSearchCompanies({ apiKey: "k", filters: {}, limit: 25, fetchImpl });
  assert.equal(total, 8200);
  assert.equal(companies.length, 2);
  assert.deepEqual(companies[0], {
    name: "Acme",
    domain: "acme.com",
    employeeCount: 240,
    countryCode: "US",
    city: undefined,
    linkedinUrl: "https://linkedin.com/company/acme",
    technologies: ["salesforce"],
  });
  assert.equal(companies[1].domain, "globex.io");
});

test("tam estimate --source theirstack counts CRM-using companies (technographic)", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-ts-"));
  const icpPath = join(home, "icp.json");
  writeFileSync(
    icpPath,
    JSON.stringify({
      name: "RevOps @ CRM users",
      firmographics: { geos: ["us"], employeeBands: ["51-200", "201-500", "501-1000"], technologies: ["salesforce", "hubspot"] },
      persona: { titleKeywords: ["revops"] },
    }),
  );
  const prevHome = process.env.FSGTM_HOME;
  const prevKey = process.env.THEIRSTACK_API_KEY;
  const origFetch = globalThis.fetch;
  const origLog = console.log;
  const out: string[] = [];
  process.env.FSGTM_HOME = home;
  process.env.THEIRSTACK_API_KEY = "test-key";
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ metadata: { total_results: 8200 } }),
  })) as unknown as typeof fetch;
  console.log = (m: unknown) => out.push(String(m));
  try {
    await runCli([
      "tam", "estimate", "--name", "ts", "--icp", icpPath,
      "--source", "theirstack", "--acv", "180000", "--json",
    ]);
    const model = JSON.parse(out.join("\n"));
    assert.equal(model.universe.accounts, 8200);
    assert.match(model.universe.accountsSource, /provider:theirstack \(uses-CRM\)/);
    assert.equal(model.tamUsd, 8200 * 180000);
  } finally {
    console.log = origLog;
    globalThis.fetch = origFetch;
    if (prevHome === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prevHome;
    if (prevKey === undefined) delete process.env.THEIRSTACK_API_KEY;
    else process.env.THEIRSTACK_API_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
  }
});

test("tam accounts pulls a real, named company list (JSON)", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-tsl-"));
  const icpPath = join(home, "icp.json");
  writeFileSync(icpPath, JSON.stringify({ name: "ICP", firmographics: { geos: ["us"], technologies: ["salesforce"] }, persona: { titleKeywords: ["revops"] } }));
  const prevKey = process.env.THEIRSTACK_API_KEY;
  const origFetch = globalThis.fetch;
  const origLog = console.log;
  const out: string[] = [];
  process.env.THEIRSTACK_API_KEY = "test-key";
  globalThis.fetch = (async () => ({
    ok: true, status: 200,
    json: async () => ({ metadata: { total_results: 8200 }, data: [
      { name: "Acme", domain: "acme.com", employee_count: 240, technology_slugs: ["salesforce"] },
      { name: "Globex", domain: "globex.io", employee_count: 700, technology_slugs: ["salesforce"] },
    ] }),
  })) as unknown as typeof fetch;
  console.log = (m: unknown) => out.push(String(m));
  try {
    await runCli(["tam", "accounts", "--source", "theirstack", "--icp", icpPath, "--max", "2", "--json"]);
    const res = JSON.parse(out.join("\n"));
    assert.equal(res.total, 8200);
    assert.equal(res.companies.length, 2);
    assert.equal(res.companies[0].name, "Acme");
    assert.equal(res.companies[0].domain, "acme.com");
  } finally {
    console.log = origLog;
    globalThis.fetch = origFetch;
    if (prevKey === undefined) delete process.env.THEIRSTACK_API_KEY;
    else process.env.THEIRSTACK_API_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
  }
});

test("theirStackPullCost: 3 credits/company; $ only with an explicit rate", async () => {
  const { theirStackPullCost, THEIRSTACK_CREDITS_PER_COMPANY } = await import(
    "../src/connectors/theirstack.ts"
  );
  assert.equal(THEIRSTACK_CREDITS_PER_COMPANY, 3);
  assert.deepEqual(theirStackPullCost(100), { companies: 100, credits: 300 }); // no usd without a rate
  assert.deepEqual(theirStackPullCost(43517), { companies: 43517, credits: 130551 });
  assert.deepEqual(theirStackPullCost(43517, 0.042), { companies: 43517, credits: 130551, usd: 5483 });
  assert.deepEqual(theirStackPullCost(0), { companies: 0, credits: 0 });
});

test("tam accounts --dry-run prices the pull without spending (no key, no fetch)", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-cost-"));
  const icpPath = join(home, "icp.json");
  writeFileSync(icpPath, JSON.stringify({ name: "T", firmographics: { geos: ["us"], technologies: ["salesforce"] }, persona: { titleKeywords: ["x"] } }));
  const origLog = console.log;
  const out: string[] = [];
  console.log = (m: unknown) => out.push(String(m));
  try {
    await runCli(["tam", "accounts", "--source", "theirstack", "--icp", icpPath, "--max", "100", "--dry-run"]);
    const text = out.join("\n");
    assert.match(text, /300 TheirStack credits/);
    assert.match(text, /dry run — nothing pulled, 0 credits/);
  } finally {
    console.log = origLog;
    rmSync(home, { recursive: true, force: true });
  }
});

test("tam accounts refuses a pull above --max-credits without --confirm (no spend)", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-cost2-"));
  const icpPath = join(home, "icp.json");
  writeFileSync(icpPath, JSON.stringify({ name: "T", firmographics: { geos: ["us"], technologies: ["salesforce"] }, persona: { titleKeywords: ["x"] } }));
  const origErr = console.error;
  const prevExit = process.exitCode;
  const errs: string[] = [];
  console.error = (m: unknown) => errs.push(String(m));
  try {
    // max 100 = 300 credits > default 150 guard, no --confirm → refuses BEFORE any
    // network/key use (no THEIRSTACK_API_KEY set, so a pull would otherwise throw).
    await runCli(["tam", "accounts", "--source", "theirstack", "--icp", icpPath, "--max", "100"]);
    assert.match(errs.join("\n"), /exceeds the --max-credits guard \(150\)/);
    assert.equal(process.exitCode, 2);
  } finally {
    console.error = origErr;
    process.exitCode = prevExit;
    rmSync(home, { recursive: true, force: true });
  }
});
