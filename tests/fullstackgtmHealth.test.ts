import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  auditSnapshot,
  computeHealth,
  sampleSnapshot,
  summarizeHealth,
  type HealthEntry,
} from "../src/index.ts";
import { runCli } from "../src/cli.ts";

// Spread sampleSnapshot so the empty fixture carries the full CanonicalGtmSnapshot
// shape (and is correctly typed under tsc), just with no records.
const EMPTY_SNAPSHOT = {
  ...sampleSnapshot,
  users: [],
  accounts: [],
  contacts: [],
  deals: [],
  activities: [],
};

test("computeHealth is deterministic and accounts every finding", () => {
  const plan = auditSnapshot(sampleSnapshot);
  const a = computeHealth(plan, sampleSnapshot, "2026-06-01");
  const b = computeHealth(plan, sampleSnapshot, "2026-06-01");
  assert.deepEqual(a, b); // byte-stable: same inputs → same entry

  assert.equal(a.findings, plan.findings.length);
  const summed = Object.values(a.byRule).reduce((x, y) => x + y, 0);
  assert.equal(summed, plan.findings.length, "byRule counts sum to total findings");
  const severitySum =
    a.severityCounts.info + a.severityCounts.warning + a.severityCounts.critical;
  assert.equal(severitySum, plan.findings.length);
  assert.ok(a.score >= 0 && a.score <= 100);
});

test("a clean snapshot scores 100; the score normalizes by record count", () => {
  const cleanPlan = auditSnapshot(EMPTY_SNAPSHOT);
  const clean = computeHealth(cleanPlan, EMPTY_SNAPSHOT, "2026-06-01");
  assert.equal(clean.findings, 0);
  assert.equal(clean.score, 100, "no findings ⇒ perfect score");

  // Same findings against fewer records ⇒ higher penalty ⇒ lower (or equal) score.
  const plan = auditSnapshot(sampleSnapshot);
  const big = computeHealth(plan, sampleSnapshot, "2026-06-01");
  const small = computeHealth(plan, { ...sampleSnapshot, contacts: [], deals: [] }, "2026-06-01");
  assert.ok(small.score <= big.score, "fewer clean records ⇒ worse score for the same findings");
});

test("summarizeHealth orders oldest→newest and computes score + rule deltas", () => {
  const mk = (at: string, score: number, byRule: Record<string, number>): HealthEntry => ({
    at,
    planId: `p_${at}`,
    score,
    findings: Object.values(byRule).reduce((a, b) => a + b, 0),
    weightedFindings: 0,
    records: { accounts: 0, contacts: 0, deals: 0, total: 0 },
    byRule,
    severityCounts: { info: 0, warning: 0, critical: 0 },
  });

  // Deliberately out of chronological order in the input.
  const rollup = summarizeHealth(
    [mk("2026-06-12", 45, { "stale-deal": 30, churn: 2 }), mk("2026-06-01", 50, { "stale-deal": 33 })],
    "acme",
  );
  assert.ok(rollup);
  assert.equal(rollup.auditCount, 2);
  assert.equal(rollup.current.at, "2026-06-12");
  assert.equal(rollup.previous?.at, "2026-06-01");
  assert.equal(rollup.scoreDelta, -5);

  const stale = rollup.ruleDeltas.find((r) => r.ruleId === "stale-deal");
  assert.equal(stale?.delta, -3); // 30 − 33: improved
  const churn = rollup.ruleDeltas.find((r) => r.ruleId === "churn");
  assert.equal(churn?.delta, 2); // 2 − 0: a new/worsening rule

  // Empty timeline and first-audit cases.
  assert.equal(summarizeHealth([], "acme"), null);
  const first = summarizeHealth([mk("2026-06-01", 50, {})], "acme");
  assert.equal(first?.scoreDelta, null);
  assert.equal(first?.previous, null);
});

test("audit --save accrues the profile timeline; health rolls it up read-only", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-health-"));
  const prevHome = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  const origLog = console.log;
  const origErr = console.error;
  const out: string[] = [];
  try {
    // 1. Empty timeline → a helpful pointer, not a crash.
    console.log = (m: unknown) => out.push(String(m));
    console.error = () => {};
    await runCli(["health"]);
    assert.match(out.join("\n"), /No audits recorded yet for profile "default"/);

    // 2. Two saved audits stamp the timeline (output swallowed).
    console.log = () => {};
    await runCli(["audit", "--demo", "--seed", "7", "--save", "--today", "2026-06-01"]);
    await runCli(["audit", "--demo", "--seed", "3", "--save", "--today", "2026-06-12"]);

    // 3. health --json reflects both, oldest→newest, with a consistent delta.
    out.length = 0;
    console.log = (m: unknown) => out.push(String(m));
    await runCli(["health", "--json"]);
    const rollup = JSON.parse(out.join("\n"));
    assert.equal(rollup.auditCount, 2);
    assert.equal(rollup.first, "2026-06-01");
    assert.equal(rollup.latest, "2026-06-12");
    assert.equal(rollup.history.length, 2);
    assert.equal(typeof rollup.current.score, "number");
    assert.equal(rollup.scoreDelta, rollup.current.score - rollup.previous.score);
  } finally {
    console.log = origLog;
    console.error = origErr;
    if (prevHome === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
