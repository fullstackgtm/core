import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const runCliProcess = (args: string[]) =>
  spawnSync(
    process.execPath,
    ["--experimental-strip-types", "src/bin.ts", ...args],
    { cwd: repoRoot, encoding: "utf8" },
  );

// Capture everything runCli writes to stdout for a given argv.
async function capture(argv: string[]): Promise<string> {
  return (await captureBoth(argv)).out;
}

// Capture stdout and stderr separately (the next-step guidance goes to stderr
// so it can't pollute piped/--out plan output).
async function captureBoth(argv: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (msg: unknown) => out.push(String(msg));
  console.error = (msg: unknown) => err.push(String(msg));
  try {
    await runCli(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

test("bare invoke shows the short lifecycle-grouped map, not the full wall", async () => {
  const out = await capture([]);
  // Grouped front door, well under the old 194-line wall.
  assert.ok(out.split("\n").length < 80, "front door should be compact");
  assert.match(out, /Detect — read-only/);
  assert.match(out, /Remediate — governed writes/);
  assert.match(out, /Govern — the plan\/apply spine/);
  // Points the user deeper instead of dumping every flag.
  assert.match(out, /fullstackgtm <command> --help/);
  assert.match(out, /fullstackgtm help --full/);
  // The full reference markers are NOT present in the short view.
  assert.doesNotMatch(out, /Authentication \(checked in order\)/);
});

test("--help and help match the short front door; --full escapes to the reference", async () => {
  const bare = await capture([]);
  assert.equal(await capture(["--help"]), bare);
  assert.equal(await capture(["help"]), bare);

  const full = await capture(["help", "--full"]);
  assert.match(full, /Authentication \(checked in order\)/);
  assert.equal(await capture(["--help", "--full"]), full);
});

test("<verb> --help gives focused per-command help, not the global wall", async () => {
  const out = await capture(["audit", "--help"]);
  assert.match(out, /^fullstackgtm audit —/);
  assert.match(out, /Lifecycle phase: Detect/);
  assert.match(out, /See also: report, suggest, plans, apply, diff/);
  // Focused, not the whole surface.
  assert.doesNotMatch(out, /Authentication \(checked in order\)/);
  // Escape hatch to the full reference still works.
  assert.match(await capture(["audit", "--help", "--full"]), /Authentication \(checked in order\)/);
});

test("bulk-update help is intercepted before object parsing or data-source access", async () => {
  for (const args of [["bulk-update", "--help"], ["bulk-update", "-h"]]) {
    const result = await captureBoth(args);
    assert.match(result.out, /bulk-update/);
    assert.match(result.out, /--where/);
    assert.equal(result.err, "");
  }
});

test("help <verb> renders the same focused entry, with --full as a global escape hatch", async () => {
  const out = await capture(["help", "resolve"]);
  assert.match(out, /^fullstackgtm resolve —/);
  assert.match(out, /Lifecycle phase: Prevent/);

  const full = await capture(["help", "resolve", "--full"]);
  assert.match(full, /Authentication \(checked in order\)/);
  assert.doesNotMatch(full, /^fullstackgtm resolve —/);
});

test("unknown verb --help falls back to the short map instead of dead-ending", async () => {
  const out = await capture(["definitely-not-a-command", "--help"]);
  assert.match(out, /Setup & health:/);
});

test("unknown command flags fail closed with a did-you-mean hint", () => {
  const result = runCliProcess(["audit", "--demo", "--fail-on-critical"]);
  assert.notEqual(result.status, 0, "misspelled CI gate flag must not silently pass");
  assert.match(`${result.stderr}${result.stdout}`, /Unknown flag for audit: --fail-on-critical/);
  assert.match(`${result.stderr}${result.stdout}`, /Did you mean --fail-on\?/);
});

test("unknown command flags after a missing value-taking option still fail closed", () => {
  const result = runCliProcess(["audit", "--out", "--fail-on-critical", "--demo"]);
  assert.notEqual(result.status, 0, "unknown flag must not be hidden by a prior missing --out value");
  assert.match(`${result.stderr}${result.stdout}`, /Unknown flag for audit: --fail-on-critical/);
});

test("unknown single-dash command flags fail closed", () => {
  const result = runCliProcess(["audit", "--demo", "-x"]);
  assert.notEqual(result.status, 0, "unknown short flag must not be silently ignored");
  assert.match(`${result.stderr}${result.stdout}`, /Unknown flag for audit: -x/);
});

// #2 — every read verb points forward. `audit --demo` used to end on a blank
// line; now it hands the user the next step (on stderr, so stdout stays clean).
test("audit --demo no longer dead-ends: stderr carries a next step, stdout stays clean", async () => {
  const { out, err } = await captureBoth(["audit", "--demo", "--today", "2026-05-03"]);
  // Forward pointer on stderr, demo-flavored.
  assert.match(err, /Next:/);
  assert.match(err, /report --demo/);
  assert.match(err, /login hubspot/);
  // The plan markdown on stdout is unpolluted by guidance.
  assert.match(out, /GTM hygiene audit patch plan/);
  assert.doesNotMatch(out, /Next:/);
});

test("audit --json suppresses the next-step footer (machine/agent context)", async () => {
  const { err } = await captureBoth(["audit", "--demo", "--today", "2026-05-03", "--json"]);
  assert.doesNotMatch(err, /Next:/);
});

// #3 — altitude control. The default human view is a decision card, not the
// 1,400+-line per-operation dump; --full/--verbose opts back in.
test("audit defaults to a compact summary; --full restores the per-operation dump", async () => {
  const summary = await capture(["audit", "--demo", "--today", "2026-05-03"]);
  assert.ok(summary.split("\n").length < 40, "summary should be compact");
  assert.match(summary, /Plan preview/);
  assert.match(summary, /DRY RUN · NOTHING WRITTEN/);
  assert.match(summary, /Details: re-run with --verbose/);
  // The summary omits the per-operation detail block.
  assert.doesNotMatch(summary, /## Proposed Patch Operations/);

  const full = await capture(["audit", "--demo", "--today", "2026-05-03", "--full"]);
  assert.ok(full.split("\n").length > summary.split("\n").length * 10, "full should be far longer");
  assert.match(full, /## Proposed Patch Operations/);
  assert.match(full, /- ID: op_/);
});
