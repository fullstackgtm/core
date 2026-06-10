import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { platform } from "node:process";
import test from "node:test";
import {
  createFilePlanStore,
  mergeSnapshots,
  storeCredential,
  credentialsPath,
  type CanonicalGtmSnapshot,
} from "../src/index.ts";

const repoRoot = resolve(import.meta.dirname, "..");

function withTempHome<T>(run: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-sec-"));
  const previous = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = dir;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

// chmod is a no-op on Windows; these assertions are POSIX-only.
const posix = platform !== "win32";

test("credential file and home directory are owner-only even after a prior plans write", () =>
  withTempHome(() => {
    // Reproduce the gap: a plan write created the home dir BEFORE any login.
    const plan = {
      id: "patch_plan_sec",
      title: "t",
      createdAt: new Date().toISOString(),
      status: "needs_approval" as const,
      dryRun: true as const,
      summary: "s",
      findings: [],
      operations: [],
    };
    void createFilePlanStore().save(plan);

    storeCredential("hubspot", {
      kind: "private_app",
      accessToken: "pat-secret",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (posix) {
      const home = process.env.FSGTM_HOME!;
      assert.equal(statSync(home).mode & 0o777, 0o700, "home dir must be 0700");
      assert.equal(statSync(credentialsPath()).mode & 0o777, 0o600, "cred file must be 0600");
      assert.equal(statSync(join(home, "plans")).mode & 0o777, 0o700, "plans dir must be 0700");
    }
  }));

test("login rejects secrets passed as argv flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-sec-cli-"));
  try {
    const env = { ...process.env, FSGTM_HOME: dir } as NodeJS.ProcessEnv;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types", "src/bin.ts",
        "login", "stripe", "--token", "sk_live_leak", "--no-validate",
      ],
      { cwd: repoRoot, encoding: "utf8", env, input: "" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no longer accepts a value on the command line/);
    // The secret must not be echoed back in any output.
    assert.doesNotMatch(result.stdout + result.stderr, /sk_live_leak/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("login reads the secret from stdin without exposing it on argv", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-sec-stdin-"));
  try {
    const env = { ...process.env, FSGTM_HOME: dir } as NodeJS.ProcessEnv;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types", "src/bin.ts",
        "login", "stripe", "--no-validate",
      ],
      { cwd: repoRoot, encoding: "utf8", env, input: "sk_piped_secret\n" },
    );
    assert.equal(result.status, 0, result.stderr);
    const stored = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
    assert.equal(stored.providers.stripe.accessToken, "sk_piped_secret");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge no longer auto-merges same-name accounts with different domains", () => {
  const a: CanonicalGtmSnapshot = {
    generatedAt: "2026-06-01T00:00:00.000Z",
    provider: "hubspot",
    users: [],
    accounts: [{ id: "h1", crmId: "h1", name: "Acme Inc", domain: "acme-east.com" }],
    contacts: [],
    deals: [{ id: "hd", crmId: "hd", accountId: "h1", name: "East deal", amount: 10, isClosed: false }],
    activities: [],
  };
  const b: CanonicalGtmSnapshot = {
    generatedAt: "2026-06-01T00:00:00.000Z",
    provider: "salesforce",
    users: [],
    // Same display name, genuinely different company (different domain).
    accounts: [{ id: "s1", crmId: "s1", name: "Acme Inc", domain: "acme-west.com" }],
    contacts: [],
    deals: [{ id: "sd", crmId: "sd", accountId: "s1", name: "West deal", amount: 20, isClosed: false }],
    activities: [],
  };

  const { snapshot, report } = mergeSnapshots([a, b]);

  // The two "Acme Inc" remain separate accounts...
  assert.equal(snapshot.accounts.length, 2);
  assert.ok(snapshot.accounts.every((account) => account.identities?.length === 1));
  // ...their deals are NOT cross-linked...
  const eastDeal = snapshot.deals.find((deal) => deal.name === "East deal")!;
  const westDeal = snapshot.deals.find((deal) => deal.name === "West deal")!;
  assert.notEqual(eastDeal.accountId, westDeal.accountId);
  // ...but the collision is surfaced for human review.
  assert.equal(report.suggestions.length, 1);
  assert.equal(report.suggestions[0].name, "Acme Inc");
  assert.equal(report.suggestions[0].recordIds.length, 2);
});
