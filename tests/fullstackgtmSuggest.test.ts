import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import { createFilePlanStore } from "../src/planStore.ts";
import { createHubspotConnector } from "../src/connectors/hubspot.ts";
import { createSalesforceConnector } from "../src/connectors/salesforce.ts";
import { suggestValues } from "../src/suggest.ts";
import type {
  CanonicalGtmSnapshot,
  PatchOperation,
  PatchPlan,
} from "../src/types.ts";

process.env.FSGTM_NO_BROWSER = "1";

function snapshot(overrides: Partial<CanonicalGtmSnapshot> = {}): CanonicalGtmSnapshot {
  return {
    generatedAt: "2026-06-11T00:00:00.000Z",
    provider: "mock",
    users: [{ id: "u1", name: "Ryan Operator", active: true }],
    accounts: [
      { id: "a1", name: "Acme Corp" },
      { id: "a2", name: "Globex" },
      { id: "a3", name: "Initech Solutions" },
    ],
    contacts: [
      { id: "c1", firstName: "Jane", lastName: "Doe", accountId: "a1" },
      { id: "c2", firstName: "Sam", lastName: "Free", accountId: undefined },
      { id: "c3", firstName: "Pat", lastName: "Cross", accountId: "a2" },
    ],
    deals: [],
    activities: [],
    ...overrides,
  };
}

function linkOp(id: string, dealId: string): PatchOperation {
  return {
    id,
    objectType: "deal",
    objectId: dealId,
    operation: "link_record",
    field: "accountId",
    beforeValue: null,
    afterValue: "requires_human_account_selection",
    reason: "test",
    riskLevel: "medium",
    approvalRequired: true,
  };
}

function planWith(operations: PatchOperation[], deals: CanonicalGtmSnapshot["deals"]): {
  plan: PatchPlan;
  snap: CanonicalGtmSnapshot;
} {
  const plan: PatchPlan = {
    id: "plan_test",
    title: "test",
    createdAt: "2026-06-11T00:00:00.000Z",
    status: "needs_approval",
    dryRun: true,
    summary: "",
    findings: [],
    operations,
  };
  return { plan, snap: snapshot({ deals }) };
}

test("exact account-name match with contact agreement is high confidence", () => {
  const { plan, snap } = planWith(
    [linkOp("op1", "d1")],
    [{ id: "d1", name: "Jane Doe - Acme Corp" }],
  );
  const [s] = suggestValues(plan, snap);
  assert.equal(s.confidence, "high");
  assert.equal(s.suggestedValue, "a1");
  assert.match(s.reason, /confirmed by contact/);
});

test("exact account-name match alone is high; partial match alone is low", () => {
  const { plan, snap } = planWith(
    [linkOp("op1", "d1"), linkOp("op2", "d2")],
    [
      { id: "d1", name: "Unknown Person - Globex" },
      { id: "d2", name: "Unknown Person - Initech" },
    ],
  );
  const [exact, partial] = suggestValues(plan, snap);
  assert.equal(exact.confidence, "high");
  assert.equal(exact.suggestedValue, "a2");
  assert.equal(partial.confidence, "low");
  assert.equal(partial.suggestedValue, "a3");
  assert.match(partial.reason, /partial name match/);
});

test("contact-association alone is low confidence", () => {
  const { plan, snap } = planWith(
    [linkOp("op1", "d1")],
    [{ id: "d1", name: "Pat Cross - Nonexistent Co" }],
  );
  const [s] = suggestValues(plan, snap);
  assert.equal(s.confidence, "low");
  assert.equal(s.suggestedValue, "a2");
  assert.match(s.reason, /Contact "Pat Cross"/);
});

test("conflicting signals produce no suggestion", () => {
  const { plan, snap } = planWith(
    [linkOp("op1", "d1")],
    [{ id: "d1", name: "Pat Cross - Acme Corp" }],
  );
  const [s] = suggestValues(plan, snap);
  assert.equal(s.confidence, "none");
  assert.equal(s.suggestedValue, null);
  assert.match(s.reason, /conflict/i);
});

test("known contact without an account plus unmatched company proposes create:", () => {
  const { plan, snap } = planWith(
    [linkOp("op1", "d1")],
    [{ id: "d1", name: "Sam Free - Brand New Startup" }],
  );
  const [s] = suggestValues(plan, snap);
  assert.equal(s.confidence, "create");
  assert.equal(s.suggestedValue, "create:Brand New Startup");
});

