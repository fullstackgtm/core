import assert from "node:assert/strict";
import test from "node:test";
import { buildDedupePlan } from "../src/dedupe.ts";
import type { CanonicalGtmSnapshot } from "../src/types.ts";

const snapshot: CanonicalGtmSnapshot = {
  generatedAt: "2026-06-11T00:00:00.000Z",
  provider: "hubspot",
  users: [{ id: "u1", name: "Dana" }],
  accounts: [
    // group acme.com: 101 is the richer record (more populated data fields)
    { id: "101", name: "Acme", domain: "acme.com", industry: "Manufacturing", employeeCount: 250, annualRevenue: 40_000_000 },
    { id: "102", name: "Acme Inc", domain: "acme.com" },
    { id: "103", name: "Solo Co", domain: "solo.example.com" },
    // group northwind.io: the RICHER record has the HIGHER id — id order must not decide
    { id: "104", name: "Northwind", domain: "northwind.io" },
    { id: "105", name: "Northwind Trading", domain: "northwind.io", industry: "Logistics", employeeCount: 80 },
    // domain normalization: www./protocol variants group together
    { id: "106", name: "Zenith", domain: "www.zenith.dev" },
    { id: "107", name: "Zenith Labs", domain: "https://zenith.dev/about", industry: "Software" },
    { id: "108", name: "No Domain Co" },
  ],
  contacts: [
    { id: "201", firstName: "Sam", lastName: "Alpha", email: "sam@corp.com", title: "VP", phone: "+1", ownerId: "u1" },
    { id: "202", firstName: "S.", lastName: "Alpha", email: "SAM@corp.com " }, // case/whitespace noise
    { id: "203", firstName: "Riley", lastName: "Solo", email: "riley@other.com" },
    { id: "204", firstName: "No", lastName: "Email" },
  ],
  deals: [
    { id: "301", name: "Renewal 2026", stage: "qualifiedtobuy" },
    { id: "302", name: "  renewal 2026", stage: "appointmentscheduled", amount: 5000 },
  ],
  activities: [],
};

test("dedupe accounts by domain: one merge op per group, full group in beforeValue, richest survivor", () => {
  const plan = buildDedupePlan(snapshot, { objectType: "account", key: "domain" });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.status, "needs_approval");
  assert.equal(plan.operations.length, 3);
  const byGroup = Object.fromEntries(plan.operations.map((op) => [(op.beforeValue as string[]).join(","), op]));

  const acme = byGroup["101,102"];
  assert.ok(acme, "acme.com group expected");
  assert.equal(acme.operation, "merge_records");
  assert.equal(acme.afterValue, "101"); // richest
  assert.equal(acme.objectId, "101");
  assert.equal(acme.riskLevel, "high");
  assert.equal(acme.approvalRequired, true);
  assert.equal(acme.sourceRuleOrPolicy, "dedupe");
  assert.equal(acme.groupId, "grp_account_101");
  assert.match(acme.rollback ?? "", /IRREVERSIBLE/);

  // richest wins even when it has the higher id
  assert.equal(byGroup["104,105"].afterValue, "105");
  // www./protocol noise normalizes into one group
  assert.equal(byGroup["106,107"].afterValue, "107");

  assert.match(plan.summary, /3 duplicate group/);
  assert.match(plan.summary, /IRREVERSIBLE/);
});

test("dedupe --keep oldest picks the lowest numeric id regardless of richness", () => {
  const plan = buildDedupePlan(snapshot, { objectType: "account", key: "domain", keep: "oldest" });
  const northwind = plan.operations.find((op) => (op.beforeValue as string[]).includes("104"))!;
  assert.equal(northwind.afterValue, "104"); // sparser but older
});

