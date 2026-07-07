import type {
  CanonicalAccount,
  CanonicalContact,
  CanonicalDeal,
  CanonicalGtmSnapshot,
  GtmConnector,
  PatchOperation,
  PatchOperationResult,
} from "../types.ts";
import { STRIPE_SNAPSHOT_STAGES, type ProgressEmitter } from "../progress.ts";

const DEFAULT_API_BASE_URL = "https://api.stripe.com";

export type StripeConnectorOptions = {
  /** Stripe secret key (sk_...) or restricted key. */
  getApiKey: () => string | Promise<string>;
  apiBaseUrl?: string;
  /** Injectable fetch for testing. */
  fetchImpl?: typeof fetch;
  /**
   * Shared progress vocabulary (src/progress.ts): the snapshot pull emits a
   * `stage` per collection (customers, subscriptions) and an `items`
   * heartbeat per page. Presentation-only — errors are swallowed.
   */
  progress?: ProgressEmitter;
};

// Module-scope request/list (parameterized by options) so the connector
// factory and fetchStripePaidInvoices share one implementation.
async function stripeRequest(options: StripeConnectorOptions, path: string): Promise<any> {
  const baseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = await options.getApiKey();
  const response = await fetchImpl(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    // Status line only — the body can echo request details bound to a live
    // billing key, and these errors land in scheduled-run records.
    await response.text().catch(() => undefined);
    throw new Error(`Stripe API error ${response.status}. Check the restricted key and request.`);
  }
  return response.json();
}

/** Stripe list pagination: follow `has_more` with `starting_after=<last id>`. */
async function stripeList(
  options: StripeConnectorOptions,
  path: string,
  onPage?: (fetched: number) => void,
): Promise<any[]> {
  const results: any[] = [];
  let startingAfter: string | undefined;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const data = await stripeRequest(
      options,
      `${path}${startingAfter ? `${separator}starting_after=${encodeURIComponent(startingAfter)}` : ""}`,
    );
    const page: any[] = data.data ?? [];
    results.push(...page);
    try {
      onPage?.(results.length);
    } catch {
      // progress is presentation-only; never let it fail a pull
    }
    startingAfter =
      data.has_more === true && page.length > 0 ? String(page.at(-1).id) : undefined;
  } while (startingAfter);
  return results;
}

/**
 * Read-only billing connector for Stripe — the first non-CRM connector,
 * proving the GtmConnector contract generalizes to billing systems.
 *
 * Semantics:
 * - READ-ONLY: `applyOperation` always returns a `skipped` result and never
 *   writes to Stripe; `readField` is intentionally not implemented, so apply
 *   orchestration treats every field as unreadable rather than guessing.
 * - Customers map to canonical accounts, plus a canonical contact when the
 *   customer has an email address.
 * - Subscriptions map to canonical deals: active/trialing subscriptions are
 *   closed-won, canceled/incomplete_expired/unpaid are closed-lost, and
 *   anything else (e.g. past_due, incomplete) is still open.
 * - Stripe amounts are minor units (cents); the canonical model uses major
 *   units, so amounts are divided by 100 at this boundary.
 * - Billing systems have no sales users and no activities, so both
 *   collections are always empty.
 */
