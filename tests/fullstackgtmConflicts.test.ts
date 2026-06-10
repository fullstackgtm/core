import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPatchPlan,
  auditSnapshot,
  createHubspotConnector,
  createSalesforceConnector,
  defaultPolicy,
  sampleSnapshot,
  type GtmConnector,
  type PatchOperation,
} from "../src/index.ts";

const plan = auditSnapshot(sampleSnapshot, defaultPolicy("2026-05-03"));
const ownerOp = plan.operations.find((operation) => operation.field === "ownerId")!;

function conflictAwareConnector(liveValues: Record<string, unknown>) {
  const applied: PatchOperation[] = [];
  const connector: GtmConnector = {
    provider: "mock",
    fetchSnapshot: async () => sampleSnapshot,
    applyOperation: async (operation) => {
      applied.push(operation);
      return { operationId: operation.id, status: "applied" };
    },
    readField: async (_type, objectId, field) => liveValues[`${objectId}.${field}`] ?? null,
  };
  return { connector, applied };
}

test("apply refuses writes when the provider value drifted since the plan", async () => {
  // The plan expects ownerId to be empty; meanwhile a human assigned one.
  const { connector, applied } = conflictAwareConnector({
    [`${ownerOp.objectId}.ownerId`]: "user_someone_else",
  });

  const run = await applyPatchPlan(connector, plan, {
    approvedOperationIds: [ownerOp.id],
    valueOverrides: { [ownerOp.id]: "user_ada" },
  });

  assert.equal(applied.length, 0);
  const result = run.results.find((entry) => entry.operationId === ownerOp.id);
  assert.equal(result?.status, "conflict");
  assert.match(result?.detail ?? "", /drifted since the plan/);
  assert.deepEqual(result?.providerData, { currentValue: "user_someone_else" });
});

test("apply proceeds when the live value still matches the plan", async () => {
  const { connector, applied } = conflictAwareConnector({
    [`${ownerOp.objectId}.ownerId`]: null,
  });

  const run = await applyPatchPlan(connector, plan, {
    approvedOperationIds: [ownerOp.id],
    valueOverrides: { [ownerOp.id]: "user_ada" },
  });

  assert.equal(applied.length, 1);
  assert.equal(run.status, "applied");
});

test("checkConflicts: false opts out explicitly", async () => {
  const { connector, applied } = conflictAwareConnector({
    [`${ownerOp.objectId}.ownerId`]: "user_someone_else",
  });

  const run = await applyPatchPlan(connector, plan, {
    approvedOperationIds: [ownerOp.id],
    valueOverrides: { [ownerOp.id]: "user_ada" },
    checkConflicts: false,
  });

  assert.equal(applied.length, 1);
  assert.equal(run.status, "applied");
});

test("hubspot readField fetches the mapped live property", async () => {
  const calls: string[] = [];
  const connector = createHubspotConnector({
    getAccessToken: () => "t",
    fetchImpl: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ properties: { hs_next_step: "Call champion" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });

  const value = await connector.readField("deal", "d1", "nextStep");
  assert.equal(value, "Call champion");
  assert.match(calls[0], /objects\/deals\/d1\?properties=hs_next_step/);
});

test("salesforce readField fetches the mapped live field", async () => {
  const calls: string[] = [];
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "t", instanceUrl: "https://org.my.salesforce.com" }),
    fetchImpl: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ NextStep: "Security review" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });

  const value = await connector.readField("deal", "006A", "nextStep");
  assert.equal(value, "Security review");
  assert.match(calls[0], /sobjects\/Opportunity\/006A\?fields=NextStep/);
});
