import assert from "node:assert/strict";
import test from "node:test";

import {
  createFakeLinkedInProvider,
  type LinkedInProspect,
} from "../src/connectors/linkedin.ts";
import {
  createLinkedInProvider,
  discoverLinkedInProspects,
  linkedInProspectToProspect,
} from "../src/acquireLinkedIn.ts";

test("linkedInProspectToProspect maps to the canonical Prospect shape", () => {
  const lp: LinkedInProspect = {
    firstName: "Dana",
    lastName: "Okafor",
    fullName: "Dana Okafor",
    jobTitle: "VP Revenue Operations",
    company: "Northwind",
    profileUrl: "https://www.linkedin.com/in/dana-okafor",
    email: "dana@northwind.test",
  };
  const p = linkedInProspectToProspect(lp);
  assert.equal(p.firstName, "Dana");
  assert.equal(p.companyName, "Northwind");
  // Profile URL becomes both the identity key (linkedin) and the traceable sourceId.
  assert.equal(p.linkedin, "https://www.linkedin.com/in/dana-okafor");
  assert.equal(p.sourceId, "https://www.linkedin.com/in/dana-okafor");
  assert.equal(p.email, "dana@northwind.test");
  assert.equal(p.jobTitle, "VP Revenue Operations");
});

test("title falls back to headline; empty strings become undefined (not ''))", () => {
  const p = linkedInProspectToProspect({
    firstName: "",
    lastName: "",
    headline: "Head of Sales Ops",
    profileUrl: "https://linkedin.com/in/x",
  });
  assert.equal(p.jobTitle, "Head of Sales Ops"); // headline fallback
  assert.equal(p.firstName, undefined);
  assert.equal(p.email, undefined);
});

test("discoverLinkedInProspects pulls from a provider and maps + caps", async () => {
  const provider = createFakeLinkedInProvider();
  const all = await discoverLinkedInProspects(provider);
  assert.equal(all.length, 3);
  assert.ok(all.every((p) => typeof p.linkedin === "string" && p.linkedin.includes("linkedin.com")));
  // Every mapped prospect carries the ICP-scorable title field.
  assert.ok(all.every((p) => typeof p.jobTitle === "string"));

  const capped = await discoverLinkedInProspects(provider, { max: 1 });
  assert.equal(capped.length, 1);
});

test("discoverLinkedInProspects is read-only and reflects a custom source set", async () => {
  const provider = createFakeLinkedInProvider({
    prospects: [
      { firstName: "Sole", lastName: "Lead", profileUrl: "https://linkedin.com/in/sole", jobTitle: "CRO" },
    ],
  });
  const out = await discoverLinkedInProspects(provider);
  assert.equal(out.length, 1);
  assert.equal(out[0].jobTitle, "CRO");
  assert.equal(out[0].linkedin, "https://linkedin.com/in/sole");
});

test("createLinkedInProvider dispatches heyreach/linkedin and rejects unknown", () => {
  for (const source of ["heyreach", "linkedin"]) {
    const provider = createLinkedInProvider(source, "key", { fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });
    assert.equal(provider.name, "heyreach");
  }
  assert.throws(() => createLinkedInProvider("expandi", "key"), /Unknown LinkedIn execution provider/);
});
