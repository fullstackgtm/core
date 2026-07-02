import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { createFilePlanStore } from "../src/planStore.ts";

// Standardized flag aliases (additive, pre-1.0 CLI hygiene):
//  - `--dry-run` asserts the preview default on plan-spine verbs — it
//    suppresses `--save` (and `fix --yes`) so the invocation can never
//    persist a record or reach a write. Omitting it changes nothing.
//  - `--confirm` is accepted wherever an ad-hoc confirmation flag already
//    gates a write stage (`fix --yes`); the legacy flag keeps working.

/** Run the CLI with FSGTM_HOME isolation, capturing stdout/stderr + exitCode. */
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
  const home = mkdtempSync(join(tmpdir(), "fsgtm-flag-alias-"));
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

test("audit --save persists a plan; adding --dry-run suppresses the save", async () => {
  await withHome(async () => {
    const store = createFilePlanStore();

    const dry = await cli(["audit", "--demo", "--save", "--dry-run"]);
    assert.match(dry.stderr, /--dry-run overrides --save/);
    assert.equal((await store.list()).length, 0, "--dry-run must win over --save");

    const saved = await cli(["audit", "--demo", "--save"]);
    assert.match(saved.stderr, /Saved plan/);
    assert.equal((await store.list()).length, 1, "--save without --dry-run is unchanged");
  });
});

test("audit --dry-run without --save is a no-op alias (preview was already the default)", async () => {
  await withHome(async () => {
    const dry = await cli(["audit", "--demo", "--dry-run", "--seed", "7"]);
    const plain = await cli(["audit", "--demo", "--seed", "7"]);
    assert.equal(dry.stdout, plain.stdout, "--dry-run must not change the preview default");
    assert.equal(dry.exitCode, plain.exitCode);
    assert.equal((await createFilePlanStore().list()).length, 0);
  });
});

test("dedupe --save --dry-run emits the plan but persists nothing", async () => {
  await withHome(async () => {
    const res = await cli(["dedupe", "account", "--key", "domain", "--sample", "--save", "--dry-run", "--json"]);
    assert.equal(res.exitCode, 0, res.stderr);
    const plan = JSON.parse(res.stdout) as { id: string };
    assert.ok(plan.id, "still prints the structured plan");
    assert.equal((await createFilePlanStore().list()).length, 0, "--dry-run must win over --save");
  });
});

// fix's write gate (`--yes`, now also `--confirm`) needs live provider
// credentials to reach end-to-end, so the alias semantics are pinned at the
// shared-helper level — fix routes its gate through confirmRequested(args, "--yes").
test("confirmRequested: --confirm aliases the legacy flag; --dry-run beats both", async () => {
  const { confirmRequested, dryRunRequested, saveRequested } = await import(
    "../src/cli/shared.ts"
  );
  // Legacy flag keeps working; the standardized alias joins it.
  assert.equal(confirmRequested(["--yes"], "--yes"), true);
  assert.equal(confirmRequested(["--confirm"], "--yes"), true);
  assert.equal(confirmRequested([], "--yes"), false);
  // --dry-run locks the preview path even when a confirm flag is present.
  assert.equal(confirmRequested(["--yes", "--dry-run"], "--yes"), false);
  assert.equal(confirmRequested(["--confirm", "--dry-run"], "--yes"), false);
  assert.equal(dryRunRequested(["--dry-run"]), true);
  assert.equal(dryRunRequested([]), false);
  // --save is honored exactly as before unless --dry-run suppresses it.
  assert.equal(saveRequested(["--save"]), true);
  assert.equal(saveRequested(["--save", "--dry-run"]), false);
  assert.equal(saveRequested(["--dry-run"]), false);
  assert.equal(saveRequested([]), false);
});
