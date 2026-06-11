import assert from "node:assert/strict";
import test from "node:test";
import { buildBulkUpdatePlan } from "../src/bulkUpdate.ts";
import type { CanonicalGtmSnapshot } from "../src/types.ts";

const snapshot: CanonicalGtmSnapshot = {
  generatedAt: "2026-06-11T00:00:00.000Z",
  provider: "hubspot",
  users: [
    { id: "u1", name: "Dana" },
    { id: "u2", name: "Alex" },
  ],
  accounts: [
    { id: "a1", name: "EMEA GmbH", domain: "emea.de", ownerId: "u1" },
    { id: "a2", name: "US Inc", domain: "us.com", ownerId: "u2" },
  ],
  contacts: [],
  deals: [
    { id: "d1", name: "Dana Deal 1", ownerId: "u1", stage: "qualifiedtobuy", amount: 1000, isClosed: false },
    { id: "d2", name: "Dana Deal 2", ownerId: "u1", stage: "closedwon", amount: 2000, isClosed: true, isWon: true },
    { id: "d3", name: "Alex Deal", ownerId: "u2", stage: "qualifiedtobuy", amount: 3000, isClosed: false },
  ],
  activities: [],
};

test("bulk-update builds set_field ops with beforeValue captured for compare-and-set", () => {
  const plan = buildBulkUpdatePlan(snapshot, {
    objectType: "deal",
    where: ["ownerId=u1", "isClosed=false"],
    set: { ownerId: "u2" },
  });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.status, "needs_approval");
  assert.equal(plan.operations.length, 1); // d2 excluded: closed
  const op = plan.operations[0];
  assert.equal(op.objectId, "d1");
  assert.equal(op.operation, "set_field");
  assert.equal(op.field, "ownerId");
  assert.equal(op.beforeValue, "u1"); // live value → conflict detection at apply
  assert.equal(op.afterValue, "u2");
  assert.equal(op.approvalRequired, true);
  assert.equal(op.sourceRuleOrPolicy, "bulk-update");
});

test("bulk-update filter operators: contains, neq, empty", () => {
  const contains = buildBulkUpdatePlan(snapshot, {
    objectType: "account",
    where: ["domain~.de"],
    set: { ownerId: "u2" },
  });
  assert.deepEqual(contains.operations.map((o) => o.objectId), ["a1"]);

  const neq = buildBulkUpdatePlan(snapshot, {
    objectType: "deal",
    where: ["ownerId!=u1"],
    set: { stage: "presentationscheduled" },
  });
  assert.deepEqual(neq.operations.map((o) => o.objectId), ["d3"]);

  const empty = buildBulkUpdatePlan(snapshot, {
    objectType: "account",
    where: ["industry:empty"],
    set: { ownerId: "u2" },
  });
  assert.equal(empty.operations.length, 2);
});

test("bulk-update archive proposes archive_record at high risk", () => {
  const plan = buildBulkUpdatePlan(snapshot, {
    objectType: "deal",
    where: ["stage=closedwon"],
    archive: true,
  });
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].operation, "archive_record");
  assert.equal(plan.operations[0].riskLevel, "high");
});

test("bulk-update refuses unscoped writes, set+archive, and oversized plans", () => {
  assert.throws(
    () => buildBulkUpdatePlan(snapshot, { objectType: "deal", where: [], set: { amount: "1" } }),
    /unscoped mass write/,
  );
  assert.throws(
    () => buildBulkUpdatePlan(snapshot, { objectType: "deal", where: ["ownerId=u1"], set: { amount: "1" }, archive: true }),
    /exactly one action/,
  );
  assert.throws(
    () => buildBulkUpdatePlan(snapshot, { objectType: "deal", where: ["amount!=x"], set: { amount: "1" }, maxOperations: 2 }),
    /safety cap/,
  );
});

test("bulk-update operation ids are stable across rebuilds", () => {
  const opts = { objectType: "deal" as const, where: ["ownerId=u1", "isClosed=false"], set: { ownerId: "u2" } };
  const a = buildBulkUpdatePlan(snapshot, opts);
  const b = buildBulkUpdatePlan(snapshot, opts);
  assert.deepEqual(a.operations.map((o) => o.id), b.operations.map((o) => o.id));
});

test("equality filters become auto-preconditions with the record's live value", () => {
  const plan = buildBulkUpdatePlan(snapshot, {
    objectType: "deal",
    where: ["stage=qualifiedtobuy", "ownerId=u1"],
    set: { ownerId: "u2" },
  });
  const op = plan.operations[0];
  // ownerId is the written field (beforeValue guards it); stage becomes a precondition
  assert.deepEqual(op.preconditions, [{ field: "stage", expectedValue: "qualifiedtobuy" }]);
  assert.equal(op.groupId, "grp_deal_d1");
});

