import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendCoverage,
  classifyAccount,
  classifyCoverage,
  computeCoverage,
  coverageCountsFromSnapshot,
  deriveAcvFromClosedWon,
  deriveBuyersPerAccount,
  estimateTam,
  loadTamModel,
  projectEta,
  readCoverageTimeline,
  saveTamModel,
  type TamCoverage,
  type TamModel,
} from "../src/index.ts";
import { validateSchedulableArgv } from "../src/schedule.ts";
import {
  EXPLORIUM_BUSINESS_COUNT_CAP,
  probeExploriumBusinessCount,
} from "../src/connectors/prospectSources.ts";
import { runCli } from "../src/cli.ts";

const BASE = {
  name: "t",
  icpName: "ICP",
  accountsSource: "assumption",
  baseline: { accounts: 0, contacts: 0 },
  createdAt: "2026-06-01T00:00:00Z",
};

test("estimateTam: account basis = accounts × ACV; buyers drive the contact target", () => {
  const m = estimateTam({ ...BASE, accounts: 1000, buyersPerAccount: 2, acv: { valueUsd: 10_000 } });
  assert.equal(m.universe.accounts, 1000);
  assert.equal(m.universe.contacts, 2000); // accounts × buyers
  assert.equal(m.tamUsd, 10_000_000); // accounts × ACV (per-logo basis)
  assert.equal(m.acv.basis, "account");
});

test("estimateTam: buyer basis = contacts × ACV", () => {
  const m = estimateTam({ ...BASE, accounts: 1000, buyersPerAccount: 2, acv: { basis: "buyer", valueUsd: 10_000 } });
  assert.equal(m.tamUsd, 20_000_000); // contacts × ACV
});

test("estimateTam rejects nonsense inputs", () => {
  assert.throws(() => estimateTam({ ...BASE, accounts: -1, acv: { valueUsd: 1 } }), /non-negative/);
  assert.throws(() => estimateTam({ ...BASE, accounts: 1, acv: { valueUsd: -5 } }), /positive/); // ACV must be > 0
  assert.throws(() => estimateTam({ ...BASE, accounts: 1, acv: { valueUsd: 0 } }), /real ACV/);
  assert.throws(() => estimateTam({ ...BASE, accounts: 1, buyersPerAccount: 0, acv: { valueUsd: 1 } }), /positive/);
});

test("deriveAcvFromClosedWon: median of won deal amounts; null without won deals", () => {
  const snap = {
    users: [], accounts: [], contacts: [], activities: [],
    deals: [
      { id: "d1", name: "A", amount: 10_000, isWon: true },
      { id: "d2", name: "B", amount: 30_000, isWon: true },
      { id: "d3", name: "C", amount: 20_000, isWon: true },
      { id: "d4", name: "D", amount: 999_999, isWon: false }, // lost — ignored
      { id: "d5", name: "E", isWon: true }, // no amount — ignored
    ],
  } as unknown as Parameters<typeof deriveAcvFromClosedWon>[0];
  const acv = deriveAcvFromClosedWon(snap);
  assert.equal(acv?.valueUsd, 20_000); // median of [10k,20k,30k]
  assert.equal(acv?.dealCount, 3);
  assert.equal(acv?.meanUsd, 20_000);
  assert.equal(deriveAcvFromClosedWon({ ...snap, deals: [] } as typeof snap), null);
});

test("deriveBuyersPerAccount: avg contacts per account that has any; null when none", () => {
  const snap = {
    users: [], accounts: [], deals: [], activities: [],
    contacts: [
      { id: "c1", accountId: "a1" }, { id: "c2", accountId: "a1" }, { id: "c3", accountId: "a1" }, // a1: 3
      { id: "c4", accountId: "a2" }, // a2: 1
      { id: "c5" }, // no account — ignored
    ],
  } as unknown as Parameters<typeof deriveBuyersPerAccount>[0];
  const b = deriveBuyersPerAccount(snap);
  assert.equal(b?.value, 2); // (3+1)/2
  assert.equal(b?.accountsSampled, 2);
  assert.equal(deriveBuyersPerAccount({ ...snap, contacts: [] } as typeof snap), null);
});