export function createStripeConnector(options: StripeConnectorOptions): GtmConnector {
  const list = (path: string, onPage?: (fetched: number) => void) =>
    stripeList(options, path, onPage);
  // Shared progress vocabulary: stage per collection, items per page.
  const pullStage = (stage: (typeof STRIPE_SNAPSHOT_STAGES)[number]) =>
    options.progress?.stage(
      stage,
      STRIPE_SNAPSHOT_STAGES.indexOf(stage),
      STRIPE_SNAPSHOT_STAGES.length,
    );
  const pullItems = (fetched: number) => options.progress?.items(fetched);

  async function assembleSnapshot(createdGte?: number): Promise<CanonicalGtmSnapshot> {
    // Stripe filters list endpoints on the integer `created` field via
    // created[gte]=<unix seconds>; omitted on a full snapshot.
    const createdFilter =
      createdGte === undefined ? "" : `&created[gte]=${createdGte}`;
    pullStage("customers");
    const customers = await list(`/v1/customers?limit=100${createdFilter}`, pullItems);
    const accounts: CanonicalAccount[] = [];
    const contacts: CanonicalContact[] = [];
    for (const customer of customers) {
      if (!customer.id) continue;
      const id = String(customer.id);
      const email = stringOrUndefined(customer.email);
      // The email domain is the cross-system match key: mergeSnapshots
      // collapses this billing account onto the same company's CRM account
      // by domain, so revenue data lands on the right merged record.
      const domain = email?.includes("@") ? email.split("@").at(-1)!.toLowerCase() : undefined;
      accounts.push({
        id,
        provider: "stripe",
        crmId: id,
        identities: [{ provider: "stripe", externalId: id }],
        name: stringOrUndefined(customer.name) ?? email ?? `Customer ${id}`,
        domain,
        raw: customer,
      });
      if (email) {
        // Stripe customers carry a single billing email, not split names;
        // name parts stay undefined so merge-by-email can fill them in.
        contacts.push({
          id: `${id}_contact`,
          provider: "stripe",
          crmId: id,
          identities: [{ provider: "stripe", externalId: id }],
          accountId: id,
          email,
          raw: customer,
        });
      }
    }

    pullStage("subscriptions");
    const subscriptions = await list(
      `/v1/subscriptions?status=all&limit=100${createdFilter}`,
      pullItems,
    );
    const deals: CanonicalDeal[] = subscriptions
      .filter((subscription) => subscription.id)
      .map((subscription) => {
        const id = String(subscription.id);
        const items: any[] = subscription.items?.data ?? [];
        const firstPrice = items[0]?.price;
        const status = stringOrUndefined(subscription.status);
        const isWon = status === "active" || status === "trialing";
        const isLost =
          status === "canceled" || status === "incomplete_expired" || status === "unpaid";
        // Stripe prices are minor units (cents); canonical amounts are major
        // units. Metered/tiered prices have a null unit_amount — their value
        // isn't knowable from the subscription alone, so leave the amount
        // undefined rather than understating it as 0 (an amountless deal the
        // audit can flag, instead of a silently wrong number).
        const hasUnpricedItem = items.some(
          (item) => numberOrUndefined(item.price?.unit_amount) === undefined,
        );
        const amountCents = hasUnpricedItem
          ? undefined
          : items.reduce(
              (sum, item) =>
                sum +
                (numberOrUndefined(item.price?.unit_amount) ?? 0) *
                  (numberOrUndefined(item.quantity) ?? 1),
              0,
            );
        return {
          id,
          provider: "stripe",
          crmId: id,
          identities: [{ provider: "stripe", externalId: id }],
          accountId: stringOrUndefined(subscription.customer),
          name: `Subscription ${firstPrice?.nickname ?? firstPrice?.id ?? id}`,
          amount: amountCents === undefined ? undefined : amountCents / 100,
          currency: stringOrUndefined(firstPrice?.currency)?.toUpperCase(),
          stage: status,
          isClosed: isWon || isLost,
          isWon,
          closeDate:
            typeof subscription.start_date === "number"
              ? new Date(subscription.start_date * 1000).toISOString().split("T")[0]
              : undefined,
          raw: subscription,
        };
      });

    // Deliver any throttled trailing items heartbeat before the pull returns.
    options.progress?.flush();

    return {
      generatedAt: new Date().toISOString(),
      provider: "stripe",
      // Billing systems have neither sales users nor activities.
      users: [],
      accounts,
      contacts,
      deals,
      activities: [],
    };
  }

  async function fetchSnapshot(): Promise<CanonicalGtmSnapshot> {
    return assembleSnapshot();
  }

  /**
   * Customers and subscriptions created since `sinceIso`. Stripe filters on the
   * integer `created` field (unix seconds), so the ISO timestamp is converted
   * to unix seconds for the `created[gte]` query param. Note this catches
   * newly-created records only, not status changes on existing ones.
   */
  async function fetchChanges(sinceIso: string): Promise<CanonicalGtmSnapshot> {
    const sinceMs = Date.parse(sinceIso);
    if (!Number.isFinite(sinceMs)) throw new Error(`Invalid since timestamp: ${sinceIso}`);
    return assembleSnapshot(Math.floor(sinceMs / 1000));
  }

  async function applyOperation(operation: PatchOperation): Promise<PatchOperationResult> {
    return {
      operationId: operation.id,
      status: "skipped",
      detail: "The stripe connector is read-only.",
    };
  }

  return {
    provider: "stripe",
    fetchSnapshot,
    fetchChanges,
    applyOperation,
  };
}

