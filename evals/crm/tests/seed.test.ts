import assert from "node:assert/strict";
import test from "node:test";
import { anonymizeSnapshot } from "../src/seed/anonymize.ts";
import { buildSeededScenarios } from "../src/scenarios/seeded.ts";
import { MockHubspot } from "../src/mock/server.ts";

const snap: any = {
  generatedAt: "2026-06-11T00:00:00.000Z",
  provider: "hubspot",
  users: [{ id: "u1", name: "Ryan Real" }],
  accounts: [
    { id: "a1", name: "Wagmo", domain: "wagmo.io", ownerId: "u1", employeeCount: 50 },
    { id: "a2", name: "Wagmo Inc", domain: "wagmo.io", ownerId: "u1" },
    { id: "a3", name: "Convoso", domain: "convoso.com", ownerId: "u1" },
  ],
  contacts: [
    { id: "c1", firstName: "Jane", lastName: "Doe", email: "jane@wagmo.io", accountId: "a1", ownerId: "u1" },
    { id: "c2", firstName: "Jane", lastName: "Doe", email: "JANE@WAGMO.IO", accountId: "a1" },
  ],
  deals: [
    { id: "d1", name: "Wagmo – Renewal", accountId: "a1", ownerId: "u1", stage: "qualifiedtobuy", amount: 5000, closeDate: "2026-09-30", isClosed: false },
    { id: "d2", name: "Convoso – Won", accountId: "a3", ownerId: "u1", stage: "closedwon", amount: 9000, closeDate: "2026-01-31", isClosed: true, isWon: true },
    { id: "d3", name: "Convoso – Pipeline", accountId: "a3", ownerId: "u1", stage: "qualifiedtobuy", amount: 7000, closeDate: "2026-10-31", isClosed: false },
  ],
  activities: [],
};

test("anonymizer is deterministic and preserves identity relationships", () => {
  const a = anonymizeSnapshot(snap);
  const b = anonymizeSnapshot(snap);
  assert.deepEqual(a, b, "same input must produce identical output");
  // no real strings survive
  const text = JSON.stringify(a).toLowerCase();
  for (const leak of ["wagmo", "convoso", "ryan", "jane", "doe"]) {
    assert.ok(!text.includes(leak), `real value "${leak}" leaked`);
  }
  // shared domain stays shared (dedupe ground truth survives)
  assert.equal(a.accounts[0].domain, a.accounts[1].domain);
  assert.notEqual(a.accounts[0].domain, a.accounts[2].domain);
  // case-variant emails map to the same pseudonym
  assert.equal(a.contacts[0].email, a.contacts[1].email);
  // amounts and stages untouched
  assert.equal(a.deals[0].amount, 5000);
  assert.equal(a.deals[1].stage, "closedwon");
});

test("loadSnapshot remaps the relationship graph onto fresh mock ids", () => {
  const server = new MockHubspot();
  const ids = server.loadSnapshot(snap);
  const dealRec = server.get("deals", ids.dealIds.get("d1")!)!;
  assert.equal([...dealRec.companyAssociations][0], ids.accountIds.get("a1"));
  assert.equal(dealRec.properties.hubspot_owner_id, ids.ownerIds.get("u1"));
  assert.equal(server.active("contacts").length, 2);
});

test("seeded scenarios seed, grade no-op cleanly, and leave headroom", () => {
  for (const scenario of buildSeededScenarios(anonymizeSnapshot(snap), 7)) {
    const server = new MockHubspot();
    const ctx = scenario.setup(server);
    const grade = scenario.grade(server, ctx);
    assert.ok(grade.maxScore > 0, `${scenario.id}: maxScore`);
    assert.ok(grade.taskScore < grade.maxScore, `${scenario.id}: no-op must not be perfect`);
    assert.equal(grade.violations.length, 0, `${scenario.id}: no-op violations`);
  }
  // determinism: same snapshot + seed → same planted ground truth
  const s1 = buildSeededScenarios(anonymizeSnapshot(snap), 7)[0];
  const s2 = buildSeededScenarios(anonymizeSnapshot(snap), 7)[0];
  const ctx1 = s1.setup(new MockHubspot());
  const ctx2 = s2.setup(new MockHubspot());
  assert.deepEqual(JSON.stringify(ctx1), JSON.stringify(ctx2));
});
