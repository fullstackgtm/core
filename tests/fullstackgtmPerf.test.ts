import assert from "node:assert/strict";
import test from "node:test";
import {
  auditSnapshot,
  defaultPolicy,
  diffSnapshots,
  generateDemoSnapshot,
} from "../src/index.ts";

/**
 * Performance guard: the audit engine must stay effectively linear. These
 * bounds are deliberately generous (CI machines vary); what they catch is a
 * regression to quadratic behavior, which at this scale would blow far past
 * the budget.
 */

test("auditing a large org stays within the linear-time budget", () => {
  const generationStart = performance.now();
  const snapshot = generateDemoSnapshot({ accounts: 2000, deals: 10_000 });
  const generated = performance.now() - generationStart;

  assert.equal(snapshot.deals.length, 10_000);
  assert.ok(snapshot.contacts.length > 2000);

  const auditStart = performance.now();
  const plan = auditSnapshot(snapshot, defaultPolicy("2026-06-09"));
  const audited = performance.now() - auditStart;

  assert.ok(plan.findings.length > 500, `expected substantial findings, got ${plan.findings.length}`);
  assert.ok(audited < 5000, `audit took ${Math.round(audited)}ms (budget 5000ms)`);
  assert.ok(generated < 5000, `generation took ${Math.round(generated)}ms (budget 5000ms)`);
});

test("diffing two large snapshots stays within budget", () => {
  const before = generateDemoSnapshot({ accounts: 2000, deals: 10_000 });
  const after = generateDemoSnapshot({ accounts: 2000, deals: 10_000, seed: 8 });

  const start = performance.now();
  const diff = diffSnapshots(before, after);
  const elapsed = performance.now() - start;

  assert.ok(diff.deals.changed.length > 0);
  assert.ok(elapsed < 5000, `diff took ${Math.round(elapsed)}ms (budget 5000ms)`);
});
