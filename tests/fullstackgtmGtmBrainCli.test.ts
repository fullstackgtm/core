import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { createFilePlanStore } from "../src/planStore.ts";
import { createFileSignalStore } from "../src/signals.ts";
import { createFileJudgeStore } from "../src/judge.ts";

// The GTM-brain nightly chain end-to-end through the CLI router, deterministic
// (no LLM key): signals fetch --save (staged ingest, no network) -> icp judge
// --save -> draft --save -> a needs_approval plan exists. Plus the governance
// invariant: `signals fetch` (no --save) emits NO plan, and `icp eval --golden
// default` exits 0.

// Force the deterministic paths — no LLM key resolves.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

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
  const home = mkdtempSync(join(tmpdir(), "fsgtm-brain-cli-"));
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

// Two fresh signals on one domain (a funding round AND a live req) — the
// rubric's compounding case that reaches the strong/send band deterministically.
function stagedSignalsFile(home: string): string {
  const path = join(home, "staged.json");
  const nowIso = new Date().toISOString();
  writeFileSync(
    path,
    JSON.stringify([
      {
        accountDomain: "apexnorth.agency",
        bucket: "funding",
        trigger: "raised Series B",
        quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week.",
        sourceUrl: "https://example.com/funding",
        firstSeen: nowIso,
      },
      {
        accountDomain: "apexnorth.agency",
        bucket: "job",
        trigger: "hiring: Head of Growth",
        quote: "Head of Growth - own demand gen and marketing ops for the next stage of growth.",
        sourceUrl: "https://example.com/job",
        firstSeen: nowIso,
      },
    ]),
  );
  return path;
}

test("nightly chain: signals fetch --save -> icp judge --save -> draft --save stages a needs_approval plan", async () => {
  await withHome(async (home) => {
    const staged = stagedSignalsFile(home);

    // 1) signals fetch --save (staged ingest only; --bucket keeps it off the
    //    network — empty watchlist means no ATS calls).
    const fetchRun = await cli([
      "signals",
      "fetch",
      "--bucket",
      "funding,job",
      "--from",
      staged,
      "--label",
      "run1",
      "--save",
    ]);
    assert.equal(fetchRun.exitCode, 0, fetchRun.stderr);
    const fetched = JSON.parse(fetchRun.stdout);
    assert.equal(fetched.length, 2, "two fresh signals staged");

    // The signal run persisted to the signal store (not a plan store).
    const signalStore = createFileSignalStore();
    const run = await signalStore.getRun("run1");
    assert.ok(run, "signal run persisted");
    assert.equal(run.signals.length, 2);

    // 2) icp judge --save (deterministic — no LLM key).
    const judgeRun = await cli([
      "icp",
      "judge",
      "--signals-from",
      "run1",
      "--label",
      "judge1",
      "--save",
    ]);
    assert.equal(judgeRun.exitCode, 0, judgeRun.stderr);
    const decisions = JSON.parse(judgeRun.stdout);
    const hot = decisions.find((d: { accountDomain: string }) => d.accountDomain === "apexnorth.agency");
    assert.ok(hot, "judged the clustered account");
    assert.equal(hot.decision, "send", `expected send, got ${hot.decision} @ ${hot.score}`);
    assert.ok(hot.score >= 80, `expected strong band, got ${hot.score}`);
    assert.equal(hot.producedBy, "deterministic");

    // The judge run persisted and the consumed signals were stamped judgedBy.
    const judgeStore = createFileJudgeStore();
    const stored = await judgeStore.getRun("judge1");
    assert.ok(stored, "judge run persisted");
    assert.equal(stored.signalRunLabel, "run1");
    const restamped = await signalStore.getRun("run1");
    assert.ok(restamped!.signals.every((s) => s.judgedBy === "judge1"), "signals stamped judgedBy");

    // 3) draft --save -> a governed create_task plan.
    const draftRun = await cli(["draft", "--from-judge", "judge1", "--save"]);
    assert.equal(draftRun.exitCode, 0, draftRun.stderr);
    const { drafts } = JSON.parse(draftRun.stdout);
    assert.equal(drafts.length, 1, "one opener for the one hot account");
    assert.equal(drafts[0].accountDomain, "apexnorth.agency");

    // 4) A needs_approval plan exists in the plan store, dry-run, create_task.
    const planStore = createFilePlanStore();
    const plans = await planStore.list();
    assert.equal(plans.length, 1, "exactly one plan staged by draft");
    const plan = plans[0].plan;
    assert.equal(plan.status, "needs_approval");
    assert.equal(plan.dryRun, true);
    assert.equal(plan.operations.length, 1);
    assert.equal(plan.operations[0].operation, "create_task");
    assert.equal(plan.operations[0].approvalRequired, true);
    // Evidence is carried verbatim and linked to the op.
    assert.ok((plan.evidence ?? []).length >= 1, "plan carries evidence");
    assert.ok((plan.operations[0].evidenceIds ?? []).length >= 1, "op links evidence");
  });
});

test("`signals fetch` WITHOUT --save produces NO plan (read-only re: CRM)", async () => {
  await withHome(async (home) => {
    const staged = stagedSignalsFile(home);
    const res = await cli(["signals", "fetch", "--bucket", "funding,job", "--from", staged]);
    assert.equal(res.exitCode, 0, res.stderr);
    assert.match(res.stderr, /NO plan emitted/);
    // No plan, and no signal run either (no --save).
    assert.equal((await createFilePlanStore().list()).length, 0, "signals fetch never writes a plan");
    assert.equal((await createFileSignalStore().listRuns()).length, 0, "no run persisted without --save");
  });
});

test("`icp eval --golden default` passes and exits 0", async () => {
  await withHome(async () => {
    const res = await cli(["icp", "eval", "--golden", "default"]);
    assert.equal(res.exitCode, 0, `expected exit 0, stderr: ${res.stderr}`);
    assert.match(res.stdout, /accuracy:/);
  });
});

test("`signals fetch --help` is help-before-network (prints usage, no run, exit 0)", async () => {
  await withHome(async () => {
    const res = await cli(["signals", "fetch", "--help"]);
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /signals fetch/);
    assert.equal((await createFileSignalStore().listRuns()).length, 0);
  });
});

test("`draft --help` is help-before-network (prints usage, no plan, exit 0)", async () => {
  await withHome(async () => {
    const res = await cli(["draft", "--help"]);
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /draft \[--from-judge/);
    assert.equal((await createFilePlanStore().list()).length, 0);
  });
});
