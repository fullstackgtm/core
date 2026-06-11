import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPatchPlan,
  auditSnapshot,
  createHubspotConnector,
  defaultPolicy,
  generateDemoSnapshot,
} from "../src/index.ts";

/**
 * End-to-end proof that the connector implements every operation the built-in
 * rules emit: an audit plan over the demo dataset contains set_field,
 * link_record, and create_task operations. With value overrides supplied for
 * the human-decision fields, applying the whole plan must leave NOTHING
 * skipped for being unsupported — the apply path is feature-complete, not a
 * single-operation stub.
 */
test("every operation a built-in audit emits is applied by the HubSpot connector", async () => {
  const snapshot = generateDemoSnapshot();
  const plan = auditSnapshot(snapshot, defaultPolicy("2026-06-09"));

  const operationKinds = new Set(plan.operations.map((operation) => operation.operation));
  // Sanity: the demo plan really does exercise the operations beyond set_field.
  assert.ok(operationKinds.has("set_field"));
  assert.ok(operationKinds.has("link_record"));
  assert.ok(operationKinds.has("create_task"));
  assert.ok(operationKinds.has("merge_records"));

  // Accept every write; record what got called.
  const methods: string[] = [];
  const connector = createHubspotConnector({
    getAccessToken: () => "t",
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ id: "x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });

  // Supply concrete values for the requires_human_* placeholders so apply
  // doesn't (correctly) skip them, and approve every operation.
  const valueOverrides: Record<string, unknown> = {};
  for (const operation of plan.operations) {
    if (typeof operation.afterValue === "string" && operation.afterValue.startsWith("requires_human_")) {
      // Owners/accounts need an id; dates need a date; merges need a survivor
      // FROM the duplicate group — any other concrete value works for the stub.
      valueOverrides[operation.id] =
        operation.operation === "merge_records" && Array.isArray(operation.beforeValue)
          ? String(operation.beforeValue[0])
          : operation.field === "closeDate"
            ? "2026-12-31"
            : "user_01";
    }
  }

  const run = await applyPatchPlan(connector, plan, {
    approvedOperationIds: plan.operations.map((operation) => operation.id),
    valueOverrides,
    // The stub always echoes {id:"x"}, which wouldn't match beforeValue;
    // conflict-checking isn't what this test exercises.
    checkConflicts: false,
  });

  const skippedAsUnsupported = run.results.filter(
    (result) => result.status === "skipped" && /does not support|Unknown operation/.test(result.detail ?? ""),
  );
  assert.deepEqual(skippedAsUnsupported, [], "no operation should be skipped as unsupported");
  assert.equal(
    run.results.every((result) => result.status === "applied"),
    true,
    `all operations applied; got ${JSON.stringify(run.results.filter((r) => r.status !== "applied"))}`,
  );
  assert.equal(run.status, "applied");
});
