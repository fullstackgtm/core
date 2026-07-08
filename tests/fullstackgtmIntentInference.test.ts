import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import { detectFlagTypo, documentedFlags, suggestCommand } from "../src/cli/suggest.ts";

// Intent-inference regression tests (agent-ergonomics pass 1).
//
// R-001: near-miss unknown flags stop with the exact corrected command
// instead of being silently dropped by the per-verb parsers. Before this
// change `audit --demo --jsn` exited 0 and printed markdown where the agent
// asked for JSON — the worst failure class (silent intent-miss).

/** Run the CLI capturing stdout/stderr + exit code (same harness as fullstackgtmFlagAliases.test.ts). */
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

test("R-001: audit --demo --jsn errors with the exact corrected command instead of silently printing markdown", async () => {
  const result = await cli(["audit", "--demo", "--jsn"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown flag: --jsn/);
  assert.match(result.stderr, /Did you mean: --json/);
  assert.match(result.stderr, /Try: fullstackgtm audit --demo --json/);
  assert.equal(result.stdout, "");
});

test("R-001: underscore spelling --dry_run is corrected to --dry-run", async () => {
  const result = await cli(["audit", "--demo", "--dry_run"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Did you mean: --dry-run/);
  assert.match(result.stderr, /Try: fullstackgtm audit --demo --dry-run/);
});

test("R-001: typo on a write-shaped verb is suggest-only — nothing is staged or saved", async () => {
  const result = await cli(["reassign", "--from", "u1", "--to", "u2", "--demo", "--sav"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown flag: --sav/);
  assert.match(result.stderr, /Did you mean: --save/);
  // The plan pipeline never ran: no plan/summary output at all.
  assert.equal(result.stdout, "");
});

test("R-001: --json mode returns a structured UNKNOWN_FLAG envelope on stdout", async () => {
  const result = await cli(["audit", "--demo", "--json", "--provder", "hubspot"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "UNKNOWN_FLAG");
  assert.match(payload.error.hints.join("\n"), /--provider/);
  assert.match(payload.error.hints.join("\n"), /Try: fullstackgtm audit --demo --json --provider hubspot/);
});

test("R-001: unknown flags with no documented near-miss fail closed", async () => {
  const result = await cli(["doctor", "--verbose"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown flag for doctor: --verbose/);
  assert.equal(result.stdout, "");
});

test("R-001: documented flags never trigger the typo handler (registry is derived from help.ts)", () => {
  const known = documentedFlags();
  for (const flag of ["--json", "--dry-run", "--save", "--provider", "--fail-on-new-findings", "--assign-unowned"]) {
    assert.ok(known.has(flag), `${flag} missing from the derived registry`);
  }
  assert.equal(detectFlagTypo(["--demo", "--json", "--save"]), null);
  // Real-but-undocumented flags (e.g. market init --auto) must not be flagged.
  assert.equal(detectFlagTypo(["--auto", "--capture-run", "--task-deal"]), null);
});

test("R-002: unknown command (text path) gets a did-you-mean instead of the usage wall", async () => {
  const result = await cli(["plan"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown command: plan/);
  assert.match(result.stderr, /Did you mean: fullstackgtm plans/);
  assert.match(result.stderr, /fullstackgtm --help/);
  // The error is a hint, not the ~200-line usage() dump.
  assert.ok(result.stderr.split("\n").length < 8, `still a wall: ${result.stderr.split("\n").length} lines`);
  assert.equal(result.stdout, "");
});

test("R-002: unrecognizable command still points at --help and capabilities --json", async () => {
  const result = await cli(["zzzzzzzzzz"]);
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.stderr, /Did you mean/);
  assert.match(result.stderr, /capabilities --json/);
});

test("R-003: apply <planId> positional names the exact corrected command", async () => {
  await assert.rejects(
    () => runCli(["apply", "patch_plan_abc123"]),
    /Try: fullstackgtm apply --plan-id patch_plan_abc123 --provider <hubspot\|salesforce\|stripe>/,
  );
});

test("R-003: suggest <planId> positional names the exact corrected command", async () => {
  await assert.rejects(
    () => runCli(["suggest", "patch_plan_abc123"]),
    /Try: fullstackgtm suggest --plan-id patch_plan_abc123/,
  );
});

test("R-003: apply with flags only keeps the original diagnostics", async () => {
  await assert.rejects(
    () => runCli(["apply"]),
    /apply requires --provider <name> \(CRM\) or --channel <id>/,
  );
});

test("R-004: unknown provider gets a nearest-match suggestion", async () => {
  await assert.rejects(
    () => runCli(["audit", "--provider", "hubpsot"]),
    /Unknown provider: hubpsot\. Did you mean hubspot\? Supported providers: hubspot, salesforce, stripe/,
  );
});

test("R-004: a far-off provider keeps the plain supported list", async () => {
  await assert.rejects(
    () => runCli(["audit", "--provider", "gmail"]),
    (error: Error) => {
      assert.match(error.message, /Unknown provider: gmail\./);
      assert.doesNotMatch(error.message, /Did you mean/);
      assert.match(error.message, /Supported providers: hubspot, salesforce, stripe/);
      return true;
    },
  );
});

test("R-009: GNU-style --flag=value gets the space-separated correction", async () => {
  const result = await cli(["audit", "--demo", "--rules=missing-deal-owner"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown flag: --rules=missing-deal-owner/);
  assert.match(result.stderr, /Did you mean: --rules missing-deal-owner/);
  assert.match(result.stderr, /Try: fullstackgtm audit --demo --rules missing-deal-owner/);
});

test("R-009: --flag=value with a typo'd base is corrected too", async () => {
  const result = await cli(["audit", "--demo", "--jsn="]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Did you mean: --json/);
});

test("R-009: an =value whose base is not valid for the command fails closed", async () => {
  const result = await cli(["doctor", "--verbosity=high"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown flag for doctor: --verbosity/);
  assert.equal(result.stdout, "");
});

test("R-010: a flag-shaped first token is diagnosed as flag-before-command, with the flag resolved", async () => {
  const result = await cli(["--jsn"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--jsn is a flag — a command must come first/);
  assert.match(result.stderr, /Did you mean: --json \(after a command\)/);
  assert.match(result.stderr, /fullstackgtm --help/);
});

test("R-010: a valid flag in command position still explains ordering", async () => {
  const result = await cli(["--source"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--source is a flag — a command must come first/);
  assert.doesNotMatch(result.stderr, /Unknown command:/);
});

test("R-011: bespoke subverb typos get a nearest-match did-you-mean", async () => {
  await assert.rejects(
    () => runCli(["enrich", "apend"]),
    /Unknown enrich subcommand: apend\. Did you mean: fullstackgtm enrich append\? Subcommands: append, refresh, ingest, status, acquire\./,
  );
  await assert.rejects(
    () => runCli(["icp", "judg"]),
    /Did you mean: fullstackgtm icp judge\?/,
  );
  await assert.rejects(
    () => runCli(["plans", "aprove", "x"]),
    /Did you mean: fullstackgtm plans approve\?/,
  );
  await assert.rejects(
    () => runCli(["market", "captur"]),
    /Did you mean: fullstackgtm market capture\?/,
  );
});

test("R-011: a far-off subverb keeps the plain list", async () => {
  await assert.rejects(
    () => runCli(["signals", "zzzz"]),
    (error: Error) => {
      assert.doesNotMatch(error.message, /Did you mean/);
      assert.match(error.message, /Subcommands: fetch, list, outcome, weights\./);
      return true;
    },
  );
});

test("R-006: audit --demo --json is byte-deterministic under SOURCE_DATE_EPOCH", async () => {
  const prev = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = "1234567890";
  try {
    const first = await cli(["audit", "--demo", "--json"]);
    const second = await cli(["audit", "--demo", "--json"]);
    assert.equal(first.exitCode, 0);
    assert.equal(first.stdout, second.stdout);
    const plan = JSON.parse(first.stdout);
    assert.equal(plan.createdAt, "2009-02-13T23:31:30.000Z");
  } finally {
    if (prev === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = prev;
  }
});

test("R-006: without SOURCE_DATE_EPOCH, createdAt is the real clock", async () => {
  delete process.env.SOURCE_DATE_EPOCH;
  const result = await cli(["audit", "--demo", "--json"]);
  const plan = JSON.parse(result.stdout);
  const age = Date.now() - new Date(plan.createdAt).getTime();
  assert.ok(age >= 0 && age < 60_000, `createdAt should be now-ish, was ${plan.createdAt}`);
});

test("R-001: suggestCommand still resolves near-miss commands from the HELP table", () => {
  assert.equal(suggestCommand("plan"), "plans");
  assert.equal(suggestCommand("dedup"), "dedupe");
  assert.equal(suggestCommand("zzzzzzzzzz"), null);
});
