import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  auditSnapshot,
  defaultPolicy,
  diffFindings,
  diffSnapshots,
  diffToMarkdown,
  generateDemoSnapshot,
} from "../src/index.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const TODAY = "2026-06-09";

function evolvedSnapshot() {
  const before = generateDemoSnapshot();
  const after = structuredClone(before);
  // A deal closed and grew; one deal vanished; a new account appeared; one
  // ownerless deal got fixed (resolves a finding); one deal went ownerless
  // (a new finding).
  after.deals[1] = { ...after.deals[1], amount: 99_999, isClosed: true, isWon: true };
  after.deals.splice(5, 1);
  after.accounts.push({ id: "acct_new", name: "Brand New Co", domain: "brandnew.com" });
  const fixed = after.deals.find((deal) => deal.ownerId?.startsWith("user_departed"))!;
  fixed.ownerId = "user_03";
  const broken = after.deals.find((deal) => deal.ownerId === "user_04")!;
  broken.ownerId = undefined;
  return { before, after };
}

test("diffSnapshots reports added, removed, and field-level changes", () => {
  const { before, after } = evolvedSnapshot();
  const diff = diffSnapshots(before, after);

  assert.equal(diff.accounts.added.length, 1);
  assert.equal(diff.accounts.added[0].label, "Brand New Co");
  assert.equal(diff.deals.removed.length, 1);

  const grown = diff.deals.changed.find((change) => change.id === before.deals[1].id);
  assert.ok(grown);
  const fields = grown.changes.map((change) => change.field).sort();
  assert.deepEqual(fields, ["amount", "isClosed", "isWon"]);
});

test("diffSnapshots and diffToMarkdown cover the activities collection", () => {
  const before = generateDemoSnapshot();
  const after = structuredClone(before);

  // One activity added, one removed, one changed.
  const removedId = after.activities[0].id;
  const changedId = after.activities[1].id;
  after.activities.splice(0, 1);
  after.activities[0] = { ...after.activities[0], subject: "Rescheduled kickoff" };
  after.activities.push({
    id: "activity_new",
    type: "call",
    subject: "Discovery call",
    occurredAt: "2026-06-09T12:00:00.000Z",
  });

  const diff = diffSnapshots(before, after);

  assert.ok(diff.activities.added.some((record) => record.id === "activity_new"));
  assert.ok(diff.activities.removed.some((record) => record.id === removedId));
  const changed = diff.activities.changed.find((record) => record.id === changedId);
  assert.ok(changed, "the edited activity should be reported as changed");
  assert.ok(changed.changes.some((change) => change.field === "subject"));

  const markdown = diffToMarkdown(diff);
  assert.match(markdown, /\| activities \|/);
  assert.match(markdown, /## activities/);
  assert.match(markdown, /added .*\(activity_new\)/);
});

test("diffFindings reports hygiene drift via stable finding ids", () => {
  const { before, after } = evolvedSnapshot();
  const policy = defaultPolicy(TODAY);
  const drift = diffFindings(auditSnapshot(before, policy), auditSnapshot(after, policy));

  // The repaired departed-owner deal resolves its finding; the newly
  // ownerless deal creates one.
  assert.ok(
    drift.resolvedFindings.some((finding) => finding.ruleId === "missing-deal-owner"),
  );
  assert.ok(drift.newFindings.some((finding) => finding.ruleId === "missing-deal-owner"));
  assert.ok(drift.persistingCount > 0);
});

test("cli diff renders drift and gates on --fail-on-new-findings", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-diff-"));
  try {
    const { before, after } = evolvedSnapshot();
    const beforePath = join(dir, "before.json");
    const afterPath = join(dir, "after.json");
    writeFileSync(beforePath, JSON.stringify(before));
    writeFileSync(afterPath, JSON.stringify(after));

    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        ["--experimental-strip-types", "src/bin.ts", ...args],
        { cwd: repoRoot, encoding: "utf8" },
      );

    const json = run([
      "diff", "--before", beforePath, "--after", afterPath, "--today", TODAY, "--json",
    ]);
    assert.equal(json.status, 0, json.stderr);
    const { diff, drift } = JSON.parse(json.stdout);
    assert.equal(diff.accounts.added.length, 1);
    assert.ok(drift.newFindings.length > 0);

    const gated = run([
      "diff", "--before", beforePath, "--after", afterPath, "--today", TODAY,
      "--fail-on-new-findings",
    ]);
    assert.equal(gated.status, 2);
    assert.match(gated.stdout, /Hygiene drift/);

    // No drift against itself, and the gate stays quiet.
    const clean = run([
      "diff", "--before", beforePath, "--after", beforePath, "--today", TODAY,
      "--fail-on-new-findings",
    ]);
    assert.equal(clean.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli snapshot --archive writes timestamped provider files", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-archive-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types", "src/bin.ts",
        "snapshot", "--demo", "--archive", dir,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Archived snapshot to .*mock-2026-06-09T.*\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
