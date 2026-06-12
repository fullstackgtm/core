import assert from "node:assert/strict";
import test from "node:test";
import { buildReassignPlans } from "../src/reassign.ts";
import type { CanonicalGtmSnapshot } from "../src/types.ts";

const snapshot: CanonicalGtmSnapshot = {
  generatedAt: "2026-06-11T00:00:00.000Z",
  provider: "hubspot",
  users: [
    { id: "101", name: "Alex Rivera" },
    { id: "102", name: "Casey Okafor" },
    { id: "103", name: "Blair Chen" },
  ],
  accounts: [
    { id: "a1", name: "EMEA GmbH", domain: "emea.de", ownerId: "102" },
    { id: "a2", name: "EMEA SARL", domain: "emea.fr", ownerId: "102" }, // has a contractsent deal
    { id: "a3", name: "US Inc", domain: "us.com", ownerId: "102" }, // non-EMEA
    { id: "a4", name: "EMEA Ltd", domain: "emea.co.uk", ownerId: "101" }, // not Casey's
  ],
  contacts: [
    { id: "c1", firstName: "A", lastName: "One", email: "a@emea.de", accountId: "a1", ownerId: "102" },
    { id: "c2", firstName: "B", lastName: "Two", email: "b@emea.fr", accountId: "a2", ownerId: "102" }, // excluded: account in exception
    { id: "c3", firstName: "C", lastName: "Three", email: "c@us.com", accountId: "a3", ownerId: "102" }, // excluded: non-EMEA
  ],
  deals: [
    { id: "d1", name: "EMEA GmbH – Expansion", accountId: "a1", ownerId: "102", stage: "qualifiedtobuy", isClosed: false },
    { id: "d2", name: "EMEA GmbH – Won", accountId: "a1", ownerId: "102", stage: "closedwon", isClosed: true, isWon: true },
    { id: "d3", name: "EMEA SARL – Contract", accountId: "a2", ownerId: "102", stage: "contractsent", isClosed: false },
    { id: "d4", name: "EMEA SARL – Side", accountId: "a2", ownerId: "102", stage: "qualifiedtobuy", isClosed: false }, // excluded: account has contractsent
    { id: "d5", name: "US Inc – Pipeline", accountId: "a3", ownerId: "102", stage: "qualifiedtobuy", isClosed: false },
  ],
  activities: [],
};

const EMEA = "domain~.de|.fr|.co.uk";

test("reassign compiles one plan per object type with ownerId filter and --set ownerId", () => {
  const plans = buildReassignPlans(snapshot, { fromOwnerId: "102", toOwnerId: "103" });
  assert.equal(plans.length, 3);
  const [accounts, contacts, deals] = plans;
  assert.deepEqual(accounts.filter, { objectType: "account", where: ["ownerId=102"] });
  assert.deepEqual(contacts.filter, { objectType: "contact", where: ["ownerId=102"] });
  // closed deals keep their historical owner by default
  assert.deepEqual(deals.filter, { objectType: "deal", where: ["ownerId=102", "isClosed=false"] });
  assert.ok(!deals.operations.some((op) => op.objectId === "d2"), "closed deal excluded");
  for (const plan of plans) {
    assert.equal(plan.dryRun, true);
    assert.ok(plan.operations.every((op) => op.operation === "set_field" && op.field === "ownerId" && op.afterValue === "103"));
    assert.ok(plan.operations.every((op) => op.approvalRequired));
  }
  // distinct plan ids — these are saved side by side
  assert.equal(new Set(plans.map((p) => p.id)).size, 3);
});

