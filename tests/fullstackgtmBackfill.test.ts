import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildStripeBackfillPlan } from "../src/backfill.ts";
import type { StripePaidInvoice } from "../src/connectors/stripe.ts";
import type { CanonicalGtmSnapshot, CreateRecordPayload } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures

function invoice(overrides: Partial<StripePaidInvoice> = {}): StripePaidInvoice {
  return {
    id: "in_1",
    number: "INV-0042",
    customerId: "cus_1",
    customerName: "Globex Billing",
    customerEmail: "hank@globex.com",
    customerDomain: "globex.com",
    amountPaid: 1099.9,
    currency: "USD",
    paidAt: "2026-01-01",
    ...overrides,
  };
}

function crmSnapshot(): CanonicalGtmSnapshot {
  return {
    generatedAt: "2026-07-01T00:00:00.000Z",
    provider: "hubspot",
    users: [],
    accounts: [
      {
        id: "a1",
        provider: "hubspot",
        crmId: "a1",
        identities: [{ provider: "hubspot", externalId: "a1" }],
        name: "Globex",
        // The snapshot's domain is messier than the invoice's — normalizeDomain
        // must collapse both sides before comparing.
        domain: "https://www.globex.com/",
      },
      {
        id: "a2",
        provider: "hubspot",
        crmId: "a2",
        identities: [{ provider: "hubspot", externalId: "a2" }],
        name: "Initech",
        // No domain — reachable only by exact name match.
      },
    ],
    contacts: [],
    deals: [
      {
        id: "d1",
        provider: "hubspot",
        crmId: "d1",
        identities: [{ provider: "hubspot", externalId: "d1" }],
        name: "Invoice INV-0007 — Globex Billing",
        isClosed: true,
        isWon: true,
      },
    ],
    activities: [],
  };
}

const NOW = () => new Date("2026-07-02T00:00:00.000Z");

// ---------------------------------------------------------------------------
// buildStripeBackfillPlan: matching

test("backfill: domain-matched invoice becomes one closed-won create_record deal op", () => {
  const result = buildStripeBackfillPlan([invoice()], crmSnapshot(), { now: NOW });

  assert.equal(result.counts.planned, 1);
  assert.equal(result.counts.unmatched, 0);
  assert.equal(result.plan.operations.length, 1);
  assert.match(result.plan.id, /^patch_plan_backfill_[0-9a-f]{8}$/);
  assert.equal(result.plan.status, "needs_approval");
  assert.equal(result.plan.dryRun, true);

  const op = result.plan.operations[0];
  assert.equal(op.operation, "create_record");
  assert.equal(op.objectType, "deal");
  assert.equal(op.objectId, "create:stripe:invoice:in_1");
  assert.equal(op.beforeValue, null);
  assert.equal(op.riskLevel, "medium");
  assert.equal(op.approvalRequired, true);
  assert.equal(op.rollback, "Archive the created deal (it was net-new).");
  assert.equal(op.sourceRuleOrPolicy, "backfill:stripe:invoices");
  assert.match(op.reason, /Paid Stripe invoice INV-0042/);
  assert.match(op.reason, /1099\.9 USD/);
  assert.match(op.reason, /paid 2026-01-01/);
  assert.match(op.reason, /closed-won/);

  const payload = op.afterValue as CreateRecordPayload;
  assert.equal(payload.matchKey, "stripe_invoice_id"); // the default
  assert.equal(payload.matchValue, "in_1");
  assert.equal(payload.source, "stripe:invoices");
  assert.equal(payload.dealStage, "closed_won");
  assert.equal(payload.dealPipeline, undefined);
  assert.equal(payload.properties.dealname, "Invoice INV-0042 — Globex Billing");
  assert.equal(payload.properties.amount, "1099.9");
  assert.equal(payload.properties.closedate, "2026-01-01");
  // The association prefers the ACCOUNT's own name + normalized domain.
  assert.equal(payload.associateCompanyName, "Globex");
  assert.equal(payload.associateCompanyDomain, "globex.com");

  // Evidence carries the invoice id/amount/date and is linked from the op.
  assert.equal(result.plan.evidence?.length, 1);
  const evidence = result.plan.evidence![0];
  assert.deepEqual(op.evidenceIds, [evidence.id]);
  assert.equal(evidence.sourceObjectId, "in_1");
  assert.match(evidence.text, /1099\.9 USD paid on 2026-01-01/);
  assert.equal(evidence.metadata?.amountPaid, 1099.9);
});

