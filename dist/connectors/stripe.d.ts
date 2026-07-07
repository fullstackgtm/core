import type { GtmConnector } from "../types.ts";
import { type ProgressEmitter } from "../progress.ts";
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
export declare function fetchStripePaidInvoices(options: StripeConnectorOptions, opts?: {
    sinceIso?: string;
    onPage?: (fetched: number) => void;
}): Promise<StripePaidInvoice[]>;
