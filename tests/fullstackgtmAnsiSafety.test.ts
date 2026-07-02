import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The TUI layer's safety contract: ANSI styling and animation exist ONLY on
// interactive TTYs. Every spawn here runs with piped stdio (no TTY), so any
// escape byte on stdout is a contract violation — an agent transcript, a
// shell pipe, or a CI log would see it.

const ESC = "\u001b";
const CLI = "src/bin.ts";

// Hermetic home: no host credentials/plans/health leak into assertions.
const home = mkdtempSync(join(tmpdir(), "fsgtm-ansi-"));

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", CLI, ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, FSGTM_HOME: home, NO_COLOR: undefined, FORCE_COLOR: undefined, CI: undefined },
    },
  );
}

const PLAIN_INVOCATIONS: string[][] = [
  ["--help"],
  ["help", "audit"],
  ["doctor"],
  ["health"],
  ["rules"],
  ["plans", "list"],
  ["audit", "--demo"],
  ["audit", "--demo", "--full"],
  ["--version"],
];

for (const args of PLAIN_INVOCATIONS) {
  test(`piped \`${args.join(" ")}\` emits zero ANSI bytes on stdout or stderr`, () => {
    const result = runCli(args);
    assert.ok(!result.stdout.includes(ESC), `stdout carries ANSI: ${JSON.stringify(result.stdout.slice(0, 200))}`);
    assert.ok(!result.stderr.includes(ESC), `stderr carries ANSI: ${JSON.stringify(result.stderr.slice(0, 200))}`);
  });
}

const JSON_INVOCATIONS: string[][] = [
  ["doctor", "--json"],
  ["health", "--json"],
  ["capabilities", "--json"],
  ["audit", "--demo", "--json"],
  ["rules", "--json"],
];

for (const args of JSON_INVOCATIONS) {
  test(`piped \`${args.join(" ")}\` is parseable JSON with zero ANSI bytes`, () => {
    const result = runCli(args);
    assert.ok(!result.stdout.includes(ESC), "stdout carries ANSI");
    assert.ok(!result.stderr.includes(ESC), "stderr carries ANSI");
    assert.doesNotThrow(() => JSON.parse(result.stdout), `not JSON: ${result.stdout.slice(0, 200)}`);
  });
}

test("NO_COLOR suppresses styling even when FORCE_COLOR is unset", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", CLI, "--help"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, FSGTM_HOME: home, NO_COLOR: "1" },
    },
  );
  assert.ok(!result.stdout.includes(ESC));
});

test("FORCE_COLOR=1 opts piped stdout into color (spec-compliant escape hatch)", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", CLI, "--help"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, FSGTM_HOME: home, NO_COLOR: undefined, CI: undefined, FORCE_COLOR: "1" },
    },
  );
  assert.ok(result.stdout.includes(ESC), "FORCE_COLOR=1 should enable styling");
});
