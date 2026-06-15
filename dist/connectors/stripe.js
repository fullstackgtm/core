const DEFAULT_API_BASE_URL = "https://api.stripe.com";
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
export function createStripeConnector(options) {
    const baseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
    const fetchImpl = options.fetchImpl ?? fetch;
    async function request(path) {
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
    async function list(path) {
        const results = [];
        let startingAfter;
        do {
            const separator = path.includes("?") ? "&" : "?";
            const data = await request(`${path}${startingAfter ? `${separator}starting_after=${encodeURIComponent(startingAfter)}` : ""}`);
            const page = data.data ?? [];
            results.push(...page);
            startingAfter =
                data.has_more === true && page.length > 0 ? String(page.at(-1).id) : undefined;
        } while (startingAfter);
        return results;
    }
    async function assembleSnapshot(createdGte) {
        // Stripe filters list endpoints on the integer `created` field via
        // created[gte]=<unix seconds>; omitted on a full snapshot.
        const createdFilter = createdGte === undefined ? "" : `&created[gte]=${createdGte}`;
        const customers = await list(`/v1/customers?limit=100${createdFilter}`);
        const accounts = [];
        const contacts = [];
        for (const customer of customers) {
            if (!customer.id)
                continue;
            const id = String(customer.id);
            const email = stringOrUndefined(customer.email);
            // The email domain is the cross-system match key: mergeSnapshots
            // collapses this billing account onto the same company's CRM account
            // by domain, so revenue data lands on the right merged record.
            const domain = email?.includes("@") ? email.split("@").at(-1).toLowerCase() : undefined;
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
        const subscriptions = await list(`/v1/subscriptions?status=all&limit=100${createdFilter}`);
        const deals = subscriptions
            .filter((subscription) => subscription.id)
            .map((subscription) => {
            const id = String(subscription.id);
            const items = subscription.items?.data ?? [];
            const firstPrice = items[0]?.price;
            const status = stringOrUndefined(subscription.status);
            const isWon = status === "active" || status === "trialing";
            const isLost = status === "canceled" || status === "incomplete_expired" || status === "unpaid";
            // Stripe prices are minor units (cents); canonical amounts are major
            // units. Metered/tiered prices have a null unit_amount — their value
            // isn't knowable from the subscription alone, so leave the amount
            // undefined rather than understating it as 0 (an amountless deal the
            // audit can flag, instead of a silently wrong number).
            const hasUnpricedItem = items.some((item) => numberOrUndefined(item.price?.unit_amount) === undefined);
            const amountCents = hasUnpricedItem
                ? undefined
                : items.reduce((sum, item) => sum +
                    (numberOrUndefined(item.price?.unit_amount) ?? 0) *
                        (numberOrUndefined(item.quantity) ?? 1), 0);
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
                closeDate: typeof subscription.start_date === "number"
                    ? new Date(subscription.start_date * 1000).toISOString().split("T")[0]
                    : undefined,
                raw: subscription,
            };
        });
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
    async function fetchSnapshot() {
        return assembleSnapshot();
    }
    /**
     * Customers and subscriptions created since `sinceIso`. Stripe filters on the
     * integer `created` field (unix seconds), so the ISO timestamp is converted
     * to unix seconds for the `created[gte]` query param. Note this catches
     * newly-created records only, not status changes on existing ones.
     */
    async function fetchChanges(sinceIso) {
        const sinceMs = Date.parse(sinceIso);
        if (!Number.isFinite(sinceMs))
            throw new Error(`Invalid since timestamp: ${sinceIso}`);
        return assembleSnapshot(Math.floor(sinceMs / 1000));
    }
    async function applyOperation(operation) {
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
function stringOrUndefined(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    return String(value);
}
function numberOrUndefined(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : undefined;
}
