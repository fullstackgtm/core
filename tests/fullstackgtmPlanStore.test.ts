import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  applyPatchPlan,
  auditSnapshot,
  createFilePlanStore,
  defaultPolicy,
  sampleSnapshot,
  type GtmConnector,
} from "../src/index.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const plan = auditSnapshot(sampleSnapshot, defaultPolicy("2026-05-03"));

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-plans-"));
  return { store: createFilePlanStore(dir), dir };
}

test("plan store persists the full lifecycle: save, approve, run", async () => {
  const { store, dir } = tempStore();
  try {
    await store.save(plan);
    let stored = await store.get(plan.id);
    assert.equal(stored?.status, "needs_approval");
    assert.deepEqual(stored?.approvedOperationIds, []);

    const staleOp = plan.operations.find((operation) => operation.field === "next_step_task")!;
    stored = await store.approveOperations(plan.id, [staleOp.id], {});
    assert.equal(stored.status, "approved");
    assert.deepEqual(stored.approvedOperationIds, [staleOp.id]);

    const connector: GtmConnector = {
      provider: "mock",
      fetchSnapshot: async () => sampleSnapshot,
      applyOperation: async (operation) => ({ operationId: operation.id, status: "applied" }),
    };
    const run = await applyPatchPlan(connector, stored.plan, {
      approvedOperationIds: stored.approvedOperationIds,
      valueOverrides: stored.valueOverrides,
    });
    stored = await store.recordRun(plan.id, run);
    assert.equal(stored.status, "applied");
    assert.equal(stored.runs.length, 1);
    assert.equal(stored.runs[0].status, "applied");

    await assert.rejects(store.approveOperations(plan.id, [staleOp.id]), /already been applied/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan store refuses unknown operations and rejected plans", async () => {
  const { store, dir } = tempStore();
  try {
    await store.save(plan);
    await assert.rejects(store.approveOperations(plan.id, ["op_nope"]), /no operation op_nope/);

    await store.reject(plan.id);
    const stored = await store.get(plan.id);
    assert.equal(stored?.status, "rejected");
    assert.deepEqual(stored?.approvedOperationIds, []);
    await assert.rejects(
      store.approveOperations(plan.id, [plan.operations[0].id]),
      /was rejected/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli plan lifecycle: audit --save, plans approve, apply --plan-id gating", () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-plans-cli-"));
  try {
    const env: Record<string, string | undefined> = { ...process.env, FSGTM_HOME: home };
    delete env.HUBSPOT_ACCESS_TOKEN;
    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        ["--experimental-strip-types", "src/bin.ts", ...args],
        { cwd: repoRoot, encoding: "utf8", env: env as NodeJS.ProcessEnv },
      );

    const audit = run(["audit", "--sample", "--today", "2026-05-03", "--json", "--save"]);
    assert.equal(audit.status, 0, audit.stderr);
    const savedPlan = JSON.parse(audit.stdout);
    assert.match(audit.stderr, /Saved plan/);

    const list = run(["plans", "list", "--json"]);
    assert.equal(list.status, 0, list.stderr);
    const plans = JSON.parse(list.stdout);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].id, savedPlan.id);
    assert.equal(plans[0].status, "needs_approval");

    // Apply must be refused before approval — the store is the gate.
    const premature = run(["apply", "--plan-id", savedPlan.id, "--provider", "hubspot"]);
    assert.equal(premature.status, 1);
    assert.match(premature.stderr, /approve operations first/);

    const approve = run([
      "plans", "approve", savedPlan.id, "--operations", savedPlan.operations[0].id,
    ]);
    assert.equal(approve.status, 0, approve.stderr);
    assert.match(approve.stdout, /Approved 1 operation/);

    const show = run(["plans", "show", savedPlan.id, "--json"]);
    assert.equal(show.status, 0);
    assert.equal(JSON.parse(show.stdout).status, "approved");

    // Approved apply now proceeds past the store gate and fails only on
    // missing provider credentials — proving the gate ordering.
    const apply = run(["apply", "--plan-id", savedPlan.id, "--provider", "hubspot"]);
    assert.equal(apply.status, 1);
    assert.match(apply.stderr, /No HubSpot credentials/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