test("--require adds explicit preconditions", () => {
  const plan = buildBulkUpdatePlan(snapshot, {
    objectType: "deal",
    where: ["ownerId=u1", "isClosed=false"],
    set: { ownerId: "u2" },
    require: ["stage=qualifiedtobuy"],
  });
  assert.deepEqual(plan.operations[0].preconditions, [{ field: "stage", expectedValue: "qualifiedtobuy" }]);
});

test("--create-task builds create_task operations", () => {
  const plan = buildBulkUpdatePlan(snapshot, {
    objectType: "deal",
    where: ["ownerId=u1", "isClosed=false"],
    createTask: "No contact on account — find one before the meeting",
  });
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].operation, "create_task");
  assert.equal(plan.operations[0].afterValue, "No contact on account — find one before the meeting");
});

test("relational pseudo-fields filter deals by their account", () => {
  const snap = structuredClone(snapshot);
  snap.deals[0].accountId = "a1";
  snap.deals[2].accountId = "a2";
  snap.contacts = [{ id: "c1", name: "Someone", accountId: "a2" } as any];
  const plan = buildBulkUpdatePlan(snap, {
    objectType: "deal",
    where: ["isClosed=false", "account.contactCount=0"],
    createTask: "Find a contact",
  });
  assert.deepEqual(plan.operations.map((o) => o.objectId), ["d1"]); // d3's account has a contact
});

test("apply enforces preconditions and group all-or-nothing", async () => {
  const { applyPatchPlan } = await import("../src/connector.ts");
  const live: Record<string, Record<string, unknown>> = {
    d1: { ownerId: "u1", stage: "contractsent" }, // stage drifted after planning
    d3: { ownerId: "u2", stage: "qualifiedtobuy" },
  };
  const writes: string[] = [];
  const connector = {
    provider: "hubspot" as const,
    applyOperation: async (op: any) => {
      writes.push(op.id);
      return { operationId: op.id, status: "applied" as const };
    },
    readField: async (_t: any, id: string, field: string) => live[id]?.[field] ?? null,
  };
  const plan = {
    id: "p1", title: "t", createdAt: "now", status: "approved" as const, dryRun: true as const,
    summary: "", findings: [],
    operations: [
      { id: "op_a", objectType: "deal" as const, objectId: "d1", operation: "set_field" as const, field: "ownerId",
        beforeValue: "u1", afterValue: "u9", reason: "r", riskLevel: "medium" as const, approvalRequired: true,
        preconditions: [{ field: "stage", expectedValue: "qualifiedtobuy" }], groupId: "g1" },
      { id: "op_b", objectType: "deal" as const, objectId: "d1", operation: "set_field" as const, field: "stage",
        beforeValue: "contractsent", afterValue: "closedlost", reason: "r", riskLevel: "medium" as const, approvalRequired: true,
        groupId: "g1" },
      { id: "op_c", objectType: "deal" as const, objectId: "d3", operation: "set_field" as const, field: "ownerId",
        beforeValue: "u2", afterValue: "u9", reason: "r", riskLevel: "medium" as const, approvalRequired: true,
        preconditions: [{ field: "stage", expectedValue: "qualifiedtobuy" }], groupId: "g2" },
    ],
  };
  const run = await applyPatchPlan(connector as any, plan as any, {
    approvedOperationIds: ["op_a", "op_b", "op_c"],
  });
  const byId = Object.fromEntries(run.results.map((r: any) => [r.operationId, r.status]));
  assert.equal(byId.op_a, "conflict"); // precondition failed (stage drifted)
  assert.equal(byId.op_b, "skipped");  // same group as op_a — all-or-nothing
  assert.equal(byId.op_c, "applied");  // unaffected group
  assert.deepEqual(writes, ["op_c"]);
});

test("plan guards: parse, plan-time validation, and apply-time abort", async () => {
  const { parseGuard, evaluateGuard } = await import("../src/bulkUpdate.ts");
  const guard = parseGuard("deal:accountId=a1;stage=contractsent:none");
  assert.deepEqual(guard.where, ["accountId=a1", "stage=contractsent"]);
  assert.equal(evaluateGuard(snapshot, guard), null); // no contractsent deals → satisfied

  // plan-time: a guard that already fails refuses to build
  assert.throws(
    () => buildBulkUpdatePlan(snapshot, {
      objectType: "deal", where: ["ownerId=u1"], set: { ownerId: "u2" },
      guard: ["deal:stage=closedwon:none"], // d2 is closedwon... but guard counts only matching records
    }),
    /Guard failed/,
  );

  // apply-time: guard re-evaluated against the LIVE snapshot aborts everything
  const { applyPatchPlan } = await import("../src/connector.ts");
  const plan = buildBulkUpdatePlan(snapshot, {
    objectType: "deal", where: ["ownerId=u1", "isClosed=false"], set: { ownerId: "u2" },
    guard: ["deal:stage=contractsent:none"],
  });
  const drifted = structuredClone(snapshot);
  (drifted.deals[0] as any).stage = "contractsent"; // drift AFTER planning
  const writes: string[] = [];
  const connector = {
    provider: "hubspot" as const,
    fetchSnapshot: async () => drifted,
    applyOperation: async (op: any) => { writes.push(op.id); return { operationId: op.id, status: "applied" as const }; },
    readField: async () => null,
  };
  const run = await applyPatchPlan(connector as any, plan as any, {
    approvedOperationIds: plan.operations.map((o) => o.id),
    checkConflicts: false,
  });
  assert.equal(run.status, "rejected");
  assert.ok(run.results.every((r: any) => r.status === "conflict"));
  assert.deepEqual(writes, []);
});

