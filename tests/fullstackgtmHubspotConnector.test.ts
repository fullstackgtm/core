import assert from "node:assert/strict";
import test from "node:test";
import { createHubspotConnector } from "../src/index.ts";
import type { CreateRecordPayload, PatchOperation } from "../src/types.ts";

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
    "/crm/v4/objects/companies/c1/associations/tasks": { results: [] },
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
  // Idempotency pre-checks (token search, then open-task association lookup)
  // followed by the create.
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/crm\/v3\/objects\/tasks\/search$/);
  assert.match(calls[1].url, /\/crm\/v4\/objects\/companies\/c1\/associations\/tasks/);
  assert.equal(calls[2].init?.method, "POST");
  const body = JSON.parse(String(calls[2].init?.body));
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

test("hubspot connector skips creating a task when the object already has an open task", async () => {
  // Not fsgtm's own task — a human-created follow-up from a prior partial run.
  const { fetchImpl, calls } = stubFetch({
    "/crm/v3/objects/tasks/search": { results: [] },
    "/crm/v4/objects/deals/d1/associations/tasks": { results: [{ toObjectId: 777 }] },
    "/crm/v3/objects/tasks/777": { id: "777", properties: { hs_task_status: "NOT_STARTED" } },
  });
  const connector = createHubspotConnector({ getAccessToken: () => "test-token", fetchImpl });

  const result = await connector.applyOperation!({
    id: "op_task_dupe",
    objectType: "deal",
    objectId: "d1",
    operation: "create_task",
    field: "follow_up_task",
    beforeValue: null,
    afterValue: "Follow up on stale deal",
    reason: "Stale deal",
    riskLevel: "low",
    approvalRequired: true,
  });

  assert.equal(result.status, "skipped");
  assert.match(result.detail ?? "", /open task \(task 777\) already exists/);
  assert.equal(calls.length, 3); // token search, association lookup, task status read
});

test("hubspot connector still creates a task when existing associated tasks are completed", async () => {
  const { fetchImpl, calls } = stubFetch({
    "/crm/v3/objects/tasks/search": { results: [] },
    "/crm/v4/objects/deals/d1/associations/tasks": { results: [{ toObjectId: 778 }] },
    "/crm/v3/objects/tasks/778": { id: "778", properties: { hs_task_status: "COMPLETED" } },
    "/crm/v3/objects/tasks": { id: "task_2" },
  });
  const connector = createHubspotConnector({ getAccessToken: () => "test-token", fetchImpl });

  const result = await connector.applyOperation!({
    id: "op_task_done",
    objectType: "deal",
    objectId: "d1",
    operation: "create_task",
    field: "follow_up_task",
    beforeValue: null,
    afterValue: "Follow up on stale deal",
    reason: "Stale deal",
    riskLevel: "low",
    approvalRequired: true,
  });

  assert.equal(result.status, "applied");
  assert.equal(calls.length, 4); // token search, association lookup, status read, create
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

test("hubspot connector derives closed/won from pipeline stage metadata, not substring (custom pipelines)", async () => {
  // A custom pipeline whose stage ids are opaque numbers — the old substring
  // heuristic would read every one of these as OPEN.
  const customRoutes = {
    "/crm/v3/owners": { results: [] },
    "/crm/v3/objects/companies": { results: [] },
    "/crm/v3/objects/contacts": { results: [] },
    "/crm/v3/pipelines/deals": {
      results: [
        {
          id: "default",
          stages: [
            { id: "1098765", metadata: { isClosed: "true", probability: "1.0" } }, // won
            { id: "1098766", metadata: { isClosed: "true", probability: "0.0" } }, // lost
            { id: "1098760", metadata: { isClosed: "false", probability: "0.4" } }, // open
          ],
        },
      ],
    },
    "/crm/v3/objects/deals": {
      results: [
        { id: "w", properties: { dealname: "Won", dealstage: "1098765", amount: "9" } },
        { id: "l", properties: { dealname: "Lost", dealstage: "1098766", amount: "9" } },
        { id: "o", properties: { dealname: "Open", dealstage: "1098760", amount: "9" } },
      ],
    },
  };
  const { fetchImpl } = stubFetch(customRoutes);
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl });
  const snapshot = await connector.fetchSnapshot();
  const byId = Object.fromEntries(snapshot.deals.map((d) => [d.id, d]));
  assert.equal(byId.w.isClosed, true);
  assert.equal(byId.w.isWon, true);
  assert.equal(byId.w.forecastCategory, "closed_won");
  assert.equal(byId.l.isClosed, true);
  assert.equal(byId.l.isWon, false);
  assert.equal(byId.l.forecastCategory, "closed_lost");
  assert.equal(byId.o.isClosed, false); // opaque open stage no longer mis-read
  assert.equal(byId.o.isWon, false);
  assert.equal(byId.o.forecastCategory, "pipeline");
});