test("computeCoverage: ratios, dollars, and campaign attribution", () => {
  const m = estimateTam({ ...BASE, accounts: 1000, buyersPerAccount: 2, acv: { valueUsd: 10_000 }, baseline: { accounts: 50, contacts: 80 } });
  const c = computeCoverage(m, { accounts: 250, contacts: 500 }, "2026-06-10");
  assert.equal(c.accountCoverage, 0.25);
  assert.equal(c.contactCoverage, 0.25);
  assert.equal(c.dollarCovered, 2_500_000); // 0.25 × $10M
  assert.deepEqual(c.addedSinceBaseline, { accounts: 200, contacts: 420 }); // current − baseline
});

test("computeCoverage caps at 100% when the CRM exceeds the universe estimate", () => {
  const m = estimateTam({ ...BASE, accounts: 1000, acv: { valueUsd: 10_000 } });
  const c = computeCoverage(m, { accounts: 2000, contacts: 9999 }, "2026-06-10");
  assert.equal(c.accountCoverage, 1);
  assert.equal(c.dollarCovered, m.tamUsd); // capped, never over 100%
});

test("coverageCountsFromSnapshot counts domain-bearing accounts + all contacts", () => {
  const snapshot = {
    users: [],
    accounts: [
      { id: "a1", name: "A", domain: "a.com" },
      { id: "a2", name: "B", domain: "" }, // name-only stub doesn't count
      { id: "a3", name: "C", domain: "c.com" },
    ],
    contacts: [{ id: "c1" }, { id: "c2" }, { id: "c3" }, { id: "c4" }],
    deals: [],
    activities: [],
  } as unknown as Parameters<typeof coverageCountsFromSnapshot>[0];
  assert.deepEqual(coverageCountsFromSnapshot(snapshot), { accounts: 2, contacts: 4 });
});

test("projectEta: linear burn from a growing timeline; null when flat or sparse", () => {
  const m = estimateTam({ ...BASE, accounts: 1000, acv: { valueUsd: 10_000 } });
  const mk = (at: string, accounts: number): TamCoverage =>
    computeCoverage(m, { accounts, contacts: accounts * 2 }, at);

  // 100 → 300 accounts over 10 days ⇒ 20/day; 700 remain ⇒ 35 days.
  const eta = projectEta(m, [mk("2026-06-01", 100), mk("2026-06-11", 300)]);
  assert.ok(eta);
  assert.equal(eta.accountsPerDay, 20);
  assert.equal(eta.accountsRemaining, 700);
  assert.equal(eta.daysRemaining, 35);
  assert.equal(eta.etaDate, "2026-07-16"); // 2026-06-11 + 35d

  assert.equal(projectEta(m, [mk("2026-06-01", 100)]), null, "one reading ⇒ no projection");
  assert.equal(projectEta(m, [mk("2026-06-01", 100), mk("2026-06-11", 100)]), null, "flat ⇒ no projection");
});

test("store round-trips the model and appends the coverage timeline", () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-tam-"));
  const prev = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  try {
    const m = estimateTam({ ...BASE, name: "acme", accounts: 1000, acv: { valueUsd: 10_000 } });
    saveTamModel(m);
    const loaded = loadTamModel("acme");
    // JSON drops undefined keys (e.g. an unset acv.band) — compare normalized.
    assert.deepEqual(loaded, JSON.parse(JSON.stringify(m)));
    assert.equal(loadTamModel("nope"), null);

    const c = computeCoverage(m, { accounts: 10, contacts: 20 }, "2026-06-05");
    appendCoverage("acme", c);
    appendCoverage("acme", computeCoverage(m, { accounts: 30, contacts: 60 }, "2026-06-09"));
    const timeline = readCoverageTimeline("acme");
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].inCrm.accounts, 10);
    assert.equal(timeline[1].inCrm.accounts, 30);
  } finally {
    if (prev === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("schedule allowlist: acquire --save is schedulable; without --save it is not", () => {
  // The TAM population command is allowed in its plan-producing form.
  validateSchedulableArgv(["enrich", "acquire", "--source", "pipe0", "--provider", "hubspot", "--save"]);
  assert.throws(
    () => validateSchedulableArgv(["enrich", "acquire", "--source", "pipe0"]),
    /must include --save/,
  );
  // A genuine write verb is still rejected outright.
  assert.throws(
    () => validateSchedulableArgv(["bulk-update", "contact", "--where", "x=y", "--set", "a=b"]),
    /not schedulable/,
  );
});

test("probeExploriumBusinessCount reads total_results and flags the 60k cap", async () => {
  const real = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ total_results: 19058, total_pages: 19058 }),
  })) as unknown as typeof fetch;
  assert.deepEqual(await probeExploriumBusinessCount({ apiKey: "k", filters: {}, fetchImpl: real }), {
    total: 19058,
    capped: false,
  });

  const capped = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ total_results: EXPLORIUM_BUSINESS_COUNT_CAP }),
  })) as unknown as typeof fetch;
  const probe = await probeExploriumBusinessCount({ apiKey: "k", filters: {}, fetchImpl: capped });
  assert.equal(probe?.capped, true, "a reading at the ceiling is a floor, not a count");

  const noTotal = (async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) as unknown as typeof fetch;
  assert.equal(await probeExploriumBusinessCount({ apiKey: "k", filters: {}, fetchImpl: noTotal }), null);
});

