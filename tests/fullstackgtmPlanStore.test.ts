import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform } from "node:process";
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
const posix = platform !== "win32";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-plans-"));
  return { store: createFilePlanStore(dir), dir };
}

test("custom plan store rejects a symlinked directory without touching its victim", { skip: !posix }, async () => {
  const root = mkdtempSync(join(tmpdir(), "fsgtm-plans-link-"));
  try {
    const victim = join(root, "victim");
    writeFileSync(victim, "sentinel");
    const linkedDirectory = join(root, "plans");
    // A directory target proves the plan store cannot traverse the link; the
    // separate victim proves the failed operation causes no collateral write.
    symlinkSync(root, linkedDirectory);
    const store = createFilePlanStore(linkedDirectory);
    await assert.rejects(store.save(plan), /symbolic link/i);
    assert.equal(readFileSync(victim, "utf8"), "sentinel");
    await assert.rejects(store.get(plan.id), /symbolic link/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    const claim = await store.claimApply(plan.id, { provider: "mock", source: "cli" });
    assert.equal(claim.stored.status, "applying");
    stored = await store.recordRun(plan.id, run, claim.claimId);
    assert.equal(stored.status, "applied");
    assert.equal(stored.runs.length, 1);
    assert.equal(stored.runs[0].status, "applied");

    await assert.rejects(store.approveOperations(plan.id, [staleOp.id]), /already been applied/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replica reconciliation replaces approval subsets and imports terminal receipts exactly once", async () => {
  const { store, dir } = tempStore();
  try {
    await store.save(plan);
    const [first, second] = plan.operations;
    assert.ok(first && second);
    await store.approveOperations(plan.id, [first.id, second.id]);
    let reconciled = await store.reconcileReplica(plan.id, {
      status: "approved", approvedOperationIds: [second.id], valueOverrides: {},
    });
    assert.equal(reconciled.changed, true);
    assert.deepEqual(reconciled.stored.approvedOperationIds, [second.id]);
    const run = {
      planId: plan.id, provider: "hubspot" as const,
      startedAt: "2026-07-10T00:00:00.000Z", finishedAt: "2026-07-10T00:00:01.000Z",
      status: "applied" as const, results: [{ operationId: second.id, status: "applied" as const }],
    };
    reconciled = await store.reconcileReplica(plan.id, {
      status: "applied", approvedOperationIds: [second.id], valueOverrides: {}, run,
    });
    assert.equal(reconciled.stored.status, "applied");
    assert.equal(reconciled.stored.runs.length, 1);
    reconciled = await store.reconcileReplica(plan.id, {
      status: "applied", approvedOperationIds: [second.id], valueOverrides: {}, run,
    });
    assert.equal(reconciled.changed, false);
    assert.equal(reconciled.stored.runs.length, 1);
    const delayed = await store.reconcileReplica(plan.id, {
      status: "rejected", approvedOperationIds: [],
    });
    assert.equal(delayed.changed, false);
    assert.equal(delayed.stored.status, "applied");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hosted execution claim identity is durable across run completion", async () => {
  const { store, dir } = tempStore();
  try {
    await store.save(plan);
    const operation = plan.operations[0]!;
    await store.approveOperations(plan.id, [operation.id]);
    const claimed = await store.claimApply(plan.id, { provider: "hubspot", source: "cli" });
    const attached = await store.recordHostedClaim(plan.id, claimed.claimId, "hosted-claim-1");
    assert.equal(attached.applyClaim?.hostedClaimId, "hosted-claim-1");
    const run = {
      planId: plan.id, provider: "hubspot" as const,
      startedAt: "2026-07-10T00:00:00.000Z", finishedAt: "2026-07-10T00:00:01.000Z",
      status: "applied" as const, results: [{ operationId: operation.id, status: "applied" as const }],
    };
    const finished = await store.recordRun(plan.id, run, claimed.claimId);
    assert.equal(finished.applyAttempts?.at(-1)?.hostedClaimId, "hosted-claim-1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("plan store grants exactly one apply claim and requires it to record the run", async () => {
  const { store, dir } = tempStore();
  try {
    await store.save(plan);
    const operation = plan.operations[0];
    await store.approveOperations(plan.id, [operation.id]);

    const claim = await store.claimApply(plan.id, { provider: "mock", source: "cli" });
    assert.equal(claim.stored.status, "applying");
    await assert.rejects(store.claimApply(plan.id, { provider: "mock", source: "cli" }), /already applying/);
    await assert.rejects(store.approveOperations(plan.id, [operation.id]), /approvals are frozen/);
    await assert.rejects(store.reject(plan.id), /cannot be rejected/);
    await assert.rejects(store.save(plan), /refusing to replace/);

    const run = await applyPatchPlan({
      provider: "mock",
      fetchSnapshot: async () => sampleSnapshot,
      applyOperation: async (op) => ({ operationId: op.id, status: "applied" }),
    }, claim.stored.plan, {
      approvedOperationIds: claim.stored.approvedOperationIds,
      valueOverrides: claim.stored.valueOverrides,
    });

    await assert.rejects(store.recordRun(plan.id, run, "wrong-claim"), /does not match/);
    const finished = await store.recordRun(plan.id, run, claim.claimId);
    assert.equal(finished.status, "applied");
    assert.equal(finished.applyClaim, undefined);
    assert.equal(finished.runs.length, 1);
    await assert.rejects(store.recordRun(plan.id, run, claim.claimId), /missing or does not match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uncertain apply recovery is explicit, never replays, and clears approval", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-plans-recover-"));
  try {
    const store = createFilePlanStore(join(home, "plans"));
    await store.save(plan);
    await store.approveOperations(plan.id, [plan.operations[0].id]);
    const claim = await store.claimApply(plan.id, { provider: "hubspot", source: "cli" });
    await store.markApplyUncertain(plan.id, claim.claimId);

    const env = { ...process.env, FSGTM_HOME: home } as NodeJS.ProcessEnv;
    const run = (args: string[]) => spawnSync(
      process.execPath,
      ["--experimental-strip-types", "src/bin.ts", ...args],
      { cwd: repoRoot, encoding: "utf8", env },
    );
    const refused = run(["plans", "recover", plan.id]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Inspect the affected records|do not replay automatically/i);
    assert.equal((await store.get(plan.id))?.status, "applying");

    const recovered = run(["plans", "recover", plan.id, "--acknowledge-uncertain-writes"]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /No writes were replayed/);
    const stored = await store.get(plan.id);
    assert.equal(stored?.status, "needs_approval");
    assert.deepEqual(stored?.approvedOperationIds, []);
    assert.deepEqual(stored?.valueOverrides, {});
    assert.equal(stored?.approvalDigests, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
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

    const humanShow = run(["plans", "show", savedPlan.id]);
    assert.equal(humanShow.status, 0, humanShow.stderr);
    assert.match(humanShow.stdout, /Plan/);
    assert.match(humanShow.stdout, /Status\s+APPROVED/);
    assert.match(humanShow.stdout, /Selection\s+1 of \d+ operations? approved/);
    assert.match(humanShow.stdout, /✓ APPROVED/);
    assert.match(humanShow.stdout, /Effect\s+Apply will execute 1 selected operation/);
    assert.ok(
      savedPlan.findings.some((finding: { summary: string }) => humanShow.stdout.includes(finding.summary.slice(0, 48))),
      "operation cards should lead with a human-readable finding summary instead of only a record ID",
    );
    assert.match(humanShow.stdout, /Details: fullstackgtm plans show .* --verbose/);
    assert.doesNotMatch(humanShow.stdout, /## Evidence/, "default show hides the raw evidence wall");

    const verboseShow = run(["plans", "show", savedPlan.id, "--verbose"]);
    assert.equal(verboseShow.status, 0, verboseShow.stderr);
    assert.match(verboseShow.stdout, /Full plan document/);
    assert.match(verboseShow.stdout, /## Evidence/);

    // Approved apply now proceeds past the store gate and fails only on
    // missing provider credentials — proving the gate ordering.
    const apply = run(["apply", "--plan-id", savedPlan.id, "--provider", "hubspot"]);
    assert.equal(apply.status, 1);
    assert.match(apply.stderr, /No HubSpot credentials/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
