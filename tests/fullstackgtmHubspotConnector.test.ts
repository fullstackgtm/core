import assert from "node:assert/strict";
import test from "node:test";
import { createHubspotConnector } from "../src/index.ts";

type StubCall = { url: string; init?: RequestInit };

function stubFetch(routes: Record<string, unknown>) {
  const calls: StubCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const body = routes[path];
    if (body === undefined) {
      return new Response(`no stub for ${path}`, { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const routes = {
  "/crm/v3/owners": {
    results: [
      { id: "9001", email: "rep@example.com", firstName: "Rae", lastName: "Park" },
    ],
  },
  "/crm/v3/objects/companies": {
    results: [
      {
        id: "c1",
        updatedAt: "2026-05-01T00:00:00Z",
        properties: {
          name: "Acme",
          domain: "acme.com",
          numberofemployees: "250",
          annualrevenue: "5000000",
          hubspot_owner_id: "9001",
        },
      },
    ],
  },
  "/crm/v3/objects/contacts": {
    results: [
      {
        id: "p1",
        properties: { firstname: "Ada", lastname: "Lovelace", email: "ada@acme.com" },
        associations: { companies: { results: [{ id: "c1" }] } },
      },
    ],
  },
  "/crm/v3/objects/deals": {
    results: [
      {
        id: "d1",
        properties: {
          dealname: "Acme Expansion",
          amount: "12000",
          dealstage: "presentation",
          closedate: "2026-07-01T00:00:00Z",
          hs_last_sales_activity_timestamp: "2026-05-20T12:30:00Z",
          hubspot_owner_id: "9001",
        },
        associations: { companies: { results: [{ id: "c1" }] } },
      },
      {
        // Ownerless and amountless deal: the connector must keep it so the
        // audit can flag it, rather than silently dropping it like a sync.
        id: "d2",
        properties: { dealname: "Mystery Deal", dealstage: "closedwon" },
      },
    ],
  },
};

test("hubspot connector maps a full canonical snapshot without dropping records", async () => {
  const { fetchImpl, calls } = stubFetch(routes);
  const connector = createHubspotConnector({
    getAccessToken: () => "test-token",
    fetchImpl,
  });

  const snapshot = await connector.fetchSnapshot();

  assert.equal(snapshot.provider, "hubspot");
  assert.equal(snapshot.users.length, 1);
  assert.deepEqual(snapshot.users[0], {
    id: "9001",
    provider: "hubspot",
    crmId: "9001",
    identities: [{ provider: "hubspot", externalId: "9001" }],
    name: "Rae Park",
    email: "rep@example.com",
    active: true,
  });

  assert.equal(snapshot.accounts.length, 1);
  assert.equal(snapshot.accounts[0].employeeCount, 250);
  assert.equal(snapshot.accounts[0].annualRevenue, 5_000_000);
  assert.equal(snapshot.accounts[0].ownerId, "9001");

  assert.equal(snapshot.contacts.length, 1);
  assert.equal(snapshot.contacts[0].accountId, "c1");

  assert.equal(snapshot.deals.length, 2);
  const [withOwner, ownerless] = snapshot.deals;
  assert.equal(withOwner.ownerId, "9001");
  assert.equal(withOwner.amount, 12_000);
  assert.equal(withOwner.closeDate, "2026-07-01");
  assert.equal(withOwner.isClosed, false);
  // lastActivityAt comes from hs_last_sales_activity_timestamp (date portion).
  assert.equal(withOwner.lastActivityAt, "2026-05-20");
  // Open deal -> "pipeline" forecast category.
  assert.equal(withOwner.forecastCategory, "pipeline");
  assert.equal(ownerless.ownerId, undefined);
  assert.equal(ownerless.amount, undefined);
  assert.equal(ownerless.isClosed, true);
  assert.equal(ownerless.isWon, true);
  assert.equal(ownerless.forecastCategory, "closed_won");

  assert.equal(
    calls.every((call) =>
      (call.init?.headers as Record<string, string>).Authorization === "Bearer test-token",
    ),
    true,
  );

  // The deal list request fetches the activity-timestamp property.
  const dealCall = calls.find((call) => call.url.includes("/objects/deals"));
  assert.ok(dealCall);
  assert.match(decodeURIComponent(dealCall.url), /hs_last_sales_activity_timestamp/);
});

test("hubspot deal mapping derives forecastCategory from stage and passes through epoch lastActivityAt", async () => {
  const { fetchImpl } = stubFetch({
    "/crm/v3/owners": { results: [] },
    "/crm/v3/objects/companies": { results: [] },
    "/crm/v3/objects/contacts": { results: [] },
    "/crm/v3/objects/deals": {
      results: [
        {
          id: "won",
          properties: { dealname: "Won", dealstage: "closedwon" },
        },
        {
          id: "lost",
          properties: { dealname: "Lost", dealstage: "closedlost" },
        },
        {
          // Non-ISO (epoch millis) activity timestamp is passed through verbatim.
          id: "open",
          properties: {
            dealname: "Open",
            dealstage: "qualifiedtobuy",
            hs_last_sales_activity_timestamp: "1747744200000",
          },
        },
      ],
    },
  });
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl });
  const snapshot = await connector.fetchSnapshot();

  const byId = Object.fromEntries(snapshot.deals.map((deal) => [deal.id, deal]));
  assert.equal(byId.won.forecastCategory, "closed_won");
  assert.equal(byId.lost.forecastCategory, "closed_lost");
  assert.equal(byId.open.forecastCategory, "pipeline");
  assert.equal(byId.open.lastActivityAt, "1747744200000");
  assert.equal(byId.won.lastActivityAt, undefined);

  // The deal property request includes the activity-timestamp property.
  // (verified indirectly: mapping default added to HUBSPOT_DEFAULT_FIELD_MAPPINGS)
});

test("hubspot connector applies set_field through a mapped PATCH", async () => {
  const { fetchImpl, calls } = stubFetch({
    "/crm/v3/objects/deals/d1": { id: "d1" },
  });
  const connector = createHubspotConnector({
    getAccessToken: () => "test-token",
    fetchImpl,
  });

  const result = await connector.applyOperation!({
    id: "op_1",
    objectType: "deal",
    objectId: "d1",
    operation: "set_field",
    field: "nextStep",
    beforeValue: null,
    afterValue: "Schedule security review",
    reason: "test",
    riskLevel: "low",
    approvalRequired: true,
  });

  assert.equal(result.status, "applied");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    properties: { hs_next_step: "Schedule security review" },
  });
});