test("richest tie breaks to the lowest numeric id", () => {
  const tied: CanonicalGtmSnapshot = {
    ...snapshot,
    accounts: [
      { id: "9", name: "Tie A", domain: "tie.com" },
      { id: "10", name: "Tie B", domain: "tie.com" },
    ],
  };
  const plan = buildDedupePlan(tied, { objectType: "account", key: "domain" });
  assert.equal(plan.operations.length, 1);
  // numeric comparison: 9 < 10 (lexicographic would pick "10")
  assert.equal(plan.operations[0].afterValue, "9");
});

test("dedupe contacts by email normalizes case and whitespace; empty keys never group", () => {
  const plan = buildDedupePlan(snapshot, { objectType: "contact", key: "email" });
  assert.equal(plan.operations.length, 1);
  const op = plan.operations[0];
  assert.deepEqual(op.beforeValue, ["201", "202"]);
  assert.equal(op.afterValue, "201"); // richest
  assert.equal(op.objectType, "contact");
});

test("dedupe deals by name (lowercased + trimmed)", () => {
  const plan = buildDedupePlan(snapshot, { objectType: "deal", key: "name" });
  assert.equal(plan.operations.length, 1);
  assert.deepEqual(plan.operations[0].beforeValue, ["301", "302"]);
  assert.equal(plan.operations[0].afterValue, "302"); // has amount → richer
});

test("dedupe rejects nonsensical key/object combinations and bad --keep", () => {
  assert.throws(
    () => buildDedupePlan(snapshot, { objectType: "deal", key: "domain" }),
    /Cannot dedupe deals by "domain"/,
  );
  assert.throws(
    () => buildDedupePlan(snapshot, { objectType: "account", key: "email" }),
    /Cannot dedupe accounts by "email"/,
  );
  assert.throws(
    () => buildDedupePlan(snapshot, { objectType: "account", key: "domain", keep: "newest" as never }),
    /--keep must be richest or oldest/,
  );
});

test("dedupe with no duplicate groups builds an empty draft plan", () => {
  const clean: CanonicalGtmSnapshot = { ...snapshot, accounts: [{ id: "1", name: "Only", domain: "only.com" }] };
  const plan = buildDedupePlan(clean, { objectType: "account", key: "domain" });
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.status, "draft");
});

test("dedupe enforces the safety cap on group count", () => {
  const many: CanonicalGtmSnapshot = {
    ...snapshot,
    accounts: Array.from({ length: 6 }, (_, i) => [
      { id: `${i}a`, name: `Dup ${i}`, domain: `dup${i}.com` },
      { id: `${i}b`, name: `Dup ${i} Inc`, domain: `dup${i}.com` },
    ]).flat(),
  };
  assert.throws(
    () => buildDedupePlan(many, { objectType: "account", key: "domain", maxOperations: 5 }),
    /safety cap/,
  );
});

test("dedupe operation ids are stable across rebuilds and plans apply through the merge gate", async () => {
  const a = buildDedupePlan(snapshot, { objectType: "account", key: "domain" });
  const b = buildDedupePlan(snapshot, { objectType: "account", key: "domain" });
  assert.deepEqual(a.operations.map((o) => o.id), b.operations.map((o) => o.id));

  // apply: merge ops carry concrete survivors (no placeholder), so an
  // approved op flows straight through; unapproved ops are skipped.
  const { applyPatchPlan } = await import("../src/connector.ts");
  const merges: Array<{ survivor: unknown; group: unknown }> = [];
  const connector = {
    provider: "hubspot" as const,
    applyOperation: async (op: any) => {
      merges.push({ survivor: op.afterValue, group: op.beforeValue });
      return { operationId: op.id, status: "applied" as const };
    },
    readField: async () => null,
  };
  const run = await applyPatchPlan(connector as any, a, {
    approvedOperationIds: [a.operations[0].id],
  });
  const statuses = Object.fromEntries(run.results.map((r) => [r.operationId, r.status]));
  assert.equal(statuses[a.operations[0].id], "applied");
  assert.equal(statuses[a.operations[1].id], "skipped");
  assert.equal(merges.length, 1);
  assert.equal(merges[0].survivor, "101");
  assert.deepEqual(merges[0].group, ["101", "102"]);
});
