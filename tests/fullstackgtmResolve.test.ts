import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import { resolveRecord } from "../src/resolve.ts";
import { auditSnapshot, defaultPolicy, provenanceSummary } from "../src/index.ts";
import type { CanonicalGtmSnapshot } from "../src/types.ts";

process.env.FSGTM_NO_BROWSER = "1";

function snapshot(): CanonicalGtmSnapshot {
  return {
    generatedAt: "2026-06-11T00:00:00.000Z",
    provider: "mock",
    users: [{ id: "u1", name: "Ryan", active: true }],
    accounts: [
      { id: "a1", name: "Acme Corp", domain: "acme.com" },
      { id: "a2", name: "Acme Corp", domain: "acme.io" },
      { id: "a3", name: "Globex", domain: "www.globex.com" },
    ],
    contacts: [
      { id: "c1", firstName: "Jane", lastName: "Doe", email: "jane@acme.com", accountId: "a1" },
      { id: "c2", firstName: "Jane", lastName: "Doe", email: "jane.doe@other.com" },
    ],
    deals: [
      { id: "d1", name: "Acme Expansion", accountId: "a1" },
      { id: "d2", name: "Acme Expansion", accountId: "a1", isClosed: true, isWon: true },
      { id: "d3", name: "Old Renewal", accountId: "a1", isClosed: true, isWon: false },
    ],
    activities: [],
  };
}

test("account: domain is identity (exact + normalized), name alone is only suggestive", () => {
  const exists = resolveRecord(snapshot(), { objectType: "account", domain: "https://globex.com/about" });
  assert.equal(exists.verdict, "exists");
  assert.equal(exists.matches[0].id, "a3"); // www. + protocol normalized away

  const byName = resolveRecord(snapshot(), { objectType: "account", name: "Acme Corp" });
  assert.equal(byName.verdict, "ambiguous");
  assert.equal(byName.matches.length, 2);
  assert.match(byName.reason, /supply a domain/i);

  const safe = resolveRecord(snapshot(), { objectType: "account", domain: "newco.dev", name: "NewCo" });
  assert.equal(safe.verdict, "safe_to_create");
});

test("contact: email is identity; duplicate emails block; names never resolve definitively", () => {
  const exists = resolveRecord(snapshot(), { objectType: "contact", email: "JANE@ACME.COM" });
  assert.equal(exists.verdict, "exists");
  assert.equal(exists.matches[0].id, "c1");

  const byName = resolveRecord(snapshot(), { objectType: "contact", name: "Jane Doe" });
  assert.equal(byName.verdict, "ambiguous");
  assert.equal(byName.matches.length, 2);

  const safe = resolveRecord(snapshot(), { objectType: "contact", email: "new@person.com" });
  assert.equal(safe.verdict, "safe_to_create");
});

test("deal: open-deal key blocks double-counting; closed deals don't block but are noted", () => {
  const exists = resolveRecord(snapshot(), { objectType: "deal", name: "acme  expansion", accountId: "a1" });
  assert.equal(exists.verdict, "exists"); // whitespace+case normalized; only the OPEN deal matches
  assert.deepEqual(exists.matches.map((m) => m.id), ["d1"]);

  const renewal = resolveRecord(snapshot(), { objectType: "deal", name: "Old Renewal", accountId: "a1" });
  assert.equal(renewal.verdict, "safe_to_create");
  assert.match(renewal.reason, /closed deal\(s\) share the name/);

  const otherAccount = resolveRecord(snapshot(), { objectType: "deal", name: "Acme Expansion", accountId: "a2" });
  assert.equal(otherAccount.verdict, "safe_to_create"); // key is account-scoped
});

test("missing identity inputs yield ambiguous with guidance, never a guess", () => {
  for (const objectType of ["account", "contact", "deal"] as const) {
    const result = resolveRecord(snapshot(), { objectType });
    assert.equal(result.verdict, "ambiguous");
    assert.match(result.reason, /Supply/);
  }
});

test("CLI gate semantics: exit 0 = safe, exit 2 = match found", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-resolve-"));
  const previous = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  const snapPath = join(home, "snap.json");
  writeFileSync(snapPath, JSON.stringify(snapshot()));
  const prevExit = process.exitCode;
  try {
    process.exitCode = 0;
    await runCli(["resolve", "account", "--domain", "newco.dev", "--input", snapPath]);
    assert.equal(process.exitCode, 0);

    await runCli(["resolve", "account", "--domain", "acme.com", "--input", snapPath, "--json"]);
    assert.equal(process.exitCode, 2);
  } finally {
    process.exitCode = prevExit;
    if (previous === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previous;
  }
});

test("provenance attribution: duplicate findings name the writer", () => {
  const snap = snapshot();
  snap.accounts = [
    { id: "a1", name: "Acme", domain: "acme.com", provenance: { source: "INTEGRATION", sourceLabel: "Gojiberry", sourceId: "app-123" } },
    { id: "a2", name: "Acme Inc", domain: "acme.com", provenance: { source: "INTEGRATION", sourceLabel: "Gojiberry", sourceId: "app-123" } },
    { id: "a3", name: "Acme LLC", domain: "acme.com", provenance: { source: "CRM_UI" } },
  ];
  snap.contacts = [];
  snap.deals = [];
  const plan = auditSnapshot(snap, defaultPolicy("2026-06-11"));
  const dupe = plan.findings.find((f) => f.ruleId === "duplicate-account-domain");
  assert.ok(dupe);
  assert.match(dupe.summary, /Created by: Gojiberry \(app-123\) ×2, CRM_UI/);

  // No provenance → no attribution clause, no noise.
  assert.equal(provenanceSummary([{}, {}]), "");
});