// ---------------------------------------------------------------------------
// create_record for DEALS (the `backfill stripe` write path)

type MethodRoute = { status?: number; body?: unknown };

/** Method-aware stub: routes keyed by "METHOD /path" (create vs list differ). */
function stubMethodFetch(routes: Record<string, MethodRoute>) {
  const calls: StubCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    const route = routes[key];
    if (route === undefined) return new Response(`no stub for ${key}`, { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// Default pipeline has displayOrder 0 but is listed SECOND — picking it
// asserts the lowest-displayOrder sort, not "first element".
const DEAL_PIPELINES = {
  results: [
    {
      id: "renewals",
      label: "Renewals",
      displayOrder: 1,
      stages: [
        { id: "ren_open", metadata: { isClosed: "false", probability: "0.5" } },
        { id: "ren_won", metadata: { isClosed: "true", probability: "1.0" } },
      ],
    },
    {
      id: "default",
      label: "Sales Pipeline",
      displayOrder: 0,
      stages: [
        { id: "appt", metadata: { isClosed: "false", probability: "0.2" } },
        { id: "won1", metadata: { isClosed: "true", probability: "1.0" } },
        { id: "lost1", metadata: { isClosed: "true", probability: "0.0" } },
      ],
    },
  ],
};

function dealCreateOp(payloadOverrides: Partial<CreateRecordPayload> = {}, id = "op_bkf_1"): PatchOperation {
  return {
    id,
    objectType: "deal",
    objectId: "create:stripe:invoice:in_1",
    operation: "create_record",
    beforeValue: null,
    afterValue: {
      properties: { dealname: "Invoice INV-0042 — Globex", amount: "1099.9", closedate: "2026-01-01" },
      matchKey: "stripe_invoice_id",
      matchValue: "in_1",
      source: "stripe:invoices",
      dealStage: "closed_won",
      associateCompanyName: "Globex",
      associateCompanyDomain: "globex.com",
      ...payloadOverrides,
    } satisfies CreateRecordPayload,
    reason: "test",
    riskLevel: "medium",
    approvalRequired: true,
  };
}

const DEAL_CREATE_ROUTES: Record<string, MethodRoute> = {
  "GET /crm/v3/properties/deals/stripe_invoice_id": { body: { name: "stripe_invoice_id" } },
  "POST /crm/v3/objects/deals/search": { body: { results: [] } },
  "GET /crm/v3/pipelines/deals": { body: DEAL_PIPELINES },
  "POST /crm/v3/objects/deals": { body: { id: "d99" } },
  "POST /crm/v3/objects/companies/search": { body: { results: [{ id: "c1" }] } },
  "PUT /crm/v4/objects/deals/d99/associations/default/companies/c1": { body: {} },
};

test("hubspot deal create_record: resolve-first hit is skipped with the existing id", async () => {
  const { fetchImpl, calls } = stubMethodFetch({
    ...DEAL_CREATE_ROUTES,
    "POST /crm/v3/objects/deals/search": { body: { results: [{ id: "d77" }] } },
  });
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl });

  const result = await connector.applyOperation!(dealCreateOp());

  assert.equal(result.status, "skipped");
  assert.match(String(result.detail), /already exists \(d77\)/);
  assert.deepEqual(result.providerData, { id: "d77", existing: true });
  // The search body filtered on the custom dedupe property.
  const search = calls.find((c) => c.url.includes("/objects/deals/search"));
  assert.ok(search);
  assert.match(String(search.init?.body), /"propertyName":"stripe_invoice_id"/);
  assert.match(String(search.init?.body), /"value":"in_1"/);
  // Nothing was created.
  assert.equal(
    calls.some((c) => c.init?.method === "POST" && new URL(c.url).pathname === "/crm/v3/objects/deals"),
    false,
  );
});

test("hubspot deal create_record: confirmed miss creates a closed-won deal in the default pipeline and links the company", async () => {
  const { fetchImpl, calls } = stubMethodFetch(DEAL_CREATE_ROUTES);
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl });

  const result = await connector.applyOperation!(dealCreateOp());

  assert.equal(result.status, "applied");
  assert.match(String(result.detail), /Created deal stripe_invoice_id=in_1 \(d99\)/);
  assert.match(String(result.detail), /Linked to company "Globex" \(globex\.com\) \(c1\)/);
  assert.deepEqual(result.providerData, {
    id: "d99",
    created: true,
    pipelineId: "default",
    stageId: "won1",
  });

  const create = calls.find(
    (c) => c.init?.method === "POST" && new URL(c.url).pathname === "/crm/v3/objects/deals",
  );
  assert.ok(create);
  const body = JSON.parse(String(create.init?.body)) as { properties: Record<string, string> };
  assert.equal(body.properties.dealname, "Invoice INV-0042 — Globex");
  assert.equal(body.properties.amount, "1099.9");
  assert.equal(body.properties.closedate, "2026-01-01");
  // The dedupe key is stamped so the NEXT run's resolve-first finds it.
  assert.equal(body.properties.stripe_invoice_id, "in_1");
  // Pipeline picked by lowest displayOrder; stage from metadata (isClosed +
  // probability 1), never a substring guess.
  assert.equal(body.properties.pipeline, "default");
  assert.equal(body.properties.dealstage, "won1");
  // Provenance stamp (best-effort variant is exercised elsewhere).
  assert.equal(body.properties.hs_object_source_detail_2, "fullstackgtm backfill (op_bkf_1)");

  // Company resolved by DOMAIN first, then associated via v4 default.
  const companySearch = calls.find((c) => c.url.includes("/objects/companies/search"));
  assert.ok(companySearch);
  assert.match(String(companySearch.init?.body), /"propertyName":"domain"/);
  const assoc = calls.find((c) => c.init?.method === "PUT");
  assert.ok(assoc);
  assert.match(assoc.url, /\/crm\/v4\/objects\/deals\/d99\/associations\/default\/companies\/c1$/);
});