test("--where extras are account-lifted for contacts and deals; --except-deal-stage excludes end to end", () => {
  const plans = buildReassignPlans(snapshot, {
    fromOwnerId: "102",
    toOwnerId: "103",
    where: [EMEA],
    exceptDealStage: "contractsent",
  });
  const [accounts, contacts, deals] = plans;
  assert.deepEqual(accounts.filter!.where, ["ownerId=102", EMEA, "openDealStages!~contractsent"]);
  assert.deepEqual(contacts.filter!.where, [
    "ownerId=102",
    `account.${EMEA}`,
    "account.openDealStages!~contractsent",
  ]);
  assert.deepEqual(deals.filter!.where, [
    "ownerId=102",
    "isClosed=false",
    `account.${EMEA}`,
    "stage!=contractsent",
    "account.openDealStages!~contractsent",
  ]);

  // a1 hands off fully; a2 (open contractsent deal) and a3 (non-EMEA) stay
  assert.deepEqual(accounts.operations.map((op) => op.objectId), ["a1"]);
  assert.deepEqual(contacts.operations.map((op) => op.objectId), ["c1"]);
  assert.deepEqual(deals.operations.map((op) => op.objectId), ["d1"]);
});

test("--objects narrows which plans are compiled; --include-closed-deals widens the deal plan", () => {
  const dealOnly = buildReassignPlans(snapshot, {
    fromOwnerId: "102",
    toOwnerId: "103",
    objects: ["deal"],
    includeClosedDeals: true,
  });
  assert.equal(dealOnly.length, 1);
  assert.deepEqual(dealOnly[0].filter!.where, ["ownerId=102"]);
  assert.ok(dealOnly[0].operations.some((op) => op.objectId === "d2"), "closed deal included on request");
});

test("reassign validates owners and objects loudly", () => {
  assert.throws(
    () => buildReassignPlans(snapshot, { fromOwnerId: "102", toOwnerId: "999" }),
    /not a known user/,
  );
  assert.throws(
    () => buildReassignPlans(snapshot, { fromOwnerId: "102", toOwnerId: "102" }),
    /same owner/,
  );
  assert.throws(
    () => buildReassignPlans(snapshot, { fromOwnerId: "", toOwnerId: "103" }),
    /--from <ownerId> and --to <ownerId>/,
  );
  assert.throws(
    () =>
      buildReassignPlans(snapshot, {
        fromOwnerId: "102",
        toOwnerId: "103",
        objects: ["company" as never],
      }),
    /supports account, contact, deal/,
  );
  // unknown extra fields still fail strict validation (no silent vacuous filters)
  assert.throws(
    () =>
      buildReassignPlans(snapshot, { fromOwnerId: "102", toOwnerId: "103", where: ["region=emea"] }),
    /Unknown field/,
  );
});

test("apply re-verifies the exception per record: mid-run drift into the excluded stage conflicts out", async () => {
  const { applyPatchPlan } = await import("../src/connector.ts");
  const plans = buildReassignPlans(snapshot, {
    fromOwnerId: "102",
    toOwnerId: "103",
    where: [EMEA],
    exceptDealStage: "contractsent",
  });
  const accounts = plans[0];
  assert.deepEqual(accounts.operations.map((op) => op.objectId), ["a1"]);

  // drift AFTER planning: a1 gains an open contractsent deal → exception set grew
  const drifted = structuredClone(snapshot);
  drifted.deals.push({ id: "d9", name: "Late Contract", accountId: "a1", ownerId: "102", stage: "contractsent", isClosed: false });
  const writes: string[] = [];
  const connector = {
    provider: "hubspot" as const,
    fetchSnapshot: async () => drifted,
    applyOperation: async (op: any) => {
      writes.push(op.objectId);
      return { operationId: op.id, status: "applied" as const };
    },
    readField: async (_t: unknown, id: string, field: string) =>
      (drifted.accounts.find((a) => a.id === id) as any)?.[field] ?? null,
  };
  const run = await applyPatchPlan(connector as any, accounts, {
    approvedOperationIds: accounts.operations.map((op) => op.id),
  });
  assert.equal(run.results[0].status, "conflict");
  assert.match(run.results[0].detail ?? "", /no longer matches the plan's filter/);
  assert.deepEqual(writes, []);
});
