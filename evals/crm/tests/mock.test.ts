import assert from "node:assert/strict";
import test from "node:test";
import { MockHubspot } from "../src/mock/server.ts";

async function api(baseUrl: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("pagination: default page 10, cursor walks the full set", async () => {
  const s = new MockHubspot();
  for (let i = 0; i < 23; i += 1) s.seed("companies", { name: `C${i}`, domain: `c${i}.com` });
  const baseUrl = await s.start();
  try {
    const p1 = await api(baseUrl, "GET", "/crm/v3/objects/companies");
    assert.equal(p1.body.results.length, 10);
    const p2 = await api(baseUrl, "GET", `/crm/v3/objects/companies?after=${p1.body.paging.next.after}`);
    assert.equal(p2.body.results.length, 10);
    const p3 = await api(baseUrl, "GET", `/crm/v3/objects/companies?after=${p2.body.paging.next.after}`);
    assert.equal(p3.body.results.length, 3);
    assert.equal(p3.body.paging, undefined);
  } finally {
    await s.stop();
  }
});

test("search eventual consistency: fresh creates are invisible, then appear", async () => {
  const s = new MockHubspot();
  s.searchVisibilityLagOps = 5;
  const baseUrl = await s.start();
  try {
    const created = await api(baseUrl, "POST", "/crm/v3/objects/companies", {
      properties: { name: "Hooli", domain: "hooli.com" },
    });
    assert.equal(created.status, 201);
    const search = () =>
      api(baseUrl, "POST", "/crm/v3/objects/companies/search", {
        filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: "hooli" }] }],
      });
    const miss = await search();
    assert.equal(miss.body.results.length, 0, "fresh create must be invisible to search");
    for (let i = 0; i < 6; i += 1) await api(baseUrl, "GET", "/crm/v3/owners");
    const hit = await search();
    assert.equal(hit.body.results.length, 1, "create becomes visible after the lag window");
    // direct GET always sees it
    const direct = await api(baseUrl, "GET", `/crm/v3/objects/companies/${created.body.id}`);
    assert.equal(direct.status, 200);
  } finally {
    await s.stop();
  }
});

test("drift afterRequests=-1 fires before the first mutation only", async () => {
  const s = new MockHubspot();
  const dealId = s.seed("deals", { dealname: "D", dealstage: "qualifiedtobuy", hubspot_owner_id: "1" });
  s.scheduleDrift(-1, "reassign", (srv) => {
    srv.get("deals", dealId)!.properties.hubspot_owner_id = "99";
  });
  const baseUrl = await s.start();
  try {
    const read = await api(baseUrl, "GET", `/crm/v3/objects/deals/${dealId}`);
    assert.equal(read.body.properties.hubspot_owner_id, "1", "reads must not trigger drift");
    await api(baseUrl, "PATCH", `/crm/v3/objects/deals/${dealId}`, { properties: { amount: "5" } });
    const after = await api(baseUrl, "GET", `/crm/v3/objects/deals/${dealId}`);
    assert.equal(after.body.properties.hubspot_owner_id, "99", "drift fires with the first mutation");
    assert.equal(after.body.properties.amount, "5", "the agent's write still lands");
  } finally {
    await s.stop();
  }
});

test("merge: survivor keeps values, loser fills gaps and is archived", async () => {
  const s = new MockHubspot();
  const a = s.seed("companies", { name: "Acme", domain: "acme.com", numberofemployees: 250 });
  const b = s.seed("companies", { name: "Acme Inc", domain: "acme.com", industry: "Mfg" });
  const baseUrl = await s.start();
  try {
    const res = await api(baseUrl, "POST", "/crm/v3/objects/companies/merge", {
      primaryObjectId: a,
      objectIdToMerge: b,
    });
    assert.equal(res.status, 200);
    const survivor = s.get("companies", a)!;
    assert.equal(survivor.properties.name, "Acme");
    assert.equal(survivor.properties.industry, "Mfg", "loser fills missing properties");
    assert.equal(s.get("companies", b)!.archived, true);
    const again = await api(baseUrl, "POST", "/crm/v3/objects/companies/merge", {
      primaryObjectId: a,
      objectIdToMerge: b,
    });
    assert.equal(again.status, 404, "merging an already-merged loser 404s like HubSpot");
  } finally {
    await s.stop();
  }
});

test("mutation log records writes with object ids", async () => {
  const s = new MockHubspot();
  const id = s.seed("contacts", { firstname: "T" });
  const baseUrl = await s.start();
  try {
    await api(baseUrl, "GET", "/crm/v3/objects/contacts");
    await api(baseUrl, "PATCH", `/crm/v3/objects/contacts/${id}`, { properties: { email: "t@x.com" } });
    await api(baseUrl, "DELETE", `/crm/v3/objects/contacts/${id}`);
    const muts = s.mutations();
    assert.deepEqual(muts.map((m) => m.kind), ["update", "archive"]);
    assert.ok(muts.every((m) => m.objectId === id));
  } finally {
    await s.stop();
  }
});