test("backfill: customer with no email domain falls back to exact case-insensitive name match", () => {
  const result = buildStripeBackfillPlan(
    [invoice({ id: "in_9", number: undefined, customerName: "  INITECH ", customerDomain: undefined, customerEmail: undefined })],
    crmSnapshot(),
    { now: NOW },
  );
  assert.equal(result.counts.planned, 1);
  const payload = result.plan.operations[0].afterValue as CreateRecordPayload;
  assert.equal(payload.associateCompanyName, "Initech");
  assert.equal(payload.associateCompanyDomain, undefined); // the account has none
  // number missing → the invoice id names the deal.
  assert.match(payload.properties.dealname, /^Invoice in_9 — /);
});

test("backfill: unmatched customer gets a proposed account op + deal op in the same plan (default)", () => {
  const result = buildStripeBackfillPlan(
    [
      invoice(),
      invoice({ id: "in_2", number: "INV-0050", customerId: "cus_2", customerName: "Stranger LLC", customerDomain: "stranger.io", amountPaid: 42, currency: "EUR", paidAt: "2026-03-01" }),
    ],
    crmSnapshot(),
    { now: NOW },
  );

  assert.equal(result.counts.planned, 2);
  assert.equal(result.counts.accountsProposed, 1);
  assert.equal(result.counts.unmatched, 0);
  assert.equal(result.unmatched.length, 0);
  assert.equal(result.plan.operations.length, 3);
  assert.deepEqual(result.proposedAccounts, [
    { name: "Stranger LLC", domain: "stranger.io", invoiceCount: 1 },
  ]);

  const accountOp = result.plan.operations.find((op) => op.objectType === "account")!;
  assert.equal(accountOp.operation, "create_record");
  assert.equal(accountOp.objectId, "create:stripe:customer:cus_2");
  assert.equal(accountOp.approvalRequired, true);
  assert.equal(accountOp.rollback, "Archive the created company (it was net-new).");
  const accountPayload = accountOp.afterValue as CreateRecordPayload;
  assert.equal(accountPayload.matchKey, "name");
  assert.equal(accountPayload.matchValue, "Stranger LLC");
  assert.equal(accountPayload.properties.name, "Stranger LLC");
  assert.equal(accountPayload.properties.domain, "stranger.io");

  // The deal op lands on the proposed account and says so.
  const dealOp = result.plan.operations.find(
    (op) => op.objectType === "deal" && (op.afterValue as CreateRecordPayload).matchValue === "in_2",
  )!;
  const dealPayload = dealOp.afterValue as CreateRecordPayload;
  assert.equal(dealPayload.associateCompanyName, "Stranger LLC");
  assert.equal(dealPayload.associateCompanyDomain, "stranger.io");
  assert.match(dealOp.reason, /NEW account "Stranger LLC" \(created by this plan\)/);

  assert.match(result.plan.summary, /1 new account\(s\) proposed/);
});

test("backfill: one account op per new customer even across several invoices", () => {
  const result = buildStripeBackfillPlan(
    [
      invoice({ id: "in_2", number: "INV-0050", customerId: "cus_2", customerName: "Stranger LLC", customerDomain: "stranger.io" }),
      invoice({ id: "in_3", number: "INV-0051", customerId: "cus_2", customerName: "Stranger LLC", customerDomain: "stranger.io" }),
    ],
    crmSnapshot(),
    { now: NOW },
  );
  assert.equal(result.counts.accountsProposed, 1);
  assert.equal(result.counts.planned, 2);
  assert.equal(result.plan.operations.filter((op) => op.objectType === "account").length, 1);
  assert.deepEqual(result.proposedAccounts, [
    { name: "Stranger LLC", domain: "stranger.io", invoiceCount: 2 },
  ]);
});