test("hubspot deal create_record: dealPipeline hint matches a pipeline label case-insensitively", async () => {
  const { fetchImpl, calls } = stubMethodFetch(DEAL_CREATE_ROUTES);
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl });

  const result = await connector.applyOperation!(
    dealCreateOp({ dealPipeline: "ReNeWaLs", associateCompanyName: undefined, associateCompanyDomain: undefined }),
  );

  assert.equal(result.status, "applied");
  const create = calls.find(
    (c) => c.init?.method === "POST" && new URL(c.url).pathname === "/crm/v3/objects/deals",
  );
  const body = JSON.parse(String(create!.init?.body)) as { properties: Record<string, string> };
  assert.equal(body.properties.pipeline, "renewals");
  assert.equal(body.properties.dealstage, "ren_won");
});

test("hubspot deal create_record: an explicit pipeline hint that matches nothing is skipped, not defaulted", async () => {
  const { fetchImpl, calls } = stubMethodFetch(DEAL_CREATE_ROUTES);
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl });

  const result = await connector.applyOperation!(dealCreateOp({ dealPipeline: "nope" }));

  assert.equal(result.status, "skipped");
  assert.match(String(result.detail), /Could not resolve pipeline "nope"/);
  assert.equal(
    calls.some((c) => c.init?.method === "POST" && new URL(c.url).pathname === "/crm/v3/objects/deals"),
    false,
  );
});