test("tam estimate --source explorium counts matching COMPANIES directly (no people→accounts)", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-tam-src-"));
  const icpPath = join(home, "icp.json");
  writeFileSync(
    icpPath,
    JSON.stringify({ name: "ICP", firmographics: { geos: ["us"], naics: ["5112"] }, persona: { titleKeywords: ["revops"] } }),
  );
  const prevHome = process.env.FSGTM_HOME;
  const prevKey = process.env.EXPLORIUM_API_KEY;
  const origFetch = globalThis.fetch;
  const origLog = console.log;
  const out: string[] = [];
  process.env.FSGTM_HOME = home;
  process.env.EXPLORIUM_API_KEY = "test-key";
  // Stub the ambient fetch the CLI probe path uses (the /v1/businesses count).
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ total_results: 19058 }),
  })) as unknown as typeof fetch;
  console.log = (m: unknown) => out.push(String(m));
  try {
    await runCli([
      "tam", "estimate", "--name", "src", "--icp", icpPath,
      "--source", "explorium", "--acv", "10000", "--buyers-per-account", "3", "--json",
    ]);
    const model = JSON.parse(out.join("\n")) as TamModel;
    assert.equal(model.universe.accountsSource, "provider:explorium");
    assert.equal(model.universe.accounts, 19058); // the company count IS the account universe — no division
    assert.equal(model.universe.contacts, 57174); // 19058 × 3 buyers = the contact population target
    assert.equal(model.tamUsd, 190_580_000); // accounts × $10k
  } finally {
    console.log = origLog;
    globalThis.fetch = origFetch;
    if (prevHome === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prevHome;
    if (prevKey === undefined) delete process.env.EXPLORIUM_API_KEY;
    else process.env.EXPLORIUM_API_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
  }
});

