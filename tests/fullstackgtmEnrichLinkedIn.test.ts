import assert from "node:assert/strict";
import test from "node:test";

import { builtinAcquirePreset, matchSourceRecord } from "../src/enrich.ts";
import type { CanonicalGtmSnapshot } from "../src/types.ts";

test("builtinAcquirePreset('linkedin') keys on the LinkedIn URL at $0/record", () => {
  for (const source of ["linkedin", "heyreach"]) {
    const cfg = builtinAcquirePreset(source);
    assert.ok(cfg?.acquire, `preset for ${source}`);
    const acq = cfg!.acquire!;
    assert.equal(acq.create.contact?.matchKey, "linkedin");
    assert.equal(acq.discovery?.linkedin?.provider, "linkedin");
    assert.equal(acq.costPerRecord?.linkedin, 0); // our own data
    assert.equal(acq.create.contact?.properties?.hs_linkedin_url, "linkedin");
    // The enrich matcher must accept "linkedin" as a contact key (MATCH_KEYS).
    assert.deepEqual(cfg!.match.contact?.keys, ["linkedin", "email"]);
    // No spend budget — LinkedIn discovery costs nothing.
    assert.equal(acq.budget?.spend, undefined);
  }
});

test("matchSourceRecord matches a contact by LinkedIn URL, trailing-slash-insensitive", () => {
  const snapshot = {
    users: [],
    accounts: [],
    contacts: [
      { id: "c1", firstName: "Dana", lastName: "Okafor", linkedin: "https://www.linkedin.com/in/dana-okafor/" },
      { id: "c2", firstName: "Other", lastName: "Person", linkedin: "https://www.linkedin.com/in/someone-else" },
    ],
    deals: [],
    activities: [],
  } as unknown as CanonicalGtmSnapshot;

  // Same profile, no trailing slash → matched (normalization aligns both sides).
  const hit = matchSourceRecord(snapshot, "contact", ["linkedin"], {
    linkedin: "https://www.linkedin.com/in/dana-okafor",
  });
  assert.equal(hit.status, "matched");
  assert.equal((hit as { recordId: string }).recordId, "c1");
  assert.equal((hit as { matchedKey: string }).matchedKey, "linkedin");

  // A profile not in the CRM → unmatched (safe to create).
  const miss = matchSourceRecord(snapshot, "contact", ["linkedin"], {
    linkedin: "https://www.linkedin.com/in/nobody-here",
  });
  assert.equal(miss.status, "unmatched");
});