test("hubspot deal create_record: no resolvable closed-won stage is skipped, never guessed", async () => {
  const { fetchImpl, calls } = stubMethodFetch({
    ...DEAL_CREATE_ROUTES,
    "GET /crm/v3/pipelines/deals": {
      body: {
        results: [
          {
            id: "default",
            label: "Sales Pipeline",
            displayOrder: 0,
            // isClosed stages exist but none carries probability 1.
            stages: [
              { id: "open1", metadata: { isClosed: "false", probability: "0.2" } },
              { id: "lost1", metadata: { isClosed: "true", probability: "0.0" } },
            ],
          },
        ],
      },
    },
  });
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl });

  const result = await connector.applyOperation!(dealCreateOp());

  assert.equal(result.status, "skipped");
  assert.match(String(result.detail), /closed-won stage/);
  assert.equal(
    calls.some((c) => c.init?.method === "POST" && new URL(c.url).pathname === "/crm/v3/objects/deals"),
    false,
  );
});

test("hubspot deal create_record: missing custom dedupe property is created, then the deal lands", async () => {
  const { fetchImpl, calls } = stubMethodFetch({
    ...DEAL_CREATE_ROUTES,
    "GET /crm/v3/properties/deals/stripe_invoice_id": { status: 404, body: { message: "missing" } },
    "POST /crm/v3/properties/deals": { body: { name: "stripe_invoice_id" } },
  });
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl });

  const result = await connector.applyOperation!(dealCreateOp());

  assert.equal(result.status, "applied");
  const propertyCreate = calls.find(
    (c) => c.init?.method === "POST" && new URL(c.url).pathname === "/crm/v3/properties/deals",
  );
  assert.ok(propertyCreate, "the dedupe property was created before the deal");
  const body = JSON.parse(String(propertyCreate.init?.body));
  assert.deepEqual(body, {
    name: "stripe_invoice_id",
    label: "stripe_invoice_id",
    type: "string",
    fieldType: "text",
    groupName: "dealinformation",
    hasUniqueValue: false,
  });
});

test("hubspot deal create_record: unensurable dedupe property is skipped — never create without the dedupe key", async () => {
  const { fetchImpl, calls } = stubMethodFetch({
    ...DEAL_CREATE_ROUTES,
    "GET /crm/v3/properties/deals/stripe_invoice_id": { status: 404, body: {} },
    "POST /crm/v3/properties/deals": { status: 403, body: {} },
  });
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl });

  const result = await connector.applyOperation!(dealCreateOp());

  assert.equal(result.status, "skipped");
  assert.match(String(result.detail), /could not be created/);
  assert.match(String(result.detail), /refusing to create a deal without its dedupe key/);
  // No search, no create — the property is a precondition for both.
  assert.equal(
    calls.some((c) => new URL(c.url).pathname === "/crm/v3/objects/deals"),
    false,
  );
});

test("hubspot deal create_record: same-run duplicate is skipped from the in-run cache without another search", async () => {
  const { fetchImpl, calls } = stubMethodFetch(DEAL_CREATE_ROUTES);
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl });

  const first = await connector.applyOperation!(dealCreateOp());
  assert.equal(first.status, "applied");
  const searchesAfterFirst = calls.filter((c) => c.url.includes("/objects/deals/search")).length;

  const second = await connector.applyOperation!(dealCreateOp({}, "op_bkf_replay"));
  assert.equal(second.status, "skipped");
  assert.match(String(second.detail), /already created earlier in this run/);
  assert.deepEqual(second.providerData, { id: "d99", existing: true });
  assert.equal(
    calls.filter((c) => c.url.includes("/objects/deals/search")).length,
    searchesAfterFirst,
    "the cache answered; no second search",
  );
  assert.equal(
    calls.filter((c) => c.init?.method === "POST" && new URL(c.url).pathname === "/crm/v3/objects/deals").length,
    1,
  );
});

test("hubspot deal create_record: missing dealStage sentinel is skipped (only closed_won is understood)", async () => {
  const { fetchImpl, calls } = stubMethodFetch(DEAL_CREATE_ROUTES);
  const connector = createHubspotConnector({ getAccessToken: () => "t", fetchImpl });

  const result = await connector.applyOperation!(dealCreateOp({ dealStage: undefined }));

  assert.equal(result.status, "skipped");
  assert.match(String(result.detail), /dealStage "closed_won"/);
  assert.equal(
    calls.some((c) => c.init?.method === "POST" && new URL(c.url).pathname === "/crm/v3/objects/deals"),
    false,
  );
});