test("hubspot connector creates a task associated with the target object", async () => {
  const { fetchImpl, calls } = stubFetch({
    "/crm/v3/objects/tasks/search": { results: [] },
    "/crm/v3/objects/tasks": { id: "task_1" },
  });
  const connector = createHubspotConnector({ getAccessToken: () => "test-token", fetchImpl });

  const result = await connector.applyOperation!({
    id: "op_task",
    objectType: "account",
    objectId: "c1",
    operation: "create_task",
    field: "follow_up_task",
    beforeValue: null,
    afterValue: "Research account fit",
    reason: "Orphan account",
    riskLevel: "low",
    approvalRequired: true,
  });

  assert.equal(result.status, "applied");
  // Idempotency pre-check (search) then the create.
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/crm\/v3\/objects\/tasks\/search$/);
  assert.equal(calls[1].init?.method, "POST");
  const body = JSON.parse(String(calls[1].init?.body));
  assert.equal(body.properties.hs_task_subject, "Follow Up");
  assert.match(body.properties.hs_task_body, /^Research account fit/);
  assert.match(body.properties.hs_task_body, /fsgtm task/);
  assert.equal(body.properties.hs_task_status, "NOT_STARTED");
  // Associated to the company with HubSpot's defined task→company type id.
  assert.equal(body.associations[0].to.id, "c1");
  assert.equal(body.associations[0].types[0].associationTypeId, 192);
});

test("hubspot connector skips creating a task that already exists for the operation", async () => {
  const { fetchImpl, calls } = stubFetch({
    "/crm/v3/objects/tasks/search": { results: [{ id: "task_existing" }] },
  });
  const connector = createHubspotConnector({ getAccessToken: () => "test-token", fetchImpl });

  const result = await connector.applyOperation!({
    id: "op_task",
    objectType: "account",
    objectId: "c1",
    operation: "create_task",
    field: "follow_up_task",
    beforeValue: null,
    afterValue: "Research account fit",
    reason: "Orphan account",
    riskLevel: "low",
    approvalRequired: true,
  });

  assert.equal(result.status, "skipped");
  assert.match(result.detail ?? "", /already exists \(task task_existing\)/);
  assert.equal(calls.length, 1);
});

test("hubspot connector links a deal to a company via the associations API", async () => {
  const { fetchImpl, calls } = stubFetch({
    "/crm/v4/objects/deals/d1/associations/default/companies/c9": {},
  });
  const connector = createHubspotConnector({ getAccessToken: () => "test-token", fetchImpl });

  const result = await connector.applyOperation!({
    id: "op_link",
    objectType: "deal",
    objectId: "d1",
    operation: "link_record",
    field: "accountId",
    beforeValue: null,
    afterValue: "c9",
    reason: "Deal not linked to an account",
    riskLevel: "medium",
    approvalRequired: true,
  });

  assert.equal(result.status, "applied");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "PUT");
  assert.match(calls[0].url, /associations\/default\/companies\/c9$/);
});

test("hubspot connector archives a record via DELETE", async () => {
  const { fetchImpl, calls } = stubFetch({
    "/crm/v3/objects/companies/c1": {},
  });
  const connector = createHubspotConnector({ getAccessToken: () => "test-token", fetchImpl });

  const result = await connector.applyOperation!({
    id: "op_archive",
    objectType: "account",
    objectId: "c1",
    operation: "archive_record",
    beforeValue: null,
    afterValue: null,
    reason: "test",
    riskLevel: "high",
    approvalRequired: true,
  });

  assert.equal(result.status, "applied");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "DELETE");
});

test("hubspot connector skips operations it genuinely cannot represent", async () => {
  const { fetchImpl, calls } = stubFetch({});
  const connector = createHubspotConnector({ getAccessToken: () => "test-token", fetchImpl });

  // A task on a user has no HubSpot parent object — skipped, never written.
  const result = await connector.applyOperation!({
    id: "op_skip",
    objectType: "user",
    objectId: "u1",
    operation: "create_task",
    field: "follow_up_task",
    beforeValue: null,
    afterValue: "x",
    reason: "test",
    riskLevel: "low",
    approvalRequired: true,
  });

  assert.equal(result.status, "skipped");
  assert.equal(calls.length, 0);
});
