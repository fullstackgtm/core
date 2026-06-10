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
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sobjects\/Task$/);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.Subject, "Follow Up");
  assert.equal(body.Description, "Research account fit");
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
