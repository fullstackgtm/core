import assert from "node:assert/strict";
import test from "node:test";
// createStripeConnector is not exported from the package index yet, so import
// it from the module directly.
import { createStripeConnector } from "../src/connectors/stripe.ts";
import { mergeSnapshots, type CanonicalGtmSnapshot } from "../src/index.ts";

type StubCall = { url: string; init?: RequestInit };

function stubFetch() {
  const calls: StubCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    const respond = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if (url.includes("/v1/customers")) {
      if (url.includes("starting_after=cus_2")) {
        // Second customers page, reached via has_more pagination.
        return respond({
          data: [{ id: "cus_3", name: null, email: "ops@Initech.com" }],
          has_more: false,
        });
      }
      return respond({
        data: [
          { id: "cus_1", name: "Globex Billing", email: "hank@globex.com" },
          // No email: must still become an account, but no contact, no domain.
          { id: "cus_2", name: null, email: null },
        ],
        has_more: true,
      });
    }
    if (url.includes("/v1/subscriptions")) {
      return respond({
        data: [
          {
            id: "sub_1",
            customer: "cus_1",
            status: "active",
            start_date: 1767225600, // 2026-01-01T00:00:00Z
            items: {
              data: [
                {
                  quantity: 2,
                  price: { id: "price_pro", nickname: "Pro Plan", unit_amount: 5000, currency: "usd" },
                },
                // No quantity: defaults to 1.
                { price: { id: "price_addon", nickname: null, unit_amount: 990, currency: "usd" } },
              ],
            },
          },
          {
            id: "sub_2",
            customer: "cus_3",
            status: "canceled",
            start_date: null,
            items: {
              data: [{ quantity: 1, price: { id: "price_basic", nickname: null, unit_amount: 1500, currency: "eur" } }],
            },
          },
        ],
        has_more: false,
      });
    }
    return new Response("no stub", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeConnector() {
  const { fetchImpl, calls } = stubFetch();
  const connector = createStripeConnector({ getApiKey: () => "sk_test_123", fetchImpl });
  return { connector, calls };
}

test("stripe connector maps customers and subscriptions with has_more pagination", async () => {
  const { connector, calls } = makeConnector();

  const snapshot = await connector.fetchSnapshot();

  assert.equal(snapshot.provider, "stripe");
  assert.deepEqual(snapshot.users, []);
  assert.deepEqual(snapshot.activities, []);

  // Pagination followed has_more with starting_after=<last id>.
  const customerCalls = calls.filter((call) => call.url.includes("/v1/customers"));
  assert.equal(customerCalls.length, 2);
  assert.match(customerCalls[1].url, /starting_after=cus_2/);
  assert.equal(snapshot.accounts.length, 3);

  const [globex, noEmail, initech] = snapshot.accounts;
  assert.equal(globex.id, "cus_1");
  assert.equal(globex.name, "Globex Billing");
  assert.equal(globex.domain, "globex.com");
  assert.deepEqual(globex.identities, [{ provider: "stripe", externalId: "cus_1" }]);
  assert.equal(noEmail.name, "Customer cus_2");
  assert.equal(initech.name, "ops@Initech.com"); // falls back to email
  assert.equal(initech.domain, "initech.com"); // domain lowercased

  // One contact per customer with an email.
  assert.equal(snapshot.contacts.length, 2);
  assert.equal(snapshot.contacts[0].id, "cus_1_contact");
  assert.equal(snapshot.contacts[0].accountId, "cus_1");
  assert.equal(snapshot.contacts[0].email, "hank@globex.com");
  assert.equal(snapshot.contacts[0].firstName, undefined);
  assert.equal(snapshot.contacts[0].lastName, undefined);

  assert.equal(snapshot.deals.length, 2);
  const [active, canceled] = snapshot.deals;
  assert.equal(active.name, "Subscription Pro Plan");
  assert.equal(active.accountId, "cus_1");
  // (5000 * 2 + 990 * 1) cents = 109.90 major units.
  assert.equal(active.amount, 109.9);
  assert.equal(active.currency, "USD");
  assert.equal(active.stage, "active");
  assert.equal(active.isClosed, true);
  assert.equal(active.isWon, true);
  assert.equal(active.closeDate, "2026-01-01");

  assert.equal(canceled.name, "Subscription price_basic"); // nickname missing -> price id
  assert.equal(canceled.amount, 15);
  assert.equal(canceled.currency, "EUR");
  assert.equal(canceled.isClosed, true);
  assert.equal(canceled.isWon, false);
  assert.equal(canceled.closeDate, undefined);

  assert.equal(
    calls.every(
      (call) =>
        (call.init?.headers as Record<string, string>).Authorization === "Bearer sk_test_123" &&
        call.url.startsWith("https://api.stripe.com/"),
    ),
    true,
  );
});

test("stripe customer without email yields an account but no contact and no domain", async () => {
  const { connector } = makeConnector();

  const snapshot = await connector.fetchSnapshot();
  const account = snapshot.accounts.find((candidate) => candidate.id === "cus_2");

  assert.ok(account);
  assert.equal(account.domain, undefined);
  assert.equal(
    snapshot.contacts.some((contact) => contact.accountId === "cus_2"),
    false,
  );
});

test("stripe connector skips every operation without calling the API", async () => {
  const { connector, calls } = makeConnector();

  const result = await connector.applyOperation!({
    id: "op_1",
    objectType: "deal",
    objectId: "sub_1",
    operation: "set_field",
    field: "stage",
    beforeValue: "active",
    afterValue: "canceled",
    reason: "test",
    riskLevel: "low",
    approvalRequired: true,
  });

  assert.deepEqual(result, {
    operationId: "op_1",
    status: "skipped",
    detail: "The stripe connector is read-only.",
  });
  assert.equal(calls.length, 0);
});

test("stripe fetchChanges sends created[gte] in unix seconds on list calls", async () => {
  const { fetchImpl, calls } = stubFetch();
  const connector = createStripeConnector({ getApiKey: () => "sk_test_123", fetchImpl });

  // 2026-01-01T00:00:00.000Z -> 1767225600 unix seconds.
  const since = "2026-01-01T00:00:00.000Z";
  const expectedGte = Math.floor(Date.parse(since) / 1000);
  assert.equal(expectedGte, 1767225600);

  const snapshot = await connector.fetchChanges!(since);
  assert.equal(snapshot.provider, "stripe");

  const customerCalls = calls.filter((call) => call.url.includes("/v1/customers"));
  const subscriptionCalls = calls.filter((call) => call.url.includes("/v1/subscriptions"));
  assert.ok(customerCalls.length >= 1);
  assert.ok(subscriptionCalls.length >= 1);

  // created[gte] is URL-encoded as created%5Bgte%5D; assert on the decoded form.
  for (const call of [...customerCalls, ...subscriptionCalls]) {
    const decoded = decodeURIComponent(call.url);
    assert.ok(
      decoded.includes(`created[gte]=${expectedGte}`),
      `expected created[gte]=${expectedGte} in ${decoded}`,
    );
  }
});

test("stripe fetchChanges rejects an invalid timestamp before any network call", async () => {
  const fetchBomb = (async () => {
    throw new Error("must not be called");
  }) as unknown as typeof fetch;
  const connector = createStripeConnector({ getApiKey: () => "sk_test_123", fetchImpl: fetchBomb });

  await assert.rejects(connector.fetchChanges!("not-a-date"), /Invalid since timestamp/);
});

test("stripe fetchSnapshot does not send a created filter", async () => {
  const { connector, calls } = makeConnector();
  await connector.fetchSnapshot();
  assert.equal(
    calls.every((call) => !call.url.includes("created")),
    true,
  );
});

test("stripe snapshot merges with a CRM snapshot by account domain", async () => {
  const { connector } = makeConnector();
  const stripeSnapshot = await connector.fetchSnapshot();

  const hubspotSnapshot: CanonicalGtmSnapshot = {
    generatedAt: "2026-06-09T00:00:00.000Z",
    provider: "hubspot",
    users: [],
    accounts: [
      {
        id: "1001",
        provider: "hubspot",
        crmId: "1001",
        identities: [{ provider: "hubspot", externalId: "1001" }],
        name: "Globex",
        domain: "globex.com",
      },
    ],
    contacts: [],
    deals: [],
    activities: [],
  };

  const { snapshot: merged, report } = mergeSnapshots([hubspotSnapshot, stripeSnapshot]);

  // hubspot:1001 absorbed stripe:cus_1; cus_2 and cus_3 stay separate.
  assert.equal(merged.accounts.length, 3);
  const globex = merged.accounts.find((account) => account.id === "hubspot:1001");
  assert.ok(globex);
  assert.equal(globex.identities?.length, 2);
  assert.deepEqual(globex.identities, [
    { provider: "hubspot", externalId: "1001" },
    { provider: "stripe", externalId: "cus_1" },
  ]);
  assert.equal(
    report.matches.some(
      (match) => match.type === "account" && match.matchedBy === "domain",
    ),
    true,
  );
  // The stripe subscription deal re-points at the merged account.
  const dealForGlobex = merged.deals.find((deal) => deal.id === "stripe:sub_1");
  assert.equal(dealForGlobex?.accountId, "hubspot:1001");
});
