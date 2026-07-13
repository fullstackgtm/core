import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPatchPlan,
  auditSnapshot,
  defaultPolicy,
  sampleSnapshot,
  type GtmConnector,
  type PatchOperation,
  type PatchOperationResult,
} from "../src/index.ts";

function recordingConnector(
  outcome: (operation: PatchOperation) => PatchOperationResult = (operation) => ({
    operationId: operation.id,
    status: "applied",
  }),
) {
  const applied: PatchOperation[] = [];
  const connector: GtmConnector = {
    provider: "mock",
    fetchSnapshot: async () => sampleSnapshot,
    applyOperation: async (operation) => {
      applied.push(operation);
      return outcome(operation);
    },
  };
  return { connector, applied };
}

const plan = auditSnapshot(sampleSnapshot, defaultPolicy("2026-05-03"));

test("apply writes nothing when no operations are approved", async () => {
  const { connector, applied } = recordingConnector();
  const run = await applyPatchPlan(connector, plan, { approvedOperationIds: [] });

  assert.equal(run.status, "rejected");
  assert.equal(applied.length, 0);
  assert.equal(
    run.results.every((result) => result.status === "skipped"),
    true,
  );
});

test("apply only writes explicitly approved operations", async () => {
  const { connector, applied } = recordingConnector();
  const staleOp = plan.operations.find((operation) => operation.field === "next_step_task");
  assert.ok(staleOp);

  const run = await applyPatchPlan(connector, plan, {
    approvedOperationIds: [staleOp.id],
  });

  assert.equal(applied.length, 1);
  assert.equal(applied[0].id, staleOp.id);
  assert.equal(run.status, "applied");
  const skipped = run.results.filter((result) => result.status === "skipped");
  assert.equal(skipped.length, plan.operations.length - 1);
});

test("apply refuses requires_human placeholders without a value override", async () => {
  const { connector, applied } = recordingConnector();
  const ownerOp = plan.operations.find((operation) => operation.field === "ownerId");
  assert.ok(ownerOp);

  const run = await applyPatchPlan(connector, plan, {
    approvedOperationIds: [ownerOp.id],
  });

  assert.equal(applied.length, 0);
  assert.equal(run.status, "rejected");
  const result = run.results.find((entry) => entry.operationId === ownerOp.id);
  assert.equal(result?.status, "skipped");
  assert.match(result?.detail ?? "", /value override/);
});

test("apply substitutes value overrides for placeholders", async () => {
  const { connector, applied } = recordingConnector();
  const ownerOp = plan.operations.find((operation) => operation.field === "ownerId");
  assert.ok(ownerOp);

  const run = await applyPatchPlan(connector, plan, {
    approvedOperationIds: [ownerOp.id],
    valueOverrides: { [ownerOp.id]: "user_rep" },
  });

  assert.equal(applied.length, 1);
  assert.equal(applied[0].afterValue, "user_rep");
  assert.equal(run.status, "applied");
});

test("apply reports partial runs when some operations fail", async () => {
  const ownerOp = plan.operations.find((operation) => operation.field === "ownerId");
  const staleOp = plan.operations.find((operation) => operation.field === "next_step_task");
  assert.ok(ownerOp && staleOp);

  const { connector } = recordingConnector((operation) => ({
    operationId: operation.id,
    status: operation.id === staleOp.id ? "failed" : "applied",
    detail: operation.id === staleOp.id ? "provider error" : undefined,
  }));

  const run = await applyPatchPlan(connector, plan, {
    approvedOperationIds: [ownerOp.id, staleOp.id],
    valueOverrides: { [ownerOp.id]: "user_rep" },
  });

  assert.equal(run.status, "partial");
});

test("apply throws for read-only connectors", async () => {
  const readOnly: GtmConnector = {
    provider: "mock",
    fetchSnapshot: async () => sampleSnapshot,
  };
  await assert.rejects(
    applyPatchPlan(readOnly, plan, { approvedOperationIds: ["op_x"] }),
    /read-only/,
  );
});