test("backfill: freemail billing domains are never used as a company domain", () => {
  const result = buildStripeBackfillPlan(
    [invoice({ id: "in_4", customerId: "cus_9", customerName: "Jane Consulting", customerEmail: "jane@gmail.com", customerDomain: "gmail.com" })],
    crmSnapshot(),
    { now: NOW },
  );
  assert.equal(result.counts.accountsProposed, 1);
  assert.deepEqual(result.proposedAccounts, [{ name: "Jane Consulting", invoiceCount: 1 }]);
  const accountPayload = result.plan.operations.find((op) => op.objectType === "account")!
    .afterValue as CreateRecordPayload;
  assert.equal(accountPayload.properties.domain, undefined);
  const dealPayload = result.plan.operations.find((op) => op.objectType === "deal")!
    .afterValue as CreateRecordPayload;
  assert.equal(dealPayload.associateCompanyDomain, undefined);
});

test("backfill: a customer with no usable name or domain stays report-only", () => {
  const result = buildStripeBackfillPlan(
    [invoice({ id: "in_5", number: "INV-0052", customerName: undefined, customerEmail: "x@gmail.com", customerDomain: "gmail.com", amountPaid: 10, currency: "USD", paidAt: "2026-03-01" })],
    crmSnapshot(),
    { now: NOW },
  );
  assert.equal(result.counts.accountsProposed, 0);
  assert.equal(result.counts.unmatched, 1);
  assert.equal(result.plan.operations.length, 0);
  assert.match(result.plan.summary, /1 customer\(s\) with no usable name\/domain reported only/);
});

test("backfill: createMissingAccounts=false restores report-only unmatched behavior", () => {
  const result = buildStripeBackfillPlan(
    [
      invoice(),
      invoice({ id: "in_2", number: "INV-0050", customerName: "Stranger LLC", customerDomain: "stranger.io", amountPaid: 42, currency: "EUR", paidAt: "2026-03-01" }),
    ],
    crmSnapshot(),
    { now: NOW, createMissingAccounts: false },
  );

  assert.equal(result.counts.planned, 1);
  assert.equal(result.counts.accountsProposed, 0);
  assert.equal(result.counts.unmatched, 1);
  assert.equal(result.plan.operations.length, 1);
  assert.deepEqual(result.unmatched[0], {
    invoiceId: "in_2",
    invoiceNumber: "INV-0050",
    customerName: "Stranger LLC",
    customerDomain: "stranger.io",
    amountPaid: 42,
    currency: "EUR",
    paidAt: "2026-03-01",
  });
  assert.match(result.plan.summary, /1 unmatched customer\(s\) reported only — account creation disabled/);
});

test("backfill: plan-time prefilter skips an invoice whose deal name already exists in the snapshot", () => {
  const result = buildStripeBackfillPlan(
    [invoice({ id: "in_7", number: "INV-0007" })], // "Invoice INV-0007 — Globex Billing" is already a deal
    crmSnapshot(),
    { now: NOW },
  );
  assert.equal(result.counts.alreadyInCrm, 1);
  assert.equal(result.counts.planned, 0);
  assert.equal(result.plan.operations.length, 0);
  assert.equal(result.plan.status, "draft"); // nothing to approve
  assert.match(result.plan.summary, /1 already have a matching deal/);
});

test("backfill: pipeline and matchProperty options flow into every payload", () => {
  const result = buildStripeBackfillPlan([invoice()], crmSnapshot(), {
    now: NOW,
    pipeline: "Renewals",
    matchProperty: "billing_invoice_ref",
  });
  const payload = result.plan.operations[0].afterValue as CreateRecordPayload;
  assert.equal(payload.dealPipeline, "Renewals");
  assert.equal(payload.matchKey, "billing_invoice_ref");
  assert.equal(payload.matchValue, "in_1");
  assert.match(result.plan.summary, /billing_invoice_ref/);
});

test("backfill: optional invoice description travels as a plain deal property", () => {
  const result = buildStripeBackfillPlan(
    [invoice({ description: "Annual plan" })],
    crmSnapshot(),
    { now: NOW },
  );
  const payload = result.plan.operations[0].afterValue as CreateRecordPayload;
  assert.equal(payload.properties.description, "Annual plan");
  // And an invoice without a paid date emits no closedate rather than a fake one.
  const noDate = buildStripeBackfillPlan([invoice({ paidAt: undefined })], crmSnapshot(), { now: NOW });
  const noDatePayload = noDate.plan.operations[0].afterValue as CreateRecordPayload;
  assert.equal("closedate" in noDatePayload.properties, false);
});

