import assert from "node:assert/strict";
import test from "node:test";
import { buildBulkUpdatePlan, eligibleIds, parseWhere } from "../src/bulkUpdate.ts";
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

test("--archive refuses records whose identity key collides with another record", () => {
  const snap = structuredClone(snapshot);
  // a3 duplicates a1's domain (with www. noise); archiving it would discard data a merge keeps
  snap.accounts.push({ id: "a3", name: "EMEA Duplicate", domain: "www.emea.de" } as any);
  assert.throws(
    () => buildBulkUpdatePlan(snap, { objectType: "account", where: ["name~duplicate"], archive: true }),
    (error: Error) => {
      assert.match(error.message, /Refusing to archive/);
      assert.match(error.message, /a3 "EMEA Duplicate"/); // names the colliding record
      assert.match(error.message, /a1 "EMEA GmbH"/); // and what it collides with
      assert.match(error.message, /dedupe account --key domain/); // points at the merge path
      return true;
    },
  );
  // explicit override bypasses the guard
  const forced = buildBulkUpdatePlan(snap, {
    objectType: "account",
    where: ["name~duplicate"],
    archive: true,
    forceArchiveDuplicates: true,
  });
  assert.deepEqual(forced.operations.map((o) => o.objectId), ["a3"]);
});

test("--archive duplicate guard covers contacts by email and exempts deals", () => {
  const snap = structuredClone(snapshot);
  snap.contacts = [
    { id: "c1", firstName: "A", lastName: "B", email: "dup@x.com" } as any,
    { id: "c2", firstName: "A", lastName: "B2", email: "DUP@x.com" } as any, // case noise still collides
    { id: "c3", firstName: "C", lastName: "D" } as any, // no email → no identity key, archivable
  ];
  assert.throws(
    () => buildBulkUpdatePlan(snap, { objectType: "contact", where: ["email~dup"], archive: true }),
    /shares email "dup@x.com"|Refusing to archive/,
  );
  const noKey = buildBulkUpdatePlan(snap, { objectType: "contact", where: ["email:empty"], archive: true });
  assert.deepEqual(noKey.operations.map((o) => o.objectId), ["c3"]);
  // deals have no identity key: duplicate names never block an archive
  const dealSnap = structuredClone(snapshot);
  dealSnap.deals.push({ id: "d9", name: "Dana Deal 1", stage: "closedwon", isClosed: true } as any);
  const deals = buildBulkUpdatePlan(dealSnap, { objectType: "deal", where: ["stage=closedwon"], archive: true });
  assert.equal(deals.operations.length, 2);
});

test("--set field=from:<sourceField> resolves per record, including relational sources", () => {
  const snap = structuredClone(snapshot);
  snap.deals = [
    { id: "d1", name: "One", accountId: "a1", stage: "qualifiedtobuy", isClosed: false } as any, // → u1 (a1's owner)
    { id: "d2", name: "Two", accountId: "a2", stage: "qualifiedtobuy", isClosed: false } as any, // → u2 (a2's owner)
    { id: "d3", name: "Three", stage: "qualifiedtobuy", isClosed: false } as any, // no account → skipped
  ];
  const plan = buildBulkUpdatePlan(snap, {
    objectType: "deal",
    where: ["ownerId:empty"],
    set: { ownerId: "from:account.ownerId" },
  });
  // the op's afterValue is the RESOLVED literal; beforeValue stays the current value
  const byId = Object.fromEntries(plan.operations.map((o) => [o.objectId, o]));
  assert.deepEqual(Object.keys(byId).sort(), ["d1", "d2"]);
  assert.equal(byId.d1.afterValue, "u1");
  assert.equal(byId.d2.afterValue, "u2");
  assert.equal(byId.d1.beforeValue, null);
  // the empty-source record is skipped (not failed) and counted in the summary
  assert.match(plan.summary, /1 skipped: empty account\.ownerId/);
  assert.match(plan.summary, /3 deals matched/);
});