test("no pattern and no signals yields guidance, not a guess", () => {
  const { plan, snap } = planWith(
    [linkOp("op1", "d1")],
    [{ id: "d1", name: "Big Q3 Engagement" }],
  );
  const [s] = suggestValues(plan, snap);
  assert.equal(s.confidence, "none");
  assert.equal(s.suggestedValue, null);
  assert.match(s.reason, /create:<Company Name>/);
});

test("owner placeholder suggests the only active user", () => {
  const { plan, snap } = planWith(
    [
      {
        ...linkOp("op1", "d1"),
        operation: "set_field",
        field: "ownerId",
        afterValue: "requires_human_owner_selection",
      },
    ],
    [{ id: "d1", name: "Anything" }],
  );
  const [s] = suggestValues(plan, snap);
  assert.equal(s.confidence, "high");
  assert.equal(s.suggestedValue, "u1");

  const multiUser = { ...snap, users: [...snap.users, { id: "u2", name: "Other", active: true }] };
  const [multi] = suggestValues(plan, multiUser);
  assert.equal(multi.confidence, "none");
});

test("CLI chain: audit --save → suggest --out → plans approve --values-from", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-suggest-"));
  const previous = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = home;
  try {
    const snap = snapshot({
      deals: [
        {
          id: "d1",
          name: "Jane Doe - Acme Corp",
          ownerId: "u1",
          amount: 100,
          stage: "open",
          closeDate: "2099-01-01",
          lastActivityAt: "2026-06-10T00:00:00.000Z",
        },
      ],
    });
    const snapPath = join(home, "snap.json");
    writeFileSync(snapPath, JSON.stringify(snap));
    await runCli(["audit", "--input", snapPath, "--save", "--today", "2026-06-11"]);

    const store = createFilePlanStore();
    const [stored] = await store.list();
    assert.ok(stored, "audit --save stored a plan");
    const linkOps = stored.plan.operations.filter(
      (op) => op.afterValue === "requires_human_account_selection",
    );
    assert.equal(linkOps.length, 1);

    const suggestionsPath = join(home, "suggestions.json");
    await runCli(["suggest", "--plan-id", stored.plan.id, "--input", snapPath, "--out", suggestionsPath]);
    const payload = JSON.parse(readFileSync(suggestionsPath, "utf8"));
    assert.equal(payload.suggestions.length, 1);
    assert.equal(payload.suggestions[0].confidence, "high");
    assert.equal(payload.suggestions[0].suggestedValue, "a1");

    await runCli(["plans", "approve", stored.plan.id, "--values-from", suggestionsPath]);
    const approved = await store.get(stored.plan.id);
    assert.equal(approved?.status, "approved");
    assert.deepEqual(approved?.approvedOperationIds, [linkOps[0].id]);
    assert.equal(approved?.valueOverrides[linkOps[0].id], "a1");
  } finally {
    if (previous === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previous;
  }
});

test("hubspot link_record create:<Name> resolves first, creates on miss, dedupes within the run", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const connector = createHubspotConnector({
    getAccessToken: () => "token",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string });
      if (String(url).endsWith("/crm/v3/objects/companies/search")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      if (String(url).endsWith("/crm/v3/objects/companies") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "999" }), { status: 201 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  const result = await connector.applyOperation({
    ...linkOp("op1", "D77"),
    afterValue: "create:NewCo Inc",
  });
  assert.equal(result.status, "applied");
  assert.match(result.detail ?? "", /Created company "NewCo Inc" \(999\)/);
  // resolve-first search, create, link
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/crm\/v3\/objects\/companies\/search$/);
  assert.match(calls[1].url, /\/crm\/v3\/objects\/companies$/);
  assert.equal(JSON.parse(calls[1].body!).properties.name, "NewCo Inc");
  assert.match(calls[2].url, /deals\/D77\/associations\/default\/companies\/999$/);

  // Second create: of the same name within the run reuses the created id —
  // no second search, no second create, just the link.
  const second = await connector.applyOperation({
    ...linkOp("op2", "D88"),
    afterValue: "create:NewCo Inc",
  });
  assert.equal(second.status, "applied");
  assert.match(second.detail ?? "", /existing company 999/);
  assert.equal(calls.length, 4);
  assert.match(calls[3].url, /deals\/D88\/associations\/default\/companies\/999$/);
});

