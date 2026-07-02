import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";

// R-005 (agent-ergonomics pass 1): doctor is the one-call triage surface.
// `doctor --json` returns env + workspace health + plans awaiting approval +
// state-aware copy-pasteable next commands — previously an agent needed three
// round-trips (doctor, health, plans list) to orient itself.

async function cli(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  process.exitCode = 0;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  try {
    await runCli(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = origExit;
  return { stdout: out.join("\n"), stderr: err.join("\n"), exitCode };
}

function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-doctor-triage-"));
  const prevHome = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  return (async () => {
    try {
      return await fn(home);
    } finally {
      if (prevHome === undefined) delete process.env.FSGTM_HOME;
      else process.env.FSGTM_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  })();
}

test("R-005: doctor --json on a fresh workspace has an empty workspace slice and keeps generic next steps", () =>
  withHome(async () => {
    const result = await cli(["doctor", "--json"]);
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.workspace.auditCount, 0);
    assert.equal(payload.workspace.healthScore, null);
    assert.deepEqual(payload.workspace.pendingPlans, []);
    assert.match(payload.nextSteps[0], /audit --demo/);
  }));

test("R-005: after audit --save, doctor --json carries health + the pending plan + the exact approve chain", () =>
  withHome(async () => {
    const saved = await cli(["audit", "--demo", "--save"]);
    assert.equal(saved.exitCode, 0, saved.stderr);
    const result = await cli(["doctor", "--json"]);
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(typeof payload.workspace.healthScore, "number");
    assert.equal(payload.workspace.auditCount, 1);
    assert.ok(payload.workspace.lastAuditAt);
    assert.equal(payload.workspace.pendingPlans.length, 1);
    const plan = payload.workspace.pendingPlans[0];
    assert.match(plan.id, /^patch_plan_/);
    assert.ok(plan.operations > 0);
    assert.equal(plan.approved, 0);
    // Next steps are the copy-pasteable show → approve → apply chain.
    assert.equal(payload.nextSteps[0], `fullstackgtm plans show ${plan.id}`);
    assert.match(payload.nextSteps[1], new RegExp(`plans approve ${plan.id} --operations`));
    assert.match(payload.nextSteps[2], new RegExp(`apply --plan-id ${plan.id} --provider`));
  }));

test("R-005: text doctor gains a Workspace section without losing the env report", () =>
  withHome(async () => {
    await cli(["audit", "--demo", "--save"]);
    const result = await cli(["doctor"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Package: {4}fullstackgtm/);
    assert.match(result.stdout, /Workspace:/);
    assert.match(result.stdout, /\/100.*1 audit\(s\) saved/);
    assert.match(result.stdout, /1 awaiting approval: patch_plan_/);
    assert.match(result.stdout, /plans show patch_plan_/);
  }));
