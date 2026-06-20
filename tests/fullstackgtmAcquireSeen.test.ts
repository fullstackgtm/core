import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  crmContactKeys,
  partitionFreshProspects,
  prospectIdentityKeys,
  type Prospect,
} from "../src/connectors/prospectSources.ts";
import { loadSeen, recordSeen } from "../src/acquireSeen.ts";
import type { CanonicalGtmSnapshot } from "../src/types.ts";

test("prospectIdentityKeys: linkedin, name+domain, email (missing fields omitted)", () => {
  assert.deepEqual(
    prospectIdentityKeys({
      fullName: "Jane Doe",
      companyDomain: "Acme.com",
      linkedin: "https://www.linkedin.com/in/janedoe/",
      email: "Jane@Acme.com",
    }),
    ["li:https://www.linkedin.com/in/janedoe", "nd:jane doe|acme.com", "em:jane@acme.com"],
  );
  // no domain, no email → only what's derivable
  assert.deepEqual(prospectIdentityKeys({ firstName: "Bob", lastName: "Lee" }), []);
});

test("crmContactKeys: builds email + name|domain from snapshot (joining account domain)", () => {
  const snap: CanonicalGtmSnapshot = {
    generatedAt: "2026-06-20T00:00:00.000Z",
    provider: "mock",
    users: [],
    accounts: [{ id: "a1", name: "Acme", domain: "acme.com" }],
    contacts: [{ id: "c1", firstName: "Jane", lastName: "Doe", email: "jane@acme.com", accountId: "a1" }],
    deals: [],
    activities: [],
  };
  const keys = crmContactKeys(snap);
  assert.ok(keys.has("em:jane@acme.com"));
  assert.ok(keys.has("nd:jane doe|acme.com"));
});

test("partitionFreshProspects: drops in-CRM + seen, keeps fresh, counts right", () => {
  const crm = new Set(["nd:jane doe|acme.com"]); // Jane already in CRM (no email needed pre-resolution)
  const seen = new Set(["li:https://www.linkedin.com/in/bob"]); // Bob processed last run
  const prospects: Prospect[] = [
    { fullName: "Jane Doe", companyDomain: "acme.com" }, // in CRM
    { fullName: "Bob Lee", companyDomain: "globex.com", linkedin: "https://www.linkedin.com/in/bob" }, // seen
    { fullName: "Carol New", companyDomain: "newco.io" }, // fresh
  ];
  const { fresh, skippedCrm, skippedSeen } = partitionFreshProspects(prospects, crm, seen);
  assert.equal(skippedCrm, 1);
  assert.equal(skippedSeen, 1);
  assert.deepEqual(fresh.map((p) => p.fullName), ["Carol New"]);
});

test("acquireSeen: record then load round-trips and merges", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-seen-"));
  try {
    assert.equal(loadSeen(dir).size, 0);
    recordSeen(["li:a", "em:x@y.com"], new Date("2026-06-20T00:00:00.000Z"), dir);
    recordSeen(["nd:carol new|newco.io"], new Date("2026-06-20T01:00:00.000Z"), dir);
    const seen = loadSeen(dir);
    assert.equal(seen.size, 3);
    assert.ok(seen.has("li:a"));
    assert.ok(seen.has("nd:carol new|newco.io"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
