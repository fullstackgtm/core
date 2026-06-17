import assert from "node:assert/strict";
import test from "node:test";
import { createSalesforceConnector } from "../src/index.ts";

type StubCall = { url: string; init?: RequestInit };

function stubFetch() {
  const calls: StubCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (init?.method === "PATCH") {
      // Salesforce PATCH returns 204 No Content on success.
      return new Response(null, { status: 204 });
    }
    if (init?.method === "POST") {
      // sobject create returns the new id.
      return new Response(JSON.stringify({ id: "00T000000000001", success: true }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    const soql = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
    const respond = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if (url.includes("/query/next-page")) {
      return respond({
        records: [
          {
            Id: "006B",
            Name: "Globex Renewal",
            StageName: "Closed Won",
            Amount: 90000,
            CloseDate: "2026-04-01",
            Probability: 100,
            IsClosed: true,
            IsWon: true,
            ForecastCategory: "Closed",
            LastActivityDate: "2026-03-15",
            OwnerId: "005A",
            AccountId: "001A",
          },
          {
            Id: "006C",
            Name: "Globex Lost",
            StageName: "Closed Lost",
            Amount: 40000,
            CloseDate: "2026-03-01",
            Probability: 0,
            IsClosed: true,
            IsWon: false,
            ForecastCategory: "Omitted",
            LastActivityDate: "2026-02-10",
            OwnerId: "005A",
            AccountId: "001A",
          },
        ],
      });
    }
    if (soql.includes("FROM User")) {
      return respond({
        records: [
          { Id: "005A", Name: "Rae Park", Email: "rae@example.com", Title: "AE", IsActive: true },
          { Id: "005B", Name: "Departed Rep", Email: null, IsActive: false },
        ],
      });
    }
    if (soql.includes("FROM Task")) {
      // create_task idempotency pre-check: no existing task by default.
      return respond({ records: [] });
    }
    if (soql.includes("FROM Account")) {
      return respond({
        records: [
          {
            Id: "001A",
            Name: "Globex",
            Website: "globex.com",
            Industry: "Manufacturing",
            NumberOfEmployees: 1200,
            AnnualRevenue: 25000000,
            OwnerId: "005A",
          },
        ],
      });
    }
    if (soql.includes("FROM Contact")) {
      return respond({
        records: [
          {
            Id: "003A",
            FirstName: "Hank",
            LastName: "Scorpio",
            Email: "hank@globex.com",
            AccountId: "001A",
            OwnerId: "005A",
          },
        ],
      });
    }
    if (soql.includes("FROM Opportunity")) {
      return respond({
        records: [
          {
            Id: "006A",
            Name: "Globex Expansion",
            StageName: "Negotiation",
            // Ownerless, amountless: must be kept so audits can flag it.
            Amount: null,
            CloseDate: "2026-08-15",
            Probability: 60,
            IsClosed: false,
            IsWon: false,
            ForecastCategory: "BestCase",
            LastActivityDate: "2026-06-01",
            OwnerId: null,
            AccountId: "001A",
          },
        ],
        nextRecordsUrl: "/query/next-page",
      });
    }
    return new Response("no stub", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("salesforce connector maps a canonical snapshot with cursor pagination", async () => {
  const { fetchImpl, calls } = stubFetch();
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "sf-token", instanceUrl: "https://org.my.salesforce.com" }),
    fetchImpl,
  });

  const snapshot = await connector.fetchSnapshot();

  assert.equal(snapshot.provider, "salesforce");
  assert.equal(snapshot.users.length, 2);
  assert.equal(snapshot.users[0].email, "rae@example.com");
  assert.equal(snapshot.users[1].active, false);
  assert.equal(snapshot.users[1].email, undefined);

  assert.equal(snapshot.accounts[0].annualRevenue, 25_000_000);
  assert.equal(snapshot.accounts[0].ownerId, "005A");
  assert.equal(snapshot.contacts[0].accountId, "001A");

  // Pagination followed nextRecordsUrl; all opportunities present.
  assert.equal(snapshot.deals.length, 3);
  const [ownerless, closedWon, closedLost] = snapshot.deals;
  assert.equal(ownerless.ownerId, undefined);
  assert.equal(ownerless.amount, undefined);
  assert.equal(ownerless.probability, 0.6); // normalized 0..1
  // Open opportunity: ForecastCategory "BestCase" -> "best_case", real activity date.
  assert.equal(ownerless.forecastCategory, "best_case");
  assert.equal(ownerless.lastActivityAt, "2026-06-01");
  assert.equal(closedWon.isWon, true);
  assert.equal(closedWon.amount, 90_000);
  // Won/lost short-circuit the ForecastCategory value.
  assert.equal(closedWon.forecastCategory, "closed_won");
  assert.equal(closedWon.lastActivityAt, "2026-03-15");
  assert.equal(closedLost.forecastCategory, "closed_lost");
  assert.equal(closedLost.isWon, false);
  assert.equal(closedLost.isClosed, true);

  assert.equal(
    calls.every(
      (call) =>
        (call.init?.headers as Record<string, string>).Authorization === "Bearer sf-token" &&
        call.url.startsWith("https://org.my.salesforce.com/"),
    ),
    true,
  );

  // The Opportunity SELECT pulls the native forecast + activity fields.
  const oppCall = calls.find((call) =>
    decodeURIComponent(new URL(call.url).searchParams.get("q") ?? "").includes("FROM Opportunity"),
  );
  assert.ok(oppCall);
  const oppSoql = decodeURIComponent(new URL(oppCall.url).searchParams.get("q") ?? "");
  assert.match(oppSoql, /ForecastCategory/);
  assert.match(oppSoql, /LastActivityDate/);
});

test("salesforce connector applies set_field via PATCH and handles 204 No Content", async () => {
  const { fetchImpl, calls } = stubFetch();
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "sf-token", instanceUrl: "https://org.my.salesforce.com" }),
    fetchImpl,
  });

  const result = await connector.applyOperation({
    id: "op_1",
    objectType: "deal",
    objectId: "006A",
    operation: "set_field",
    field: "nextStep",
    beforeValue: null,
    afterValue: "Security review with IT",
    reason: "test",
    riskLevel: "low",
    approvalRequired: true,
  });

  assert.equal(result.status, "applied");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sobjects\/Opportunity\/006A$/);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    NextStep: "Security review with IT",
  });
});