test("backfill: op ids are stable per invoice (same invoice → same op id across runs)", () => {
  const a = buildStripeBackfillPlan([invoice()], crmSnapshot(), { now: NOW });
  const b = buildStripeBackfillPlan([invoice()], crmSnapshot(), { now: () => new Date("2026-07-03T00:00:00.000Z") });
  assert.equal(a.plan.operations[0].id, b.plan.operations[0].id);
});

// ---------------------------------------------------------------------------
// CLI: `backfill stripe` end to end (stubbed Stripe, snapshot from --input)

function stripeInvoiceFetchStub(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.includes("/v1/invoices")) {
      return new Response("no stub", { status: 404 });
    }
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "in_1",
            number: "INV-0042",
            amount_paid: 109990,
            currency: "usd",
            customer: { id: "cus_1", name: "Globex Billing", email: "hank@globex.com" },
            status_transitions: { paid_at: 1767225600 }, // 2026-01-01
          },
          {
            id: "in_2",
            number: "INV-0050",
            amount_paid: 4200,
            currency: "usd",
            customer: { id: "cus_2", name: "Stranger LLC", email: "sam@stranger.io" },
            status_transitions: { paid_at: 1769904000 }, // 2026-02-01
          },
        ],
        has_more: false,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

async function withBackfillCliEnv<T>(run: (home: string, snapPath: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-backfill-"));
  const snapPath = join(home, "snapshot.json");
  writeFileSync(snapPath, JSON.stringify(crmSnapshot()));
  const prevHome = process.env.FSGTM_HOME;
  const prevKey = process.env.STRIPE_SECRET_KEY;
  const origFetch = globalThis.fetch;
  process.env.FSGTM_HOME = home;
  process.env.STRIPE_SECRET_KEY = "sk_test_123";
  globalThis.fetch = stripeInvoiceFetchStub();
  try {
    return await run(home, snapPath);
  } finally {
    globalThis.fetch = origFetch;
    if (prevHome === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = prevHome;
    if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
  }
}

async function captureCli(argv: string[]): Promise<{ out: string; err: string }> {
  const { runCli } = await import("../src/cli.ts");
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (msg: unknown) => out.push(String(msg));
  console.error = (msg: unknown) => err.push(String(msg));
  try {
    await runCli(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

test("backfill stripe CLI: --json emits {plan, counts, unmatched, proposedAccounts}; unmatched customer becomes a proposed account", async () => {
  await withBackfillCliEnv(async (home, snapPath) => {
    const { out } = await captureCli(["backfill", "stripe", "--input", snapPath, "--json"]);
    const payload = JSON.parse(out) as {
      plan: { id: string; operations: Array<{ objectType: string; afterValue: CreateRecordPayload }> };
      counts: { planned: number; accountsProposed: number; unmatched: number };
      unmatched: Array<{ invoiceId: string }>;
      proposedAccounts: Array<{ name: string; domain?: string; invoiceCount: number }>;
    };
    assert.equal(payload.counts.planned, 2);
    assert.equal(payload.counts.accountsProposed, 1);
    assert.equal(payload.counts.unmatched, 0);
    assert.deepEqual(payload.proposedAccounts, [
      { name: "Stranger LLC", domain: "stranger.io", invoiceCount: 1 },
    ]);
    assert.equal(payload.plan.operations.length, 3);
    const deal = payload.plan.operations.find(
      (op) => op.objectType === "deal" && op.afterValue.matchValue === "in_1",
    )!;
    assert.equal(deal.afterValue.dealStage, "closed_won");
    // No plan persisted without --save.
    assert.equal(existsSync(join(home, "plans", `${payload.plan.id}.json`)), false);
  });
});

test("backfill stripe CLI: --skip-unmatched restores report-only behavior", async () => {
  await withBackfillCliEnv(async (_home, snapPath) => {
    const { out } = await captureCli(["backfill", "stripe", "--input", snapPath, "--skip-unmatched", "--json"]);
    const payload = JSON.parse(out) as {
      plan: { operations: unknown[] };
      counts: { planned: number; accountsProposed: number; unmatched: number };
      unmatched: Array<{ invoiceId: string }>;
    };
    assert.equal(payload.counts.planned, 1);
    assert.equal(payload.counts.accountsProposed, 0);
    assert.equal(payload.counts.unmatched, 1);
    assert.equal(payload.unmatched[0].invoiceId, "in_2");
    assert.equal(payload.plan.operations.length, 1);
  });
});

test("backfill stripe CLI: human output lists proposed accounts and points at --save", async () => {
  await withBackfillCliEnv(async (_home, snapPath) => {
    const { out, err } = await captureCli(["backfill", "stripe", "--input", snapPath]);
    assert.match(out, /Backfill closed-won deals — stripe:invoices/);
    assert.match(out, /Proposed new accounts \(1\)/);
    assert.match(out, /Stranger LLC/);
    assert.match(out, /stranger\.io/);
    assert.match(err, /Dry run — nothing written\. Re-run with --save/);

    const skipped = await captureCli(["backfill", "stripe", "--input", snapPath, "--skip-unmatched"]);
    assert.match(skipped.out, /Unmatched invoices \(1\)/);
    assert.match(skipped.out, /INV-0050/);
  });
});

test("backfill stripe CLI: --save persists the plan for the normal approve → apply spine", async () => {
  await withBackfillCliEnv(async (home, snapPath) => {
    const { err } = await captureCli(["backfill", "stripe", "--input", snapPath, "--save"]);
    const match = err.match(/Saved plan (patch_plan_backfill_[0-9a-f]{8})/);
    assert.ok(match, `expected a saved-plan line, got: ${err}`);
    const planPath = join(home, "plans", `${match![1]}.json`);
    assert.ok(existsSync(planPath), "plan file persisted under $FSGTM_HOME/plans");
    const stored = JSON.parse(readFileSync(planPath, "utf8")) as { plan: { status: string; operations: unknown[] } };
    assert.equal(stored.plan.status, "needs_approval");
    // 2 deals + 1 proposed account for the unmatched customer.
    assert.equal(stored.plan.operations.length, 3);
    assert.match(err, /plans approve/);
    assert.match(err, /apply --plan-id/);
  });
});

test("backfill stripe CLI: --since is forwarded to Stripe as created[gte]", async () => {
  await withBackfillCliEnv(async (_home, snapPath) => {
    const seen: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(String(input));
      return inner(input as never, init);
    }) as typeof fetch;
    await captureCli(["backfill", "stripe", "--input", snapPath, "--since", "2026-01-01T00:00:00.000Z", "--json"]);
    const invoiceCall = seen.find((url) => url.includes("/v1/invoices"));
    assert.ok(invoiceCall);
    assert.ok(decodeURIComponent(invoiceCall).includes("created[gte]=1767225600"), invoiceCall);
  });
});

test("backfill CLI: unknown subcommand and missing Stripe key fail with actionable errors", async () => {
  await withBackfillCliEnv(async (_home, snapPath) => {
    await assert.rejects(captureCli(["backfill", "shopify"]), /Unknown backfill subcommand: shopify/);
    const prevKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      await assert.rejects(
        captureCli(["backfill", "stripe", "--input", snapPath]),
        /No Stripe credentials/,
      );
    } finally {
      process.env.STRIPE_SECRET_KEY = prevKey;
    }
  });
});

test("backfill is wired into help and the capabilities contract as write-shaped", async () => {
  const { out } = await captureCli(["help", "backfill"]);
  assert.match(out, /fullstackgtm backfill — /);
  assert.match(out, /Lifecycle phase: Remediate/);

  const { out: caps } = await captureCli(["capabilities"]);
  const payload = JSON.parse(caps) as { commands: Array<{ name: string; access: string }> };
  const entry = payload.commands.find((command) => command.name === "backfill");
  assert.ok(entry, "capabilities lists backfill");
  assert.equal(entry!.access, "write-shaped");
});