test("not-contains operator and openDealStages pseudo-field", () => {
  const snap = structuredClone(snapshot);
  snap.deals.push({ id: "d4", name: "CS", accountId: "a1", ownerId: "u1", stage: "contractsent", isClosed: false } as any);
  snap.contacts = [{ id: "c1", name: "X", accountId: "a1", ownerId: "u1" } as any, { id: "c2", name: "Y", accountId: "a2", ownerId: "u1" } as any];
  const plan = buildBulkUpdatePlan(snap, {
    objectType: "contact",
    where: ["ownerId=u1", "account.openDealStages!~contractsent"],
    set: { ownerId: "u2" },
  });
  assert.deepEqual(plan.operations.map((o) => o.objectId), ["c2"]); // c1's account has a contractsent deal
});

test("unknown fields are rejected loudly in where, require, and guards", async () => {
  const { parseGuard } = await import("../src/bulkUpdate.ts");
  assert.throws(
    () => buildBulkUpdatePlan(snapshot, { objectType: "deal", where: ["hs_is_closed=false"], set: { ownerId: "u2" } }),
    /Unknown field "hs_is_closed".*Valid fields/,
  );
  assert.throws(() => parseGuard("deal:hs_is_closed=false:none"), /Unknown field "hs_is_closed"/);
  assert.throws(
    () => buildBulkUpdatePlan(snapshot, { objectType: "deal", where: ["ownerId=u1"], set: { dealstage: "x" } }),
    /not a writable canonical field/,
  );
});

test("| alternation: any-of for eq/contains, all-of for negations", () => {
  const plan = buildBulkUpdatePlan(snapshot, {
    objectType: "account",
    where: ["domain~.de|.fr|.co.uk"],
    set: { ownerId: "u2" },
  });
  assert.deepEqual(plan.operations.map((o) => o.objectId), ["a1"]);
  // alternation eq clauses don't become single-value preconditions
  const alt = buildBulkUpdatePlan(snapshot, {
    objectType: "deal",
    where: ["stage=qualifiedtobuy|presentationscheduled", "ownerId=u1"],
    set: { ownerId: "u2" },
  });
  assert.equal(alt.operations[0].preconditions, undefined);
});

test("apply re-verifies the full filter per record, negations and relational fields included", async () => {
  const { applyPatchPlan } = await import("../src/connector.ts");
  const snap = structuredClone(snapshot);
  snap.deals[0].accountId = "a1";
  snap.deals[2].accountId = "a2";
  // Haiku's exact pattern: batch update with a negated relational condition
  const plan = buildBulkUpdatePlan(snap, {
    objectType: "deal",
    where: ["isClosed=false", "account.openDealStages!~contractsent"],
    set: { ownerId: "u2" },
  });
  assert.deepEqual(plan.operations.map((o) => o.objectId).sort(), ["d1", "d3"]);
  // drift after planning: a1 gains an open contractsent deal → d1 ineligible
  const drifted = structuredClone(snap);
  drifted.deals.push({ id: "d9", name: "CS", accountId: "a1", stage: "contractsent", isClosed: false } as any);
  const writes: string[] = [];
  const connector = {
    provider: "hubspot" as const,
    fetchSnapshot: async () => drifted,
    applyOperation: async (op: any) => { writes.push(op.objectId); return { operationId: op.id, status: "applied" as const }; },
    readField: async (_t: any, id: string, field: string) =>
      (drifted.deals.find((d) => d.id === id) as any)?.[field] ?? null,
  };
  const run = await applyPatchPlan(connector as any, plan as any, {
    approvedOperationIds: plan.operations.map((o) => o.id),
  });
  const byObject = Object.fromEntries(run.results.map((r: any) => {
    const op = plan.operations.find((o) => o.id === r.operationId)!;
    return [op.objectId, r.status];
  }));
  assert.equal(byObject.d1, "conflict"); // no longer matches the filter
  assert.match(run.results.find((r: any) => r.status === "conflict")!.detail!, /no longer matches the plan's filter/);
  assert.equal(byObject.d3, "applied");
  assert.deepEqual(writes, ["d3"]);
});