test("salesforce connector links a deal to an account by setting AccountId", async () => {
  const { fetchImpl, calls } = stubFetch();
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "sf-token", instanceUrl: "https://org.my.salesforce.com" }),
    fetchImpl,
  });

  const result = await connector.applyOperation({
    id: "op_link",
    objectType: "deal",
    objectId: "006A",
    operation: "link_record",
    field: "accountId",
    beforeValue: null,
    afterValue: "001Z",
    reason: "Deal not linked to an account",
    riskLevel: "medium",
    approvalRequired: true,
  });

  assert.equal(result.status, "applied");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "PATCH");
  assert.match(calls[0].url, /sobjects\/Opportunity\/006A$/);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { AccountId: "001Z" });
});

test("salesforce connector creates a Task related to the record", async () => {
  const { fetchImpl, calls } = stubFetch();
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "sf-token", instanceUrl: "https://org.my.salesforce.com" }),
    fetchImpl,
  });

  const result = await connector.applyOperation({
    id: "op_task",
    objectType: "account",
    objectId: "001A",
    operation: "create_task",
    field: "follow_up_task",
    beforeValue: null,
    afterValue: "Research account fit",
    reason: "Orphan account",
    riskLevel: "low",
    approvalRequired: true,
  });

  assert.equal(result.status, "applied");
  // Idempotency pre-check (SOQL) then the create.
  assert.equal(calls.length, 2);
  assert.match(decodeURIComponent(calls[0].url), /FROM Task WHERE Description LIKE/);
  assert.match(calls[1].url, /sobjects\/Task$/);
  const body = JSON.parse(String(calls[1].init?.body));
  assert.equal(body.Subject, "Follow Up");
  assert.match(body.Description, /^Research account fit/);
  assert.match(body.Description, /fsgtm:op_task/);
  assert.equal(body.WhatId, "001A");
  assert.equal(body.Status, "Not Started");
});

