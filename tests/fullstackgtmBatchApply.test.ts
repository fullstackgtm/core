import assert from "node:assert/strict";
import test from "node:test";
import { applyPatchPlan, createHubspotConnector, createSalesforceConnector } from "../src/index.ts";
import type { GtmConnector, PatchOperation, PatchPlan } from "../src/types.ts";

function createOp(id: string, email: string, extra: Record<string, unknown> = {}): PatchOperation {
  return {
    id,
    objectType: "contact",
    objectId: `create:${email}`,
    operation: "create_record",
    beforeValue: null,
    afterValue: { properties: { email, firstname: id }, matchKey: "email", matchValue: email, source: "clay", ...extra },
    reason: "net-new",
    riskLevel: "medium",
    approvalRequired: true,
  };
}

// ---------------------------------------------------------------------------
// HubSpot batch

test("hubspot applyCreateContactsBatch: bulk resolve-first + bulk create, existing skipped", async () => {
  const calls: string[] = [];
  const connector = createHubspotConnector({
    getAccessToken: () => "t",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.includes("/contacts/search")) {
        calls.push("search");
        // "old@x.io" already exists; the others don't.
        return new Response(JSON.stringify({ results: [{ id: "999", properties: { email: "old@x.io" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/contacts/batch/create")) {
        calls.push("batch-create");
        const results = (body.inputs as Array<{ properties: { email: string } }>).map((inp, i) => ({
          id: `new${i}`,
          properties: { email: inp.properties.email },
        }));
        return new Response(JSON.stringify({ results }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch,
  });

  const ops = [createOp("op1", "old@x.io"), createOp("op2", "a@x.io"), createOp("op3", "b@x.io")];
  const results = await connector.applyCreateContactsBatch!(ops);

  assert.equal(results.length, 3);
  assert.equal(results.find((r) => r.operationId === "op1")!.status, "skipped"); // resolve-first declined
  assert.equal(results.find((r) => r.operationId === "op2")!.status, "applied");
  assert.equal(results.find((r) => r.operationId === "op3")!.status, "applied");
  // One search call + one batch-create call for the whole set (not 2 per lead).
  assert.equal(calls.filter((c) => c === "search").length, 1);
  assert.equal(calls.filter((c) => c === "batch-create").length, 1);
});

test("hubspot applyCreateContactsBatch: a rejected batch falls back to per-record creates", async () => {
  let batchAttempts = 0;
  let singleCreates = 0;
  const connector = createHubspotConnector({
    getAccessToken: () => "t",
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/contacts/search")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/contacts/batch/create")) {
        batchAttempts++;
        return new Response("conflict", { status: 409 }); // whole batch rejected
      }
      // per-record create fallback
      singleCreates++;
      return new Response(JSON.stringify({ id: `s${singleCreates}` }), { status: 201, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });

  const ops = [createOp("op1", "a@x.io"), createOp("op2", "b@x.io"), createOp("op3", "c@x.io")];
  const results = await connector.applyCreateContactsBatch!(ops);
  assert.equal(batchAttempts, 1);
  assert.equal(singleCreates, 3, "all three created one at a time after the batch failed");
  assert.ok(results.every((r) => r.status === "applied"));
});

// ---------------------------------------------------------------------------
// Salesforce batch

test("salesforce applyCreateContactsBatch: SOQL IN resolve-first + composite create", async () => {
  const calls: string[] = [];
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "sf", instanceUrl: "https://org.my.salesforce.com" }),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/composite/sobjects")) {
        calls.push("composite");
        const body = JSON.parse(String(init?.body ?? "{}"));
        const records = body.records as Array<unknown>;
        return new Response(JSON.stringify(records.map((_, i) => ({ id: `00Q${i}`, success: true }))), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // SOQL query (GET): "old@x.io" exists
      calls.push("query");
      const soql = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      const records = soql.includes("old@x.io") ? [{ Id: "003OLD", Email: "old@x.io" }] : [];
      return new Response(JSON.stringify({ records, done: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });

  const ops = [createOp("op1", "old@x.io"), createOp("op2", "a@x.io"), createOp("op3", "b@x.io")];
  const results = await connector.applyCreateContactsBatch!(ops);
  assert.equal(results.find((r) => r.operationId === "op1")!.status, "skipped");
  assert.equal(results.find((r) => r.operationId === "op2")!.status, "applied");
  assert.equal(results.find((r) => r.operationId === "op3")!.status, "applied");
  assert.equal(calls.filter((c) => c === "composite").length, 1); // one bulk create call
});

// ---------------------------------------------------------------------------
// applyPatchPlan routing: eligible creates go to the batch path, the rest serial

test("applyPatchPlan routes independent creates to applyCreateContactsBatch, others serial", async () => {
  const batchSeen: string[] = [];
  const serialSeen: string[] = [];
  const connector: GtmConnector = {
    provider: "hubspot",
    fetchSnapshot: async () => ({ generatedAt: "t", provider: "hubspot", users: [], accounts: [], contacts: [], deals: [], activities: [] }),
    applyOperation: async (op) => {
      serialSeen.push(op.id);
      return { operationId: op.id, status: "applied", detail: "serial" };
    },
    applyCreateContactsBatch: async (ops) => {
      batchSeen.push(...ops.map((o) => o.id));
      return ops.map((o) => ({ operationId: o.id, status: "applied" as const, detail: "batch" }));
    },
  };

  const plan = {
    id: "p",
    title: "acquire",
    createdAt: "t",
    status: "approved",
    dryRun: true,
    summary: "",
    findings: [],
    operations: [
      createOp("e1", "a@x.io"),
      createOp("e2", "b@x.io"),
      createOp("e3", "c@x.io"),
      createOp("ineligible", "d@x.io", { associateCompanyName: "Acme" }), // company association → serial
    ],
  } as unknown as PatchPlan;

  const run = await applyPatchPlan(connector, plan, { approvedOperationIds: ["e1", "e2", "e3", "ineligible"], checkConflicts: false });

  assert.deepEqual(batchSeen.sort(), ["e1", "e2", "e3"]);
  assert.deepEqual(serialSeen, ["ineligible"]);
  assert.equal(run.results.filter((r) => r.status === "applied").length, 4);
});
