import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.ts";

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
  const origExitCode = process.exitCode;
  console.log = (msg: unknown) => out.push(String(msg));
  console.error = (msg: unknown) => err.push(String(msg));
  try {
    await runCli(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExitCode;
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

test("help <verb> renders the same focused entry", async () => {
  const out = await capture(["help", "resolve"]);
  assert.match(out, /^fullstackgtm resolve —/);
  assert.match(out, /Lifecycle phase: Prevent/);
});

test("unknown verb --help falls back to the short map instead of dead-ending", async () => {
  const out = await capture(["definitely-not-a-command", "--help"]);
  assert.match(out, /Setup & health:/);
});

test("commands --json exposes an agent-readable command catalog", async () => {
  const out = await capture(["commands", "--json"]);
  const catalog = JSON.parse(out);
  assert.equal(catalog.name, "fullstackgtm");
  assert.ok(Array.isArray(catalog.commands));
  const audit = catalog.commands.find((entry: any) => entry.command === "audit");
  assert.equal(audit.phase, "Detect");
  assert.match(audit.synopsis.join("\n"), /fullstackgtm audit/);
  assert.equal(audit.jsonCapable, true);
  assert.match(catalog.agentHints.join("\n"), /Prefer --json/);
});

test("help <verb> --json returns a single catalog entry", async () => {
  const out = await capture(["help", "resolve", "--json"]);
  const entry = JSON.parse(out);
  assert.equal(entry.command, "resolve");
  assert.equal(entry.phase, "Prevent");
  assert.match(entry.summary, /create gate/);
});

test("unknown command is concise, suggests typos, and has JSON error mode", async () => {
  const human = await captureBoth(["auidt"]);
  assert.equal(human.out, "");
  assert.match(human.err, /Unknown command: auidt/);
  assert.match(human.err, /Did you mean: fullstackgtm audit/);
  assert.match(human.err, /commands --json/);
  assert.doesNotMatch(human.err, /Authentication \(checked in order\)/);

  const machine = await captureBoth(["auidt", "--json"]);
  assert.equal(machine.out, "");
  const payload = JSON.parse(machine.err);
  assert.equal(payload.error.code, "unknown_command");
  assert.equal(payload.error.suggestion, "audit");
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

// #3 — altitude control. The default human view is a summary (rule table +
// counts), not the 1,400+-line per-operation dump; --full opts back in.
test("audit defaults to a compact summary; --full restores the per-operation dump", async () => {
  const summary = await capture(["audit", "--demo", "--today", "2026-05-03"]);
  assert.ok(summary.split("\n").length < 40, "summary should be compact");
  assert.match(summary, /## Findings by Rule/);
  assert.match(summary, /Full plan detail: re-run with `--full`/);
  assert.match(summary, /fullstackgtm report/);
  // The summary omits the per-operation detail block.
  assert.doesNotMatch(summary, /## Proposed Patch Operations/);

  const full = await capture(["audit", "--demo", "--today", "2026-05-03", "--full"]);
  assert.ok(full.split("\n").length > summary.split("\n").length * 10, "full should be far longer");
  assert.match(full, /## Proposed Patch Operations/);
  assert.match(full, /- ID: op_/);
});
