import type { GtmConnector } from "../types.ts";
export type StripeConnectorOptions = {
    /** Stripe secret key (sk_...) or restricted key. */
    getApiKey: () => string | Promise<string>;
    apiBaseUrl?: string;
    /** Injectable fetch for testing. */
    fetchImpl?: typeof fetch;
};
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
export declare function createStripeConnector(options: StripeConnectorOptions): GtmConnector;