/**
 * One PAID Stripe invoice, normalized for the backfill plan builder
 * (`backfill stripe`). Amounts are major units (Stripe returns cents);
 * `paidAt` is the payment date (YYYY-MM-DD) from status_transitions.paid_at.
 */
export type StripePaidInvoice = {
  id: string;
  number?: string;
  customerId?: string;
  customerName?: string;
  customerEmail?: string;
  /** Lowercased domain of the customer's billing email — the CRM match key. */
  customerDomain?: string;
  /** Major currency units (amount_paid / 100). */
  amountPaid: number;
  currency?: string;
  /** YYYY-MM-DD from status_transitions.paid_at (unix seconds). */
  paidAt?: string;
  description?: string;
};

/**
 * Read-only pull of PAID invoices (GET /v1/invoices?status=paid with the
 * customer expanded), the revenue source of truth the backfill plan builder
 * turns into closed-won deal proposals. Invoices with a zero amount_paid or
 * no id are skipped — a $0 invoice is not a won deal.
 */
export async function fetchStripePaidInvoices(
  options: StripeConnectorOptions,
  opts: { sinceIso?: string; onPage?: (fetched: number) => void } = {},
): Promise<StripePaidInvoice[]> {
  let createdFilter = "";
  if (opts.sinceIso !== undefined) {
    const sinceMs = Date.parse(opts.sinceIso);
    if (!Number.isFinite(sinceMs)) throw new Error(`Invalid since timestamp: ${opts.sinceIso}`);
    createdFilter = `&created[gte]=${Math.floor(sinceMs / 1000)}`;
  }
  const invoices = await stripeList(
    options,
    `/v1/invoices?status=paid&limit=100&expand[]=data.customer${createdFilter}`,
    opts.onPage,
  );
  const paid: StripePaidInvoice[] = [];
  for (const invoice of invoices) {
    if (!invoice?.id) continue;
    const amountPaidCents = numberOrUndefined(invoice.amount_paid);
    if (amountPaidCents === undefined || amountPaidCents <= 0) continue;
    // customer is the expanded object when expand[]=data.customer was honored,
    // else the plain id string — handle both.
    const customer = invoice.customer;
    const customerId =
      typeof customer === "string" ? customer : stringOrUndefined(customer?.id);
    // Invoices also carry flat customer_name/customer_email copies — use them
    // when the customer object wasn't expanded (or lacks the field).
    const customerName =
      (typeof customer === "object" && customer !== null
        ? stringOrUndefined(customer.name)
        : undefined) ?? stringOrUndefined(invoice.customer_name);
    const customerEmail =
      typeof customer === "object" && customer !== null
        ? stringOrUndefined(customer.email) ?? stringOrUndefined(invoice.customer_email)
        : stringOrUndefined(invoice.customer_email);
    const customerDomain = customerEmail?.includes("@")
      ? customerEmail.split("@").at(-1)!.toLowerCase()
      : undefined;
    const paidAtSeconds = numberOrUndefined(invoice.status_transitions?.paid_at);
    paid.push({
      id: String(invoice.id),
      number: stringOrUndefined(invoice.number),
      customerId,
      customerName,
      customerEmail,
      customerDomain,
      amountPaid: amountPaidCents / 100,
      currency: stringOrUndefined(invoice.currency)?.toUpperCase(),
      paidAt:
        paidAtSeconds !== undefined
          ? new Date(paidAtSeconds * 1000).toISOString().split("T")[0]
          : undefined,
      description: stringOrUndefined(invoice.description),
    });
  }
  return paid;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}
