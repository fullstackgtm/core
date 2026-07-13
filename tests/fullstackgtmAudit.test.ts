import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import {
  auditFindingId,
  auditSnapshot,
  builtinAuditRules,
  duplicateOpenDealRule,
  defaultPolicy,
  sampleSnapshot,
  type GtmAuditRule,
} from "../src/index.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const runCli = (args: string[]) =>
  spawnSync(
    process.execPath,
    ["--experimental-strip-types", "src/bin.ts", ...args],
    { cwd: repoRoot, encoding: "utf8" },
  );

test("audit refuses to run without an explicit data source (no silent sample fallback)", () => {
  // Regression: a missing or typo'd source flag must NOT silently audit the
  // built-in sample fixture as if it were the user's real CRM.
  const missing = runCli(["audit"]);
  assert.equal(missing.status, 1, "expected exit 1 for audit without a source");
  assert.match(`${missing.stderr}${missing.stdout}`, /No data source/);

  const typo = runCli(["audit", "--snapshot", "typo.json"]);
  assert.equal(typo.status, 1, "expected exit 1 for typo'd source flag");
  assert.match(`${typo.stderr}${typo.stdout}`, /Unknown flag for audit: --snapshot/);
  // Explicit --sample is still an allowed opt-in.
  const sample = runCli(["audit", "--sample"]);
  assert.equal(sample.status, 0, sample.stderr);
  assert.match(sample.stdout, /findings/);
});

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
  assert.ok(plan.assumptions?.some((assumption) => assumption.id === "open-deal-derived-from-closed-won-flags"));
  assert.equal(
    plan.assumptions?.filter((assumption) => assumption.id === "open-deal-derived-from-closed-won-flags").length,
    1,
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

test("duplicate open deals are flagged once per group, scoped by account", () => {
  const snapshot = {
    generatedAt: "2026-05-01T00:00:00.000Z",
    provider: "mock" as const,
    users: [],
    accounts: [],
    contacts: [],
    activities: [],
    deals: [
      // Unlinked duplicates — names differ only by case/whitespace.
      { id: "d1", name: "Acme — Renewal" },
      { id: "d2", name: "  acme —  renewal " },
      // Same name but closed: never grouped.
      { id: "d3", name: "Acme — Renewal", isClosed: true },
      // Same name on a linked account: a different scope, alone in its group.
      { id: "d4", name: "Acme — Renewal", accountId: "a1" },
    ],
  };
  const plan = auditSnapshot(snapshot, defaultPolicy("2026-05-03"), [duplicateOpenDealRule]);

  assert.equal(plan.findings.length, 1);
  const finding = plan.findings[0];
  assert.equal(finding.ruleId, "duplicate-open-deal");
  assert.equal(finding.objectId, "d1");
  assert.match(finding.summary, /2 open deals/);
  assert.match(finding.summary, /d1, d2/);

  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].operation, "merge_records");
  assert.equal(plan.operations[0].afterValue, "requires_human_survivor_selection");
  assert.ok(Array.isArray(plan.operations[0].beforeValue));
  assert.equal(plan.operations[0].riskLevel, "high");
  assert.equal(plan.operations[0].approvalRequired, true);
  assert.match(plan.operations[0].rollback ?? "", /IRREVERSIBLE/);
});