test("salesforce connector skips operations it cannot represent", async () => {
  const { fetchImpl, calls } = stubFetch();
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "sf-token", instanceUrl: "https://org.my.salesforce.com" }),
    fetchImpl,
  });

  // A field write on a user has no Salesforce sobject mapping here.
  const result = await connector.applyOperation({
    id: "op_2",
    objectType: "user",
    objectId: "005A",
    operation: "set_field",
    field: "title",
    beforeValue: null,
    afterValue: "VP",
    reason: "test",
    riskLevel: "low",
    approvalRequired: true,
  });

  assert.equal(result.status, "skipped");
  assert.equal(calls.length, 0);
});

function soapStub(opts: { fault?: boolean; reject?: boolean } = {}) {
  const soapCalls: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/services/Soap/")) {
      soapCalls.push({ url, body: String(init?.body ?? "") });
      if (opts.fault) {
        return new Response("<soapenv:Envelope><soapenv:Body><soapenv:Fault><faultstring>INVALID_SESSION_ID</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>", { status: 500 });
      }
      const success = opts.reject ? "false" : "true";
      const extra = opts.reject ? "<errors><message>entity is locked</message></errors>" : "";
      return new Response(`<soapenv:Envelope><soapenv:Body><mergeResponse><result><id>001SURV</id><success>${success}</success>${extra}</result></mergeResponse></soapenv:Body></soapenv:Envelope>`, { status: 200, headers: { "Content-Type": "text/xml" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, soapCalls };
}

function mergeOp(objectType: "account" | "contact" | "deal", group: string[]) {
  return {
    id: "op_m", objectType, objectId: group[0], operation: "merge_records" as const, field: "merge",
    beforeValue: group, afterValue: group[0], reason: "merge dups", riskLevel: "high" as const, approvalRequired: true,
  };
}

test("salesforce SOAP merge: account group merges in batches of 2 (master + 2 per call)", async () => {
  const { fetchImpl, soapCalls } = soapStub();
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "tok", instanceUrl: "https://x.my.salesforce.com" }),
    fetchImpl,
  });
  const result = await connector.applyOperation!(mergeOp("account", ["001SURV", "001L1", "001L2", "001L3"]) as never);
  assert.equal(result.status, "applied");
  assert.deepEqual((result.providerData as { mergedRecordIds: string[] }).mergedRecordIds, ["001L1", "001L2", "001L3"]);
  assert.equal(soapCalls.length, 2);
  assert.match(soapCalls[0].body, /<urn1:type>Account<\/urn1:type>/);
  assert.match(soapCalls[0].body, /<urn1:Id>001SURV<\/urn1:Id>/);
  assert.match(soapCalls[0].body, /<urn:sessionId>tok<\/urn:sessionId>/);
  assert.match(soapCalls[0].body, /<urn:recordToMergeIds>001L1<\/urn:recordToMergeIds>/);
  assert.match(soapCalls[0].url, /\/services\/Soap\/u\/59\.0$/);
});

test("salesforce merge refuses opportunities honestly (no SF opportunity merge exists)", async () => {
  const { fetchImpl, soapCalls } = soapStub();
  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "t", instanceUrl: "https://x.my.salesforce.com" }),
    fetchImpl,
  });
  const result = await connector.applyOperation!(mergeOp("deal", ["006A", "006B"]) as never);
  assert.equal(result.status, "skipped");
  assert.match(result.detail!, /opportunit/i);
  assert.equal(soapCalls.length, 0);
});

test("salesforce merge surfaces a SOAP fault / rejection as failed (not a silent half-merge)", async () => {
  const fault = soapStub({ fault: true });
  const c1 = createSalesforceConnector({ getConnection: () => ({ accessToken: "t", instanceUrl: "https://x.my.salesforce.com" }), fetchImpl: fault.fetchImpl });
  const r1 = await c1.applyOperation!(mergeOp("contact", ["003A", "003B"]) as never);
  assert.equal(r1.status, "failed");
  assert.match(r1.detail!, /INVALID_SESSION_ID/);

  const reject = soapStub({ reject: true });
  const c2 = createSalesforceConnector({ getConnection: () => ({ accessToken: "t", instanceUrl: "https://x.my.salesforce.com" }), fetchImpl: reject.fetchImpl });
  const r2 = await c2.applyOperation!(mergeOp("contact", ["003A", "003B"]) as never);
  assert.equal(r2.status, "failed");
  assert.match(r2.detail!, /entity is locked/);
});