test("hubspot link_record create:<Name> links an existing unambiguous match instead of creating", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const connector = createHubspotConnector({
    getAccessToken: () => "token",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (String(url).endsWith("/crm/v3/objects/companies/search")) {
        return new Response(JSON.stringify({ results: [{ id: "555" }] }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  const result = await connector.applyOperation({
    ...linkOp("op1", "D77"),
    afterValue: "create:Existing Co",
  });
  assert.equal(result.status, "applied");
  assert.match(result.detail ?? "", /existing company 555.*nothing created/);
  assert.equal(calls.filter((c) => c.method === "POST" && c.url.endsWith("/companies")).length, 0);
});

test("hubspot link_record create:<Name> refuses on ambiguous existing matches", async () => {
  const connector = createHubspotConnector({
    getAccessToken: () => "token",
    fetchImpl: (async (url: string | URL | Request) => {
      if (String(url).endsWith("/crm/v3/objects/companies/search")) {
        return new Response(JSON.stringify({ results: [{ id: "1" }, { id: "2" }] }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  const result = await connector.applyOperation({
    ...linkOp("op1", "D77"),
    afterValue: "create:Acme",
  });
  assert.equal(result.status, "skipped");
  assert.match(result.detail ?? "", /ambiguous/);
});

test("salesforce link_record create:<Name> resolves first, then creates the Account and sets AccountId", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "t", instanceUrl: "https://x.my.salesforce.com" }),
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body as string });
      if (String(url).includes("/query") && String(url).includes("FROM%20Account")) {
        return new Response(JSON.stringify({ records: [], done: true }), { status: 200 });
      }
      if (String(url).includes("/sobjects/Account") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "001ABC" }), { status: 201 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  const result = await connector.applyOperation({
    ...linkOp("op1", "006XYZ"),
    afterValue: "create:NewCo LLC",
  });
  assert.equal(result.status, "applied");
  assert.match(result.detail ?? "", /Created account "NewCo LLC" \(001ABC\)/);
  // resolve-first SOQL, create, then the AccountId PATCH
  assert.equal(calls.length, 3);
  assert.match(decodeURIComponent(calls[0].url), /SELECT Id FROM Account WHERE Name = 'NewCo LLC'/);
  assert.match(calls[1].url, /\/sobjects\/Account$/);
  assert.equal(JSON.parse(calls[1].body!).Name, "NewCo LLC");
  assert.match(calls[2].body ?? "", /001ABC/);
});

test("salesforce link_record create:<Name> links an existing unambiguous Account instead of creating", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "t", instanceUrl: "https://x.my.salesforce.com" }),
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (String(url).includes("/query")) {
        return new Response(JSON.stringify({ records: [{ Id: "001EXIST" }], done: true }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  const result = await connector.applyOperation({
    ...linkOp("op1", "006XYZ"),
    afterValue: "create:Globex",
  });
  assert.equal(result.status, "applied");
  assert.match(result.detail ?? "", /existing account 001EXIST.*nothing created/);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("hubspot readField(accountId) reads the association so CAS catches link replays", async () => {
  const connector = createHubspotConnector({
    getAccessToken: () => "token",
    fetchImpl: (async (url: string | URL | Request) => {
      if (String(url).includes("/crm/v4/objects/deals/D77/associations/companies")) {
        return new Response(JSON.stringify({ results: [{ toObjectId: 999 }] }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  const value = await connector.readField!("deal", "D77", "accountId");
  assert.equal(value, "999");

  const unlinked = createHubspotConnector({
    getAccessToken: () => "token",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 })) as typeof fetch,
  });
  assert.equal(await unlinked.readField!("deal", "D77", "accountId"), null);
});

test("duplicate-account-domain groups www./protocol variants of the same domain", async () => {
  const { auditSnapshot, defaultPolicy } = await import("../src/index.ts");
  const snap = snapshot({
    accounts: [
      { id: "a1", name: "Acme", domain: "acme.com" },
      { id: "a2", name: "Acme Inc", domain: "www.acme.com" },
      { id: "a3", name: "Acme LLC", domain: "https://acme.com/about" },
    ],
  });
  const plan = auditSnapshot(snap, defaultPolicy("2026-06-11"));
  const dupes = plan.findings.filter((f) => f.ruleId === "duplicate-account-domain");
  assert.equal(dupes.length, 1);
  assert.match(dupes[0].summary, /3 accounts/);
});
