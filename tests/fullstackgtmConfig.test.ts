import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  auditSnapshot,
  defaultPolicy,
  type CanonicalGtmSnapshot,
} from "../src/index.ts";

const repoRoot = resolve(import.meta.dirname, "..");

// A snapshot crafted to trip each of the 0.4.0 rules exactly once.
const messySnapshot: CanonicalGtmSnapshot = {
  generatedAt: "2026-06-01T00:00:00.000Z",
  provider: "mock",
  users: [{ id: "u1", name: "Rep One", email: "rep@example.com" }],
  accounts: [
    { id: "a1", name: "Acme", domain: "acme.com", ownerId: "u1" },
    { id: "a2", name: "Acme Inc", domain: "ACME.com", ownerId: "u1" },
    { id: "a3", name: "NoContacts Corp", domain: "nocontacts.com", ownerId: "u1" },
  ],
  contacts: [
    { id: "c1", accountId: "a1", email: "jo@acme.com", ownerId: "u1" },
    { id: "c2", accountId: "a2", email: "JO@acme.com", ownerId: "u1" },
  ],
  deals: [
    {
      id: "d1",
      accountId: "a3",
      ownerId: "u1",
      name: "Amountless",
      closeDate: "2026-09-01",
      lastActivityAt: "2026-05-30",
      isClosed: false,
    },
    {
      id: "d2",
      accountId: "a1",
      ownerId: "u1",
      name: "Closing soon, quiet",
      amount: 50_000,
      closeDate: "2026-06-08",
      lastActivityAt: "2026-05-10",
      isClosed: false,
    },
  ],
  activities: [],
};

test("0.4.0 rules flag duplicates, coverage gaps, amounts, and slipping deals", () => {
  const plan = auditSnapshot(messySnapshot, defaultPolicy("2026-06-01"));
  const ruleIds = new Set(plan.findings.map((finding) => finding.ruleId));

  assert.ok(ruleIds.has("duplicate-account-domain"), "case-insensitive domain duplicates");
  assert.ok(ruleIds.has("duplicate-contact-email"), "case-insensitive email duplicates");
  assert.ok(ruleIds.has("active-deal-account-without-contacts"));
  assert.ok(ruleIds.has("missing-deal-amount"));
  const closingSoon = plan.findings.find((finding) => finding.ruleId === "closing-soon-inactive");
  assert.ok(closingSoon);
  assert.equal(closingSoon.severity, "critical");

  // Policy switches disable the new rules cleanly.
  const relaxed = auditSnapshot(messySnapshot, {
    ...defaultPolicy("2026-06-01"),
    requireDealAmount: false,
    closingSoonIdleDays: 60,
  });
  const relaxedIds = new Set(relaxed.findings.map((finding) => finding.ruleId));
  assert.ok(!relaxedIds.has("missing-deal-amount"));
  assert.ok(!relaxedIds.has("closing-soon-inactive"));
});

test("config file drives policy, rule selection, and third-party rule packages", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-config-"));
  try {
    const snapshotPath = join(dir, "snapshot.json");
    writeFileSync(snapshotPath, JSON.stringify(messySnapshot));

    writeFileSync(
      join(dir, "team-rules.mjs"),
      `export const rules = [{
        id: "team-no-emoji-deal-names",
        title: "Deal names must not contain emoji",
        description: "House style: deal names stay plain text.",
        category: "team",
        evaluate: ({ snapshot }) => ({
          findings: snapshot.deals
            .filter((deal) => /[\\u{1F300}-\\u{1FAFF}]/u.test(deal.name))
            .map((deal) => ({
              id: "finding_team_" + deal.id,
              objectType: "deal", objectId: deal.id,
              ruleId: "team-no-emoji-deal-names",
              title: "Deal names must not contain emoji",
              severity: "info",
              summary: deal.name + " contains emoji.",
              recommendation: "Rename the deal.",
            })),
          operations: [],
        }),
      }];`,
    );

    const configPath = join(dir, "fullstackgtm.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        policy: { today: "2026-06-01", requireDealAmount: false },
        rules: { disabled: ["stale-deal"] },
        rulePackages: ["./team-rules.mjs"],
      }),
    );

    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        ["--experimental-strip-types", "src/bin.ts", ...args],
        { cwd: repoRoot, encoding: "utf8" },
      );

    const refused = run(["rules", "--config", configPath, "--json"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Refusing to load plugin code[\s\S]*--allow-plugins/);

    const withoutPlugins = run(["rules", "--config", configPath, "--no-plugins", "--json"]);
    assert.equal(withoutPlugins.status, 0, withoutPlugins.stderr);
    assert.ok(!JSON.parse(withoutPlugins.stdout).some((rule: { id: string }) => rule.id === "team-no-emoji-deal-names"));

    const implicit = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(repoRoot, "src/bin.ts"), "rules", "--json"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(implicit.status, 1);
    assert.match(implicit.stderr, /Refusing to load plugin code/);

    const implicitAllow = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(repoRoot, "src/bin.ts"), "rules", "--allow-plugins", "--json"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(implicitAllow.status, 1);
    assert.match(implicitAllow.stderr, /requires --config/);

    const rules = run(["rules", "--config", configPath, "--allow-plugins", "--json"]);
    assert.equal(rules.status, 0, rules.stderr);
    const ruleList = JSON.parse(rules.stdout);
    const ids = ruleList.map((rule: { id: string }) => rule.id);
    assert.ok(ids.includes("team-no-emoji-deal-names"), "rule package loaded");
    assert.ok(!ids.includes("stale-deal"), "disabled rule removed");

    const audit = run([
      "audit", "--input", snapshotPath, "--config", configPath, "--allow-plugins", "--json",
    ]);
    assert.equal(audit.status, 0, audit.stderr);
    const plan = JSON.parse(audit.stdout);
    const firedRules = new Set(plan.findings.map((finding: { ruleId: string }) => finding.ruleId));
    assert.ok(!firedRules.has("missing-deal-amount"), "config policy respected");
    assert.ok(!firedRules.has("stale-deal"), "disabled rule did not run");
    assert.ok(firedRules.has("duplicate-account-domain"));

    // CLI flags still beat config: forcing --rules narrows to one rule.
    const narrowed = run([
      "audit", "--input", snapshotPath, "--config", configPath, "--allow-plugins", "--json",
      "--rules", "duplicate-contact-email",
    ]);
    const narrowedPlan = JSON.parse(narrowed.stdout);
    assert.ok(
      narrowedPlan.findings.every(
        (finding: { ruleId: string }) => finding.ruleId === "duplicate-contact-email",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
