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

function setFieldOp(id: string, objectId = id, beforeValue: unknown = "old"): PatchOperation {
  return {
    id,
    objectType: "deal",
    objectId,
    operation: "set_field",
    field: "nextStep",
    beforeValue,
    afterValue: `new-${id}`,
    reason: "batch update",
    riskLevel: "low",
    approvalRequired: true,
  };
}

function archiveOp(id: string): PatchOperation {
  return {
    id,
    objectType: "contact",
    objectId: id,
    operation: "archive_record",
    reason: "batch delete",
    riskLevel: "high",
    approvalRequired: true,
    forceArchiveDuplicate: true,
  };
}

function planWith(operations: PatchOperation[]): PatchPlan {
  return { id: "p_batch", title: "batch", createdAt: "t", status: "approved", dryRun: true, summary: "", findings: [], operations } as PatchPlan;
}

test("hubspot apply batches 250 set_field ops into 100/100/50 batch updates with batched CAS reads", async () => {
  const updateSizes: number[] = [];
  const readSizes: number[] = [];
  const connector = createHubspotConnector({
    getAccessToken: () => "t",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.includes("/deals/batch/read")) {
        readSizes.push(body.inputs.length);
        return new Response(JSON.stringify({ results: body.inputs.map((inp: { id: string }) => ({ id: inp.id, properties: { hs_next_step: "old" } })) }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/deals/batch/update")) {
        updateSizes.push(body.inputs.length);
        return new Response(JSON.stringify({ results: body.inputs.map((inp: { id: string }) => ({ id: inp.id })) }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch,
  });
  const ops = Array.from({ length: 250 }, (_, i) => setFieldOp(`op${i}`, `d${i}`));

  const run = await applyPatchPlan(connector, planWith(ops), { approvedOperationIds: ops.map((op) => op.id) });

  assert.deepEqual(readSizes, [100, 100, 50]);
  assert.deepEqual(updateSizes, [100, 100, 50]);
  assert.equal(run.results.filter((r) => r.status === "applied").length, 250);
});

test("hubspot batch set_field conflicts drifted records and normalizes closeDate", async () => {
  let writtenIds: string[] = [];
  const connector = createHubspotConnector({
    getAccessToken: () => "t",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.includes("/deals/batch/read")) {
        return new Response(JSON.stringify({ results: [
          { id: "d1", properties: { closedate: "2026-03-07T00:00:00Z" } },
          { id: "d2", properties: { closedate: "2026-03-08T00:00:00Z" } },
          { id: "d3", properties: { closedate: "2026-03-07" } },
        ] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/deals/batch/update")) {
        writtenIds = body.inputs.map((inp: { id: string }) => inp.id);
        return new Response(JSON.stringify({ results: body.inputs.map((inp: { id: string }) => ({ id: inp.id })) }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch,
  });
  const ops = ["d1", "d2", "d3"].map((id, i) => ({ ...setFieldOp(`op${i + 1}`, id, "2026-03-07"), field: "closeDate", afterValue: "2026-04-01" }));

  const run = await applyPatchPlan(connector, planWith(ops), { approvedOperationIds: ops.map((op) => op.id) });

  assert.deepEqual(writtenIds, ["d1", "d3"]);
  assert.equal(run.results.find((r) => r.operationId === "op2")?.status, "conflict");
});

test("hubspot batch set_field maps per-record errors to the right operation ids", async () => {
  const connector = createHubspotConnector({
    getAccessToken: () => "t",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.includes("/deals/batch/read")) {
        return new Response(JSON.stringify({ results: body.inputs.map((inp: { id: string }) => ({ id: inp.id, properties: { hs_next_step: "old" } })) }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/deals/batch/update")) {
        return new Response(JSON.stringify({
          results: [{ id: "d1" }, { id: "d3" }],
          errors: [{ message: "bad value", context: { ids: ["d2"] } }],
        }), { status: 207, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch,
  });
  const ops = [setFieldOp("op1", "d1"), setFieldOp("op2", "d2"), setFieldOp("op3", "d3")];

  const run = await applyPatchPlan(connector, planWith(ops), { approvedOperationIds: ops.map((op) => op.id) });

  assert.equal(run.results.find((r) => r.operationId === "op1")?.status, "applied");
  assert.equal(run.results.find((r) => r.operationId === "op2")?.status, "failed");
  assert.match(run.results.find((r) => r.operationId === "op2")?.detail ?? "", /bad value/);
  assert.equal(run.results.find((r) => r.operationId === "op3")?.status, "applied");
});

test("hubspot apply batches archive_record into 100/100/50 batch archives", async () => {
  const archiveSizes: number[] = [];
  const connector = createHubspotConnector({
    getAccessToken: () => "t",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/contacts/batch/archive")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        archiveSizes.push(body.inputs.length);
        return new Response(JSON.stringify({ results: body.inputs.map((inp: { id: string }) => ({ id: inp.id })) }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch,
  });
  const ops = Array.from({ length: 250 }, (_, i) => archiveOp(`c${i}`));

  const run = await applyPatchPlan(connector, planWith(ops), { approvedOperationIds: ops.map((op) => op.id), checkConflicts: false });

  assert.deepEqual(archiveSizes, [100, 100, 50]);
  assert.equal(run.results.filter((r) => r.status === "applied").length, 250);
});

test("applyBatchLimit differs by connector: Salesforce uses 200 and HubSpot uses 100", () => {
  const sf = createSalesforceConnector({ getConnection: () => ({ accessToken: "sf", instanceUrl: "https://org.my.salesforce.com" }) });
  const hs = createHubspotConnector({ getAccessToken: () => "t" });
  assert.equal(sf.applyBatchLimit, 200);
  assert.equal(hs.applyBatchLimit, 100);
});

test("salesforce apply batches 450 set_field ops into 200/200/50 composite updates with batched CAS reads", async () => {
  const compositeSizes: number[] = [];
  let casReads = 0;
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "sf", instanceUrl: "https://org.my.salesforce.com" }),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/composite/sobjects") && init?.method === "PATCH") {
        const records = JSON.parse(String(init.body)).records as unknown[];
        compositeSizes.push(records.length);
        return new Response(JSON.stringify(records.map((_, i) => ({ id: `id${i}`, success: true }))), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      casReads++;
      const rows = Array.from({ length: 450 }, (_, i) => ({ Id: `d${i}`, NextStep: "old" }));
      return new Response(JSON.stringify({ records: rows }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  const ops = Array.from({ length: 450 }, (_, i) => setFieldOp(`op${i}`, `d${i}`));

  const run = await applyPatchPlan(connector, planWith(ops), { approvedOperationIds: ops.map((op) => op.id) });

  assert.deepEqual(compositeSizes, [200, 200, 50]);
  assert.equal(casReads, 3);
  assert.equal(run.results.filter((r) => r.status === "applied").length, 450);
});

test("salesforce batch set_field conflicts drifted records and omits them from composite write", async () => {
  let writtenIds: string[] = [];
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "sf", instanceUrl: "https://org.my.salesforce.com" }),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/composite/sobjects") && init?.method === "PATCH") {
        const records = JSON.parse(String(init.body)).records as Array<{ Id: string }>;
        writtenIds = records.map((record) => record.Id);
        return new Response(JSON.stringify(records.map((record) => ({ id: record.Id, success: true }))), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ records: [{ Id: "d1", NextStep: "old" }, { Id: "d2", NextStep: "drifted" }, { Id: "d3", NextStep: "old" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  const ops = [setFieldOp("op1", "d1"), setFieldOp("op2", "d2"), setFieldOp("op3", "d3")];

  const run = await applyPatchPlan(connector, planWith(ops), { approvedOperationIds: ops.map((op) => op.id) });

  assert.deepEqual(writtenIds, ["d1", "d3"]);
  assert.equal(run.results.find((r) => r.operationId === "op2")?.status, "conflict");
});

test("salesforce batch set_field maps composite record errors to the right operation ids", async () => {
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "sf", instanceUrl: "https://org.my.salesforce.com" }),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/composite/sobjects") && init?.method === "PATCH") {
        return new Response(JSON.stringify([
          { id: "d1", success: true },
          { id: "d2", success: false, errors: [{ statusCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION", message: "bad value" }] },
          { id: "d3", success: true },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ records: [{ Id: "d1", NextStep: "old" }, { Id: "d2", NextStep: "old" }, { Id: "d3", NextStep: "old" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  const ops = [setFieldOp("op1", "d1"), setFieldOp("op2", "d2"), setFieldOp("op3", "d3")];

  const run = await applyPatchPlan(connector, planWith(ops), { approvedOperationIds: ops.map((op) => op.id) });

  assert.equal(run.results.find((r) => r.operationId === "op1")?.status, "applied");
  assert.equal(run.results.find((r) => r.operationId === "op2")?.status, "failed");
  assert.match(run.results.find((r) => r.operationId === "op2")?.detail ?? "", /bad value/);
  assert.equal(run.results.find((r) => r.operationId === "op3")?.status, "applied");
});

test("salesforce apply batches archive_record via composite delete", async () => {
  const deleteSizes: number[] = [];
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "sf", instanceUrl: "https://org.my.salesforce.com" }),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/composite/sobjects") && init?.method === "DELETE") {
        const ids = new URL(url).searchParams.get("ids")?.split(",") ?? [];
        deleteSizes.push(ids.length);
        return new Response(JSON.stringify(ids.map((id) => ({ id, success: true }))), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch,
  });
  const ops = Array.from({ length: 250 }, (_, i) => archiveOp(`c${i}`));

  const run = await applyPatchPlan(connector, planWith(ops), { approvedOperationIds: ops.map((op) => op.id), checkConflicts: false });

  assert.deepEqual(deleteSizes, [200, 50]);
  assert.equal(run.results.filter((r) => r.status === "applied").length, 250);
});

test("connectors without applyBatch still use the sequential applyOperation path", async () => {
  const seen: string[] = [];
  const connector: GtmConnector = {
    provider: "mock",
    fetchSnapshot: async () => ({ generatedAt: "t", provider: "mock", users: [], accounts: [], contacts: [], deals: [], activities: [] }),
    readField: async () => "old",
    applyOperation: async (op) => {
      seen.push(op.id);
      return { operationId: op.id, status: "applied" };
    },
  };
  const ops = [setFieldOp("op1", "d1"), setFieldOp("op2", "d2"), setFieldOp("op3", "d3")];

  const run = await applyPatchPlan(connector, planWith(ops), { approvedOperationIds: ops.map((op) => op.id) });

  assert.deepEqual(seen, ["op1", "op2", "op3"]);
  assert.equal(run.results.filter((r) => r.status === "applied").length, 3);
});
