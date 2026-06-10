import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  auditSnapshot,
  defaultPolicy,
  mergeSnapshots,
  type CanonicalGtmSnapshot,
} from "../src/index.ts";

const repoRoot = resolve(import.meta.dirname, "..");

const hubspotSnapshot: CanonicalGtmSnapshot = {
  generatedAt: "2026-06-09T01:00:00.000Z",
  provider: "hubspot",
  users: [{ id: "9001", crmId: "9001", name: "Rae Park", email: "rae@example.com" }],
  accounts: [
    { id: "c1", crmId: "c1", name: "Acme", domain: "acme.com", industry: "SaaS", ownerId: "9001" },
    { id: "c2", crmId: "c2", name: "Solo HubSpot Co", domain: "solohub.com" },
  ],
  contacts: [{ id: "p1", crmId: "p1", accountId: "c1", email: "jo@acme.com", firstName: "Jo" }],
  deals: [
    {
      id: "d1", crmId: "d1", accountId: "c1", ownerId: "9001",
      name: "Acme Expansion", amount: 50_000, closeDate: "2026-08-01",
      lastActivityAt: "2026-06-05", isClosed: false,
    },
  ],
  activities: [],
};

const salesforceSnapshot: CanonicalGtmSnapshot = {
  generatedAt: "2026-06-09T02:00:00.000Z",
  provider: "salesforce",
  users: [{ id: "005A", crmId: "005A", name: "Rae Park", email: "RAE@example.com" }],
  accounts: [
    {
      id: "001A", crmId: "001A", name: "ACME Corp", domain: "www.acme.com",
      industry: "Software", ownerId: "005A",
    },
  ],
  contacts: [
    { id: "003A", crmId: "003A", accountId: "001A", email: "JO@acme.com", title: "CTO" },
  ],
  deals: [
    {
      id: "006A", crmId: "006A", accountId: "001A", ownerId: "005A",
      name: "Acme Renewal", amount: 30_000, closeDate: "2026-07-01",
      lastActivityAt: "2026-06-06", isClosed: false,
    },
  ],
  activities: [],
};

test("merge collapses entities on domain/email keys and keeps every identity", () => {
  const { snapshot, report } = mergeSnapshots([hubspotSnapshot, salesforceSnapshot]);

  assert.equal(snapshot.provider, "merged");
  assert.equal(snapshot.users.length, 1);
  assert.deepEqual(
    snapshot.users[0].identities,
    [
      { provider: "hubspot", externalId: "9001" },
      { provider: "salesforce", externalId: "005A" },
    ],
  );

  assert.equal(snapshot.accounts.length, 2);
  const acme = snapshot.accounts.find((account) => account.name === "Acme")!;
  assert.equal(acme.identities?.length, 2);
  assert.equal(snapshot.contacts.length, 1);
  assert.equal(snapshot.contacts[0].identities?.length, 2);
  // Gap-filling: title only existed in Salesforce, survives the merge.
  assert.equal(snapshot.contacts[0].title, "CTO");

  // Deals are provider-unique but re-pointed at the merged account.
  assert.equal(snapshot.deals.length, 2);
  assert.ok(snapshot.deals.every((deal) => deal.accountId === acme.id));
  assert.ok(snapshot.deals.every((deal) => deal.ownerId === snapshot.users[0].id));

  // Disagreements are reported, never silently resolved (first source wins).
  const industryConflict = report.conflicts.find((conflict) => conflict.field === "industry");
  assert.ok(industryConflict);
  assert.equal(acme.industry, "SaaS");
  assert.deepEqual(report.sources, ["hubspot", "salesforce"]);
});

test("account-single-source fires only on multi-system snapshots", () => {
  const { snapshot } = mergeSnapshots([hubspotSnapshot, salesforceSnapshot]);
  const merged = auditSnapshot(snapshot, defaultPolicy("2026-06-09"));
  const singleSource = merged.findings.filter(
    (finding) => finding.ruleId === "account-single-source",
  );
  assert.equal(singleSource.length, 1);
  assert.match(singleSource[0].summary, /Solo HubSpot Co exists only in hubspot/);

  // The same rule is inert on a single-provider snapshot.
  const solo = auditSnapshot(hubspotSnapshot, defaultPolicy("2026-06-09"));
  assert.ok(solo.findings.every((finding) => finding.ruleId !== "account-single-source"));
});

test("cli merge writes the merged snapshot and reports conflicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-merge-"));
  try {
    const aPath = join(dir, "hubspot.json");
    const bPath = join(dir, "salesforce.json");
    const outPath = join(dir, "merged.json");
    writeFileSync(aPath, JSON.stringify(hubspotSnapshot));
    writeFileSync(bPath, JSON.stringify(salesforceSnapshot));

    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        ["--experimental-strip-types", "src/bin.ts", ...args],
        { cwd: repoRoot, encoding: "utf8" },
      );

    const merge = run([
      "merge", "--input", aPath, "--input", bPath, "--out", outPath, "--json",
    ]);
    assert.equal(merge.status, 0, merge.stderr);
    const report = JSON.parse(merge.stdout);
    assert.equal(report.conflicts.length >= 1, true);

    const merged = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(merged.provider, "merged");

    const audit = run([
      "audit", "--input", outPath, "--today", "2026-06-09", "--json",
      "--rules", "account-single-source",
    ]);
    assert.equal(audit.status, 0, audit.stderr);
    const plan = JSON.parse(audit.stdout);
    assert.equal(plan.findings.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
