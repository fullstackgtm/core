import assert from "node:assert/strict";
import test from "node:test";

import {
  createFakeLinkedInProvider,
  createHeyReachProvider,
  normalizeHeyReachLead,
  FAKE_LINKEDIN_PROSPECTS,
  HEYREACH_BASE,
} from "../src/connectors/linkedin.ts";

// A recording fetch stub: route by pathname → {status?, body?, headers?}.
// Each route value may be a function (callIndex, parsedBody) => spec for paging.
function mockFetch(routes: Record<string, any>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
  const impl = async (url: string | URL, init?: any) => {
    const u = String(url);
    const path = new URL(u).pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: u, method: init?.method ?? "GET", headers, body });
    const route = routes[path] ?? routes["*"];
    if (!route) return new Response("not found", { status: 404 });
    const spec = typeof route === "function" ? route(calls.length, body) : route;
    return new Response(spec.body === undefined ? null : JSON.stringify(spec.body), {
      status: spec.status ?? 200,
      headers: spec.headers,
    });
  };
  (impl as any).calls = calls;
  return impl as unknown as typeof fetch & { calls: typeof calls };
}

test("fake provider: lists a source, caps prospects, reports a connection", async () => {
  const provider = createFakeLinkedInProvider();
  assert.equal(provider.name, "fake");
  assert.deepEqual(await provider.checkConnection(), { ok: true, detail: "fake LinkedIn provider" });

  const sources = await provider.listSources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, "list_demo");

  const all = await provider.fetchProspects();
  assert.equal(all.length, FAKE_LINKEDIN_PROSPECTS.length);
  const capped = await provider.fetchProspects({ max: 2 });
  assert.equal(capped.length, 2);
  // Returns copies, not the internal array.
  capped[0].company = "MUTATED";
  assert.notEqual((await provider.fetchProspects())[0].company, "MUTATED");
});

test("heyreach checkConnection hits CheckApiKey with the key in the header, not the URL", async () => {
  const fetchImpl = mockFetch({ "/api/public/auth/CheckApiKey": { status: 200, body: { ok: true } } });
  const provider = createHeyReachProvider({ apiKey: "secret-key-123", fetchImpl });
  const status = await provider.checkConnection();
  assert.equal(status.ok, true);

  const call = fetchImpl.calls[0];
  assert.equal(call.method, "GET");
  assert.match(call.url, /\/api\/public\/auth\/CheckApiKey$/);
  assert.equal(call.headers["X-API-KEY"], "secret-key-123");
  assert.doesNotMatch(call.url, /secret-key-123/); // secret never in the URL
});

test("heyreach checkConnection returns ok:false (never throws) on a bad key", async () => {
  const fetchImpl = mockFetch({ "/api/public/auth/CheckApiKey": { status: 401, body: { error: "unauthorized" } } });
  const provider = createHeyReachProvider({ apiKey: "bad", fetchImpl });
  const status = await provider.checkConnection();
  assert.equal(status.ok, false);
  assert.match(status.detail, /401/);
});

test("heyreach listSources POSTs GetAll and maps id/name/count", async () => {
  const fetchImpl = mockFetch({
    "/api/public/list/GetAll": {
      body: { items: [{ id: 7, name: "ICP — RevOps", totalItemsCount: 42 }, { listId: 9, title: "Untitled" }] },
    },
  });
  const provider = createHeyReachProvider({ apiKey: "k", fetchImpl });
  const sources = await provider.listSources();
  assert.deepEqual(sources, [
    { id: "7", name: "ICP — RevOps", count: 42 },
    { id: "9", name: "Untitled", count: undefined },
  ]);
  assert.equal(fetchImpl.calls[0].method, "POST");
  assert.deepEqual(fetchImpl.calls[0].body, { offset: 0, limit: 100 });
});

