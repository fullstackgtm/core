import assert from "node:assert/strict";
import test from "node:test";
import {
  createHubspotConnector,
  createSalesforceConnector,
} from "../src/index.ts";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("hubspot fetchChanges uses the search API with modified-date filters and paging", async () => {
  const searches: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/owners")) return jsonResponse({ results: [] });
    assert.match(url, /\/search$/);
    const body = JSON.parse(String(init?.body));
    searches.push({ url, body });
    if (url.includes("/deals/search") && !body.after) {
      return jsonResponse({
        results: [{ id: "d1", properties: { dealname: "Changed Deal", amount: "100" } }],
        paging: { next: { after: "page2" } },
      });
    }
    if (url.includes("/deals/search")) {
      return jsonResponse({
        results: [{ id: "d2", properties: { dealname: "Changed Deal 2", amount: "200" } }],
      });
    }
    return jsonResponse({ results: [] });
  }) as typeof fetch;

  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl });
  const since = "2026-06-08T00:00:00.000Z";
  const changes = await connector.fetchChanges!(since);

  assert.equal(changes.deals.length, 2);
  assert.deepEqual(
    changes.deals.map((deal) => deal.id),
    ["d1", "d2"],
  );

  const dealSearches = searches.filter((entry) => entry.url.includes("/deals/search"));
  assert.equal(dealSearches.length, 2);
  const filter = dealSearches[0].body.filterGroups[0].filters[0];
  assert.equal(filter.propertyName, "hs_lastmodifieddate");
  assert.equal(filter.operator, "GTE");
  assert.equal(filter.value, String(Date.parse(since)));
  assert.equal(dealSearches[1].body.after, "page2");

  const contactSearch = searches.find((entry) => entry.url.includes("/contacts/search"));
  assert.equal(
    contactSearch?.body.filterGroups[0].filters[0].propertyName,
    "lastmodifieddate",
  );
});

test("salesforce fetchChanges filters every SOQL query on SystemModstamp", async () => {
  const queries: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const soql = decodeURIComponent(new URL(String(input)).searchParams.get("q") ?? "");
    queries.push(soql);
    if (soql.includes("FROM Opportunity")) {
      return jsonResponse({
        records: [{ Id: "006A", Name: "Changed Opp", Amount: 5000, IsClosed: false }],
      });
    }
    return jsonResponse({ records: [] });
  }) as typeof fetch;

  const connector = createSalesforceConnector({
    getConnection: () => ({ accessToken: "t", instanceUrl: "https://org.my.salesforce.com" }),
    fetchImpl,
  });
  const changes = await connector.fetchChanges!("2026-06-08T00:00:00.000Z");

  assert.equal(changes.deals.length, 1);
  assert.equal(queries.length, 4);
  assert.ok(
    queries.every((soql) => soql.includes("WHERE SystemModstamp >= 2026-06-08T00:00:00.000Z")),
  );
});

test("fetchChanges rejects unparseable timestamps before any network call", async () => {
  const fetchBomb = (async () => {
    throw new Error("must not be called");
  }) as unknown as typeof fetch;

  const hubspot = createHubspotConnector({ getAccessToken: () => "t", fetchImpl: fetchBomb });
  await assert.rejects(hubspot.fetchChanges!("not-a-date"), /Invalid since timestamp/);

  const salesforce = createSalesforceConnector({
    getConnection: () => ({ accessToken: "t", instanceUrl: "https://x" }),
    fetchImpl: fetchBomb,
  });
  await assert.rejects(salesforce.fetchChanges!("not-a-date"), /Invalid since timestamp/);
});
