import assert from "node:assert/strict";
import test from "node:test";
import {
  auditFindingId,
  auditSnapshot,
  builtinAuditRules,
  defaultPolicy,
  sampleSnapshot,
  type GtmAuditRule,
} from "../src/index.ts";

test("fullstackgtm audit emits dry-run findings and patch operations", () => {
  const plan = auditSnapshot(sampleSnapshot, defaultPolicy("2026-05-03"));

  assert.equal(plan.dryRun, true);
  assert.equal(plan.status, "needs_approval");
  assert.equal(plan.findings.length, 4);
  assert.equal(plan.operations.length, 4);
  assert.equal(
    plan.operations.every((operation) => operation.approvalRequired),
    true,
  );
  assert.deepEqual(
    plan.findings.map((finding) => finding.ruleId).sort(),
    [
      "missing-deal-owner",
      "orphan-account",
      "past-close-date",
      "stale-deal",
    ],
  );
});

test("fullstackgtm stale deal policy is configurable", () => {
  const policy = defaultPolicy("2026-05-03");
  policy.staleDealDays = 120;

  const plan = auditSnapshot(sampleSnapshot, policy);

  assert.equal(
    plan.findings.some((finding) => finding.ruleId === "stale-deal"),
    false,
  );
});

test("fullstackgtm audit accepts custom rules alongside the built-ins", () => {
  const missingAmountRule: GtmAuditRule = {
    id: "missing-deal-amount",
    title: "Deal has no amount",
    description: "Flags deals without an amount so forecasts stay trustworthy.",
    evaluate: ({ snapshot }) => ({
      findings: snapshot.deals
        .filter((deal) => deal.amount === undefined || deal.amount === 0)
        .map((deal) => ({
          id: auditFindingId("missing-deal-amount", deal.id),
          objectType: "deal" as const,
          objectId: deal.id,
          ruleId: "missing-deal-amount",
          title: "Deal has no amount",
          severity: "warning" as const,
          summary: `${deal.name} has no amount.`,
          recommendation: "Set an amount or close the deal out.",
        })),
      operations: [],
    }),
  };

  const plan = auditSnapshot(sampleSnapshot, defaultPolicy("2026-05-03"), [
    ...builtinAuditRules,
    missingAmountRule,
  ]);

  const builtinOnly = auditSnapshot(sampleSnapshot, defaultPolicy("2026-05-03"));
  assert.ok(plan.findings.length >= builtinOnly.findings.length);
  assert.equal(
    builtinOnly.findings.every((finding) =>
      plan.findings.some((candidate) => candidate.id === finding.id),
    ),
    true,
  );
});

test("fullstackgtm audit findings have stable ids across runs", () => {
  const first = auditSnapshot(sampleSnapshot, defaultPolicy("2026-05-03"));
  const second = auditSnapshot(sampleSnapshot, defaultPolicy("2026-05-03"));
  assert.deepEqual(
    first.findings.map((finding) => finding.id),
    second.findings.map((finding) => finding.id),
  );
  assert.deepEqual(
    first.operations.map((operation) => operation.id),
    second.operations.map((operation) => operation.id),
  );
});
