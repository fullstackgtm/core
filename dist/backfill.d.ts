/**
 * Backfill: Stripe paid invoices → closed-won CRM deals, through the normal
 * governed plan/apply flow.
 *
 * Product assumption this encodes: billing (Stripe) is the revenue source
 * of truth; the CRM should retroactively carry ONE closed-won deal per paid
 * invoice (amount = invoice total, close date = paid date, associated to the
 * customer's company, deduped by invoice id). This module only BUILDS the
 * dry-run plan — nothing here touches a CRM. Writes happen exclusively via
 * `apply` on operations approved through `plans approve`, where the HubSpot
 * connector re-resolves each invoice id (resolve-first) and creates only on
 * a confirmed miss.
 */
import type { CanonicalGtmSnapshot, PatchPlan } from "./types.ts";
import type { StripePaidInvoice } from "./connectors/stripe.ts";
export declare const DEFAULT_BACKFILL_MATCH_PROPERTY = "stripe_invoice_id";
export type StripeBackfillOptions = {
    /** Pipeline id or case-insensitive label; absent = the portal's default pipeline. */
    pipeline?: string;
    /** Deal dedupe property stamped with the invoice id (default "stripe_invoice_id"). */
    matchProperty?: string;
    /** Source label recorded on payloads/evidence (default "stripe:invoices"). */
    source?: string;
    /**
     * When a customer matches no CRM account, propose creating the account as
     * part of this plan (default true). The account op is explicit and
     * approval-gated like everything else; apply is resolve-first, so an
     * account that appeared in the meantime is reused, not duplicated. False =
     * the conservative original behavior: unmatched customers are reported
     * only and their invoices produce no operations.
     */
    createMissingAccounts?: boolean;
    /** Injectable clock for deterministic tests. */
    now?: () => Date;
};
/** One invoice whose customer could not be matched to any CRM account. */
export type StripeBackfillUnmatched = {
    invoiceId: string;
    invoiceNumber?: string;
    customerName?: string;
    customerDomain?: string;
    amountPaid: number;
    currency?: string;
    paidAt?: string;
};
/** One account this plan proposes to create for an unmatched Stripe customer. */
export type StripeBackfillProposedAccount = {
    name: string;
    domain?: string;
    /** Paid invoices from this customer that the plan attaches to the account. */
    invoiceCount: number;
};
export type StripeBackfillCounts = {
    invoices: number;
    /** create_record deal ops emitted. */
    planned: number;
    /** create_record account ops emitted for unmatched customers. */
    accountsProposed: number;
    /** Customers with no CRM match AND no usable name/domain — reported only. */
    unmatched: number;
    /** Plan-time prefilter: a deal with the same name already exists. */
    alreadyInCrm: number;
};
export type StripeBackfillResult = {
    plan: PatchPlan;
    counts: StripeBackfillCounts;
    unmatched: StripeBackfillUnmatched[];
    proposedAccounts: StripeBackfillProposedAccount[];
};
/**
 * Match each paid invoice's customer to a snapshot account (normalized domain
 * first — the accurate key — then exact case-insensitive name) and emit one
 * create_record deal op per invoice that has no deal yet.
 *
 * Unmatched customers (default): the plan ALSO proposes creating the account —
 * one explicit, approval-gated account create_record op per new customer,
 * with the customer's invoices attached as deals. Freemail billing domains
 * (gmail/outlook/…) are never used as a company domain. A customer with no
 * usable name or domain stays report-only. `createMissingAccounts: false`
 * restores the original conservative behavior (unmatched = reported, no ops).
 *
 * The by-deal-name prefilter here is best-effort plan hygiene; the
 * AUTHORITATIVE duplicate gate is the connector's apply-time resolve-first
 * search on the invoice-id property (and resolve-by-domain/name for accounts).
 */
export declare function buildStripeBackfillPlan(invoices: StripePaidInvoice[], snapshot: CanonicalGtmSnapshot, opts?: StripeBackfillOptions): StripeBackfillResult;