test("heyreach fetchProspects paginates, normalizes, and respects max", async () => {
  const page = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      profile: {
        firstName: `F${i}`,
        lastName: `L${i}`,
        position: "VP RevOps",
        companyName: "Acme",
        profileUrl: `https://www.linkedin.com/in/f${i}`,
        emailAddress: `f${i}@acme.test`,
      },
    }));
  const fetchImpl = mockFetch({
    // pageSize 2 → first call full page (continue), second call partial (stop).
    "/api/public/list/GetLeadsFromList": (callIndex: number) =>
      callIndex === 1 ? { body: { items: page(2) } } : { body: { items: page(1) } },
  });
  const provider = createHeyReachProvider({ apiKey: "k", fetchImpl, pageSize: 2 });

  const prospects = await provider.fetchProspects({ sourceId: "7" });
  assert.equal(prospects.length, 3); // 2 + 1 across two pages
  assert.equal(prospects[0].profileUrl, "https://www.linkedin.com/in/f0");
  assert.equal(prospects[0].jobTitle, "VP RevOps");
  assert.equal(prospects[0].company, "Acme");
  assert.equal(prospects[0].email, "f0@acme.test");
  // Pagination advanced the offset.
  assert.deepEqual(fetchImpl.calls[1].body, { listId: "7", offset: 2, limit: 2 });

  // max caps before the second page is even fetched.
  const fetchImpl2 = mockFetch({
    "/api/public/list/GetLeadsFromList": { body: { items: page(2) } },
  });
  const provider2 = createHeyReachProvider({ apiKey: "k", fetchImpl: fetchImpl2, pageSize: 2 });
  const limited = await provider2.fetchProspects({ sourceId: "7", max: 1 });
  assert.equal(limited.length, 1);
  assert.equal(fetchImpl2.calls.length, 1);
});

test("heyreach fetchProspects refuses without a source, surfaces 429, and uses defaultListId", async () => {
  const noSource = createHeyReachProvider({ apiKey: "k", fetchImpl: mockFetch({}) });
  await assert.rejects(noSource.fetchProspects(), /needs a sourceId/);

  const rateLimited = createHeyReachProvider({
    apiKey: "k",
    fetchImpl: mockFetch({ "/api/public/list/GetLeadsFromList": { status: 429, headers: { "Retry-After": "30" } } }),
    defaultListId: "list_x",
  });
  await assert.rejects(rateLimited.fetchProspects(), /429.*retry after 30s|300 requests\/min/);
});

test("createHeyReachProvider requires an API key", () => {
  assert.throws(() => createHeyReachProvider({ apiKey: "" }), /API key is required/);
});

test("normalizeHeyReachLead handles both nested-profile and flat payloads", () => {
  const nested = normalizeHeyReachLead({
    profile: { firstName: "A", lastName: "B", profileUrl: "https://linkedin.com/in/ab", companyName: "Co" },
  });
  assert.equal(nested.fullName, "A B");
  assert.equal(nested.company, "Co");
  assert.equal(nested.profileUrl, "https://linkedin.com/in/ab");

  const flat = normalizeHeyReachLead({ firstName: "C", lastName: "D", linkedin_url: "https://linkedin.com/in/cd" });
  assert.equal(flat.profileUrl, "https://linkedin.com/in/cd");
  assert.equal(flat.raw && (flat.raw as any).firstName, "C"); // raw preserved
});

test("normalizeHeyReachLead falls back to HeyReach's enrichment email fields", () => {
  // Live /list/GetLeadsFromList leads carry emailAddress + enrichedEmailAddress +
  // customEmailAddress; prefer whichever is present, raw first.
  assert.equal(normalizeHeyReachLead({ emailAddress: "raw@x.test", enrichedEmailAddress: "e@x.test" }).email, "raw@x.test");
  assert.equal(normalizeHeyReachLead({ emailAddress: "", enrichedEmailAddress: "e@x.test" }).email, "e@x.test");
  assert.equal(normalizeHeyReachLead({ customEmailAddress: "c@x.test" }).email, "c@x.test");
  assert.equal(normalizeHeyReachLead({ firstName: "No", lastName: "Email" }).email, undefined);
});

// HEYREACH_BASE is exported for the acquire wiring (Phase 1 step 2) to reuse.
test("HEYREACH_BASE is the public API root", () => {
  assert.equal(HEYREACH_BASE, "https://api.heyreach.io/api/public");
});