test("tam estimate --source pipe0 is rejected (no universe total)", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-tam-src2-"));
  const icpPath = join(home, "icp.json");
  writeFileSync(icpPath, JSON.stringify({ name: "ICP", firmographics: { geos: ["us"] }, persona: { titleKeywords: ["x"] } }));
  const prevHome = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  const origLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      () => runCli(["tam", "estimate", "--name", "p", "--icp", icpPath, "--source", "pipe0", "--acv", "1000"]),
      /pipe0 is a population source/,
    );
  } finally {
    console.log = origLog;
    if (prevHome === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("tam CLI: estimate → status --save → report → populate, end to end", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-tam-cli-"));
  const icpPath = join(home, "icp.json");
  writeFileSync(icpPath, JSON.stringify({ name: "RevOps ICP", persona: { titleKeywords: ["revops"] } }));
  const prev = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  const origLog = console.log;
  const out: string[] = [];
  console.log = (m: unknown) => out.push(String(m));
  try {
    // estimate (demo baseline, deterministic) → JSON we can assert on
    await runCli([
      "tam", "estimate", "--name", "cli", "--icp", icpPath,
      "--accounts", "4000", "--acv", "20000", "--buyers-per-account", "3",
      "--demo", "--seed", "7", "--today", "2026-06-01", "--json",
    ]);
    const model = JSON.parse(out.join("\n")) as TamModel;
    assert.equal(model.universe.accounts, 4000);
    assert.equal(model.universe.contacts, 12000);
    assert.equal(model.tamUsd, 80_000_000);
    assert.ok(model.baseline.accounts >= 0); // a real baseline was captured from the demo CRM

    // status --save stamps the timeline
    out.length = 0;
    await runCli(["tam", "status", "--name", "cli", "--demo", "--seed", "7", "--today", "2026-06-10", "--save", "--json"]);
    const status = JSON.parse(out.join("\n"));
    assert.equal(status.saved, true);
    assert.ok(status.coverage.accountCoverage >= 0 && status.coverage.accountCoverage <= 1);
    assert.equal(readCoverageTimeline("cli").length, 1);

    // report renders markdown
    out.length = 0;
    await runCli(["tam", "report", "--name", "cli"]);
    const md = out.join("\n");
    assert.match(md, /# TAM map — cli/);
    assert.match(md, /\$80\.0M/); // the TAM figure

    // populate wires a plan-only acquire schedule
    out.length = 0;
    await runCli(["tam", "populate", "--name", "cli", "--cron", "0 7 * * 1-5", "--source", "pipe0", "--provider", "hubspot"]);
    out.length = 0;
    await runCli(["schedule", "list"]);
    assert.match(out.join("\n"), /enrich acquire --source pipe0 --provider hubspot --save/);
  } finally {
    console.log = origLog;
    if (prev === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("tam estimate REFUSES a fabricated ACV and DERIVES a real one from the CRM", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-tam-acv-"));
  const icpPath = join(home, "icp.json");
  writeFileSync(icpPath, JSON.stringify({ name: "ICP", firmographics: { geos: ["us"] }, persona: { titleKeywords: ["x"] } }));
  const prevHome = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  const origLog = console.log;
  const origErr = console.error;
  const out: string[] = [];
  console.log = (m: unknown) => out.push(String(m));
  console.error = () => {};
  try {
    // 1. No ACV at all → REFUSE (no band default fabricates a number).
    await assert.rejects(
      () => runCli(["tam", "estimate", "--name", "a", "--icp", icpPath, "--accounts", "1000"]),
      /ANNUAL ACV/,
    );

    // 2. A CRM source ALONE does NOT auto-set ACV — HubSpot is coverage, not ACV.
    await assert.rejects(
      () =>
        runCli([
          "tam", "estimate", "--name", "b", "--icp", icpPath, "--accounts", "1000",
          "--demo", "--seed", "7", "--today", "2026-06-01",
        ]),
      /won't guess/,
    );

    // 3. --acv-from-crm requires an explicit --deal-period (no period guessing).
    await assert.rejects(
      () =>
        runCli([
          "tam", "estimate", "--name", "c", "--icp", icpPath, "--accounts", "1000",
          "--demo", "--seed", "7", "--today", "2026-06-01", "--acv-from-crm",
        ]),
      /--deal-period/,
    );

    // 4. --acv-from-crm --deal-period monthly → median closed-won × 12 (annualized).
    out.length = 0;
    await runCli([
      "tam", "estimate", "--name", "d", "--icp", icpPath, "--accounts", "1000",
      "--demo", "--seed", "7", "--today", "2026-06-01", "--acv-from-crm", "--deal-period", "monthly", "--json",
    ]);
    const monthly = JSON.parse(out.join("\n")) as TamModel;
    assert.match(monthly.acv.source, /crm:closed-won.*\/monthly ×12 = annual/);

    // Same CRM, annual basis → the un-multiplied median; monthly = annual × 12.
    out.length = 0;
    await runCli([
      "tam", "estimate", "--name", "e", "--icp", icpPath, "--accounts", "1000",
      "--demo", "--seed", "7", "--today", "2026-06-01", "--acv-from-crm", "--deal-period", "annual", "--json",
    ]);
    const annual = JSON.parse(out.join("\n")) as TamModel;
    assert.equal(monthly.acv.valueUsd, annual.acv.valueUsd * 12, "monthly annualizes to 12× the annual basis");
    assert.match(monthly.universe.buyersSource, /crm:avg-contacts/);

    // 5. Explicit --acv (an annual figure) always wins and is labeled.
    out.length = 0;
    await runCli(["tam", "estimate", "--name", "f", "--icp", icpPath, "--accounts", "1000", "--acv", "180000", "--json"]);
    const m5 = JSON.parse(out.join("\n")) as TamModel;
    assert.equal(m5.acv.valueUsd, 180000);
    assert.match(m5.acv.source, /explicit/);
    assert.equal(m5.tamUsd, 1000 * 180000);
  } finally {
    console.log = origLog;
    console.error = origErr;
    if (prevHome === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

const TARGETING = { employeeBands: ["51-200", "201-500"], industries: ["software", "saas"] };

test("classifyAccount: in / out / unknown against the TAM ICP", () => {
  const acc = (o: object) => o as unknown as Parameters<typeof classifyAccount>[0];
  // matches size + industry
  assert.equal(classifyAccount(acc({ id: "1", name: "A", employeeCount: 120, industry: "Software Development" }), TARGETING), "in");
  // size passes, industry missing → still in (positive evidence, no contradiction)
  assert.equal(classifyAccount(acc({ id: "2", name: "B", employeeCount: 120 }), TARGETING), "in");
  // wrong size → out
  assert.equal(classifyAccount(acc({ id: "3", name: "C", employeeCount: 5, industry: "Software" }), TARGETING), "out");
  // wrong industry → out
  assert.equal(classifyAccount(acc({ id: "4", name: "D", employeeCount: 120, industry: "Manufacturing" }), TARGETING), "out");
  // no checkable data → unknown
  assert.equal(classifyAccount(acc({ id: "5", name: "E" }), TARGETING), "unknown");
  // TAM defined only by geo/technology (not CRM-checkable) → unknown
  assert.equal(classifyAccount(acc({ id: "6", name: "F", employeeCount: 120 }), { geos: ["us"], technologies: ["salesforce"] }), "unknown");
});

test("classifyCoverage buckets CRM accounts; only in-TAM counts toward coverage", () => {
  const m = estimateTam({ ...BASE, accounts: 1000, acv: { valueUsd: 1000 }, targeting: TARGETING });
  const snap = {
    users: [], deals: [], activities: [],
    accounts: [
      { id: "a1", name: "in", domain: "a1.com", employeeCount: 120, industry: "Software" },
      { id: "a2", name: "out-size", domain: "a2.com", employeeCount: 4 },
      { id: "a3", name: "out-ind", domain: "a3.com", employeeCount: 120, industry: "Mining" },
      { id: "a4", name: "unknown", domain: "a4.com" },
      { id: "a5", name: "no-domain", employeeCount: 120 }, // excluded (no domain)
    ],
    contacts: [{ id: "c1", accountId: "a1" }, { id: "c2", accountId: "a2" }],
  } as unknown as Parameters<typeof classifyCoverage>[0] extends never ? never : Parameters<typeof classifyCoverage>[1];
  const cov = classifyCoverage(m, snap, "2026-06-29");
  assert.deepEqual(cov.classified, { inTam: 1, outOfTam: 2, unknown: 1, totalCrm: 4, criteria: ["size", "industry"] });
  assert.equal(cov.accountCoverage, 1 / 1000); // only the 1 in-TAM account counts
  assert.equal(cov.bottomUpExceedsEstimate, false);
});

test("classifyCoverage reconciles bottom-up > top-down: estimate is a floor", () => {
  const m = estimateTam({ ...BASE, accounts: 2, acv: { valueUsd: 1000 }, targeting: { employeeBands: ["51-200"] } });
  const snap = {
    users: [], deals: [], activities: [], contacts: [],
    accounts: [
      { id: "a1", name: "x", domain: "a1.com", employeeCount: 80 },
      { id: "a2", name: "y", domain: "a2.com", employeeCount: 90 },
      { id: "a3", name: "z", domain: "a3.com", employeeCount: 100 },
    ],
  } as unknown as Parameters<typeof classifyCoverage>[1];
  const cov = classifyCoverage(m, snap, "2026-06-29");
  assert.equal(cov.classified?.inTam, 3);
  assert.equal(cov.bottomUpExceedsEstimate, true); // 3 in-TAM > 2 estimated
  assert.equal(cov.reconciledUniverse, 3); // estimate revised up to the verified count
  assert.equal(cov.accountCoverage, 1); // capped at 100% of the (low) estimate
});

test("classifyCoverage falls back to counting all accounts when no targeting (legacy model)", () => {
  const m = estimateTam({ ...BASE, accounts: 1000, acv: { valueUsd: 1000 } }); // no targeting
  const snap = {
    users: [], deals: [], activities: [], contacts: [],
    accounts: [{ id: "a1", name: "x", domain: "a1.com", employeeCount: 5 }],
  } as unknown as Parameters<typeof classifyCoverage>[1];
  const cov = classifyCoverage(m, snap, "2026-06-29");
  assert.equal(cov.classified?.criteria.length, 0);
  assert.equal(cov.classified?.inTam, 1); // counts the account despite wrong size — no criteria to judge
});