test("from: validates the source field strictly and skips the whole record when any source is empty", () => {
  assert.throws(
    () => buildBulkUpdatePlan(snapshot, {
      objectType: "deal",
      where: ["ownerId=u1"],
      set: { ownerId: "from:hubspot_owner_id" },
    }),
    /unknown source field "hubspot_owner_id".*Valid fields/,
  );
  // multi-field set: one empty source skips the record entirely (groups are all-or-nothing)
  const snap = structuredClone(snapshot);
  snap.deals = [
    { id: "d1", name: "One", accountId: "a1", stage: "qualifiedtobuy", isClosed: false } as any,
    { id: "d2", name: "Two", stage: "qualifiedtobuy", isClosed: false } as any, // no account
  ];
  const plan = buildBulkUpdatePlan(snap, {
    objectType: "deal",
    where: ["isClosed=false"],
    set: { ownerId: "from:account.ownerId", nextStep: "Confirm owner handoff" },
  });
  assert.deepEqual(plan.operations.map((o) => o.objectId), ["d1", "d1"]);
  assert.equal(plan.operations.filter((o) => o.objectId === "d2").length, 0);
  assert.match(plan.summary, /1 skipped: empty account\.ownerId/);
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

// --- Comparison operators (lt/gt/lte/gte) -----------------------------------

// A deals snapshot for the comparison tests: open + closed deals with a spread
// of close dates around the fixed today, plus numeric amounts/probabilities.
const cmpToday = "2026-06-11";
const cmpSnapshot: CanonicalGtmSnapshot = {
  generatedAt: "2026-06-11T00:00:00.000Z",
  provider: "hubspot",
  users: [{ id: "u1", name: "Dana" }],
  accounts: [{ id: "a1", name: "Acme", domain: "acme.com", ownerId: "u1" }],
  contacts: [],
  deals: [
    { id: "past1", name: "Past 1", accountId: "a1", ownerId: "u1", stage: "qualifiedtobuy", amount: 10000, probability: 20, closeDate: "2026-04-30", isClosed: false },
    { id: "past2", name: "Past 2", accountId: "a1", ownerId: "u1", stage: "presentationscheduled", amount: 5000, probability: 50, closeDate: "2026-05-15", isClosed: false },
    { id: "future1", name: "Future 1", accountId: "a1", ownerId: "u1", stage: "qualifiedtobuy", amount: 18000, probability: 10, closeDate: "2026-08-31", isClosed: false },
    { id: "closedpast", name: "Closed Past", accountId: "a1", ownerId: "u1", stage: "closedwon", amount: 25000, probability: 100, closeDate: "2026-03-31", isClosed: true, isWon: true },
    { id: "noclose", name: "No Close", accountId: "a1", ownerId: "u1", stage: "qualifiedtobuy", amount: 4999, probability: 0, isClosed: false },
  ],
  activities: [],
};

// T1 — parse: comparison tokens, <= before < ordering, unparseable RHS throws.
test("T1 parseWhere: comparison tokens, ordering, and RHS validation", () => {
  assert.deepEqual(parseWhere("closeDate<today"), { field: "closeDate", op: "lt", value: "today", raw: "closeDate<today" });
  assert.equal(parseWhere("amount>5000").op, "gt");
  assert.equal(parseWhere("probability<=20").op, "lte");
  assert.equal(parseWhere("closeDate>=2026-07-01").op, "gte");
  // ordering: <= must win over < + stray "=" (two-char before one-char)
  const lte = parseWhere("probability<=5");
  assert.equal(lte.op, "lte");
  assert.equal(lte.value, "5");
  const gte = parseWhere("amount>=50");
  assert.equal(gte.op, "gte");
  assert.equal(gte.value, "50");
  // unparseable RHS (empty / non-date non-number) throws at parse time
  assert.throws(() => parseWhere("amount>"), /comparison value must be a number/);
  assert.throws(() => parseWhere("closeDate<garbage"), /comparison value must be a number/);
  assert.throws(() => parseWhere("amount>=abc"), /comparison value must be a number/);
  // the throw message for a wholly unparseable expr lists the new tokens
  assert.throws(() => parseWhere("amount"), /field<value, field>value, field<=value, or field>=value/);
});

// T2 — date match: closeDate<today partitions past from future, excludes unset.
test("T2 comparison date match: closeDate<today and its complement", () => {
  const past = buildBulkUpdatePlan(cmpSnapshot, {
    objectType: "deal",
    where: ["closeDate<today", "isClosed=false"],
    set: { closeDate: "2026-06-30" },
    today: cmpToday,
  });
  // open + past: past1, past2. future1 excluded (future), closedpast excluded
  // (isClosed=false), noclose excluded (empty closeDate is not comparable).
  assert.deepEqual(past.operations.map((o) => o.objectId).sort(), ["past1", "past2"]);

  const future = buildBulkUpdatePlan(cmpSnapshot, {
    objectType: "deal",
    where: ["closeDate>=2026-07-01"],
    set: { stage: "qualifiedtobuy" },
    today: cmpToday,
  });
  assert.deepEqual(future.operations.map((o) => o.objectId), ["future1"]);
});

// T3 — numeric match: strict vs inclusive bounds on numeric fields.
test("T3 comparison numeric match: strict and inclusive bounds", () => {
  const gt = buildBulkUpdatePlan(cmpSnapshot, {
    objectType: "deal", where: ["amount>5000"], createTask: "x", today: cmpToday,
  });
  // 10000, 18000, 25000 > 5000; 5000 excluded (strict), 4999 excluded
  assert.deepEqual(gt.operations.map((o) => o.objectId).sort(), ["closedpast", "future1", "past1"]);

  const gte = buildBulkUpdatePlan(cmpSnapshot, {
    objectType: "deal", where: ["amount>=5000"], createTask: "x", today: cmpToday,
  });
  // adds past2 (5000) to the gt set
  assert.deepEqual(gte.operations.map((o) => o.objectId).sort(), ["closedpast", "future1", "past1", "past2"]);

  const lte = buildBulkUpdatePlan(cmpSnapshot, {
    objectType: "deal", where: ["probability<=20"], createTask: "x", today: cmpToday,
  });
  // probability 20 (past1), 10 (future1), 0 (noclose) ≤ 20; 50 and 100 excluded
  assert.deepEqual(lte.operations.map((o) => o.objectId).sort(), ["future1", "noclose", "past1"]);

  // numeric on accounts: employeeCount>=50
  const accSnap = structuredClone(cmpSnapshot);
  accSnap.accounts = [
    { id: "big", name: "Big", domain: "big.com", employeeCount: 80 } as any,
    { id: "small", name: "Small", domain: "small.com", employeeCount: 10 } as any,
  ];
  const emp = buildBulkUpdatePlan(accSnap, {
    objectType: "account", where: ["employeeCount>=50"], createTask: "x", today: cmpToday,
  });
  assert.deepEqual(emp.operations.map((o) => o.objectId), ["big"]);
});

// T4 — no precondition leakage: comparison clauses never become preconditions.
test("T4 comparison clauses do not leak into preconditions", () => {
  const plan = buildBulkUpdatePlan(cmpSnapshot, {
    objectType: "deal",
    where: ["closeDate<today", "isClosed=false"],
    set: { closeDate: "2026-06-30" },
    today: cmpToday,
  });
  // isClosed is excluded from preconditions only because it is a derived
  // (non-readable) field, so add a readable eq clause to prove the COMPARISON
  // clause is the one that is dropped, not the eq.
  const withEq = buildBulkUpdatePlan(cmpSnapshot, {
    objectType: "deal",
    where: ["closeDate<today", "ownerId=u1"],
    set: { stage: "presentationscheduled" },
    today: cmpToday,
  });
  for (const op of withEq.operations) {
    // ownerId (eq, readable, non-written) → precondition; closeDate (lt) → none
    assert.deepEqual(op.preconditions, [{ field: "ownerId", expectedValue: "u1" }]);
    assert.ok(!(op.preconditions ?? []).some((p) => p.field === "closeDate"));
  }
  // and the canonical close-date plan carries no precondition for closeDate
  for (const op of plan.operations) {
    assert.ok(!(op.preconditions ?? []).some((p) => p.field === "closeDate"));
  }
});

// T5 — apply-time round-trip: stored raw strings re-evaluate via eligibleIds.
test("T5 eligibleIds re-parses comparison filters at apply time", () => {
  const plan = buildBulkUpdatePlan(cmpSnapshot, {
    objectType: "deal",
    where: ["closeDate<today", "isClosed=false"],
    set: { closeDate: "2026-06-30" },
    today: cmpToday,
  });
  // the resolved today is persisted on the plan filter for apply-time agreement
  assert.equal(plan.filter?.today, cmpToday);
  // round-trip the stored raw strings + stored today, exactly as connector.ts does
  const ids = eligibleIds(cmpSnapshot, "deal", plan.filter!.where, plan.filter!.today);
  assert.deepEqual([...ids].sort(), ["past1", "past2"]);
  // sanity: a different today shifts the partition (proves today is honored).
  // Nothing in the snapshot closes before 2026-01-01 → empty set.
  const idsEarly = eligibleIds(cmpSnapshot, "deal", ["closeDate<today"], "2026-01-01");
  assert.equal(idsEarly.size, 0);
});

// T6 — alternation: OR (`some`) across comparison alternatives, with the SAME
// operator applied to each (the operator is the token; the value is what splits
// on `|`). See deviation note in the report: the spec's literal example mixes
// `<` and `>` in one clause, which the single-operator grammar cannot express;
// this tests the reachable `some`-OR semantics §2.5 actually defines ("5|10").
test("T6 comparison alternation uses some (OR)", () => {
  const snap = structuredClone(cmpSnapshot);
  snap.deals = [
    { id: "d2025", name: "2025", accountId: "a1", stage: "qualifiedtobuy", closeDate: "2025-06-01", isClosed: false } as any,
    { id: "d2026", name: "2026", accountId: "a1", stage: "qualifiedtobuy", closeDate: "2026-06-01", isClosed: false } as any,
    { id: "d2027", name: "2027", accountId: "a1", stage: "qualifiedtobuy", closeDate: "2027-06-01", isClosed: false } as any,
  ];
  // closeDate < 2026-01-01 OR closeDate < 2025-12-31 → both bound out 2026/2027,
  // so only the 2025 deal qualifies under the looser alternative.
  const plan = buildBulkUpdatePlan(snap, {
    objectType: "deal",
    where: ["closeDate<2026-01-01|2025-12-31"],
    createTask: "review",
    today: cmpToday,
  });
  assert.deepEqual(plan.operations.map((o) => o.objectId), ["d2025"]);

  // numeric `some`-OR: amount>20000 OR amount>5000 ≡ amount>5000 (looser wins)
  const numPlan = buildBulkUpdatePlan(cmpSnapshot, {
    objectType: "deal",
    where: ["amount>20000|5000"],
    createTask: "review",
    today: cmpToday,
  });
  // 10000, 18000, 25000 > 5000; 5000 and 4999 excluded
  assert.deepEqual(numPlan.operations.map((o) => o.objectId).sort(), ["closedpast", "future1", "past1"]);
  // alternation comparison clauses still leak no precondition
  for (const op of plan.operations) assert.equal(op.preconditions, undefined);
});

// T7 — mixed-type safety: type mismatch matches nothing and never throws.
test("T7 comparison mixed-type safety matches nothing without throwing", () => {
  // date field vs numeric RHS: Date.parse("5000") finite? no ISO date → falls
  // to numeric, Number("2026-04-30") is NaN → no match. Must not throw.
  const a = buildBulkUpdatePlan(cmpSnapshot, {
    objectType: "deal", where: ["closeDate<5000"], createTask: "x", today: cmpToday,
  });
  assert.equal(a.operations.length, 0);
  // numeric field vs date RHS: amount>2026-04-30 — Date.parse(amount) not finite
  // (a bare number is not an ISO date), Number("2026-04-30") is NaN → no match.
  const b = buildBulkUpdatePlan(cmpSnapshot, {
    objectType: "deal", where: ["amount>2026-04-30"], createTask: "x", today: cmpToday,
  });
  assert.equal(b.operations.length, 0);
});

// T8 — a `today` literal inside a --guard (not just --where) must pin
// plan.filter.today, or apply-time guard re-evaluation drifts to system-now.
test("T8 comparison: --guard referencing today pins plan.filter.today", () => {
  // --where uses an ABSOLUTE date (no `today`); only the --guard references it.
  const withGuardToday = buildBulkUpdatePlan(cmpSnapshot, {
    objectType: "deal",
    where: ["closeDate<2026-06-11", "isClosed=false"],
    set: { stage: "closedlost" },
    // refuse if any CONTRACTSENT deal closes on/after today — none exist, so the
    // guard is satisfied at plan time and the plan builds; it still references `today`.
    guard: ["deal:stage=contractsent;closeDate>=today:none"],
    today: cmpToday,
  });
  assert.equal(withGuardToday.filter?.today, cmpToday, "guard `today` must persist on plan.filter");

  // No `today` anywhere → not persisted (shape stays stable for non-today plans).
  const noToday = buildBulkUpdatePlan(cmpSnapshot, {
    objectType: "deal",
    where: ["closeDate<2026-06-11"],
    set: { stage: "closedlost" },
    guard: ["deal:stage=contractsent:none"],
    today: cmpToday,
  });
  assert.equal(noToday.filter?.today, undefined, "absent `today` must not persist on plan.filter");
});

// T9 — parse-time strictness: prose/typo RHS that is not a plain number, an ISO
// date shape, or `today` must throw at parse, not silently match nothing.
test("T9 comparison: prose/typo RHS fails loudly at parse", () => {
  for (const bad of ["closeDate<July", "amount>abc", "closeDate<=notadate", "amount>"]) {
    assert.throws(() => parseWhere(bad), /number, an ISO date, or "today"/, `expected ${bad} to throw`);
  }
  // date-shaped and plain-number RHS still parse fine
  assert.doesNotThrow(() => parseWhere("closeDate<2026-06-11"));
  assert.doesNotThrow(() => parseWhere("amount>=5000"));
  assert.doesNotThrow(() => parseWhere("closeDate<today"));
});
