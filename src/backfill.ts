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

import type {
  CanonicalAccount,
  CanonicalGtmSnapshot,
  CreateRecordPayload,
  GtmEvidence,
  PatchOperation,
  PatchPlan,
} from "./types.ts";
import type { StripePaidInvoice } from "./connectors/stripe.ts";
import { FREE_EMAIL_DOMAINS } from "./freeEmailDomains.ts";
import { normalizeDomain } from "./merge.ts";

// Mirrors stableHash in rules.ts (FNV-1a); duplicated to keep backfill.ts
// importable without pulling the audit engine (the enrich.ts precedent).
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export const DEFAULT_BACKFILL_MATCH_PROPERTY = "stripe_invoice_id";

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

/** `Invoice <number || id> — <customer name>` (the plan-time dedupe name). */
function backfillDealName(invoice: StripePaidInvoice, companyName: string): string {
  return `Invoice ${invoice.number ?? invoice.id} — ${invoice.customerName ?? companyName}`;
}

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
export function buildStripeBackfillPlan(
  invoices: StripePaidInvoice[],
  snapshot: CanonicalGtmSnapshot,
  opts: StripeBackfillOptions = {},
): StripeBackfillResult {
  const nowIso = (opts.now ?? (() => new Date()))().toISOString();
  const matchProperty = opts.matchProperty ?? DEFAULT_BACKFILL_MATCH_PROPERTY;
  const source = opts.source ?? "stripe:invoices";

  // Snapshot lookups. First occurrence wins on a duplicate key — the
  // connector's own resolve/associate step handles ambiguity at apply time.
  const accountsByDomain = new Map<string, CanonicalAccount>();
  const accountsByName = new Map<string, CanonicalAccount>();
  for (const account of snapshot.accounts ?? []) {
    const domain = normalizeDomain(account.domain);
    if (domain && !accountsByDomain.has(domain)) accountsByDomain.set(domain, account);
    const name = account.name?.trim().toLowerCase();
    if (name && !accountsByName.has(name)) accountsByName.set(name, account);
  }
  const existingDealNames = new Set(
    (snapshot.deals ?? [])
      .map((deal) => deal.name?.trim().toLowerCase())
      .filter((name): name is string => Boolean(name)),
  );

  const createMissingAccounts = opts.createMissingAccounts ?? true;
  const operations: PatchOperation[] = [];
  const evidence: GtmEvidence[] = [];
  const unmatched: StripeBackfillUnmatched[] = [];
  const proposedByKey = new Map<string, StripeBackfillProposedAccount>();
  const counts: StripeBackfillCounts = {
    invoices: invoices.length,
    planned: 0,
    accountsProposed: 0,
    unmatched: 0,
    alreadyInCrm: 0,
  };

  for (const invoice of invoices) {
    // Match the customer to a CRM account: domain first, then exact name.
    const domain = normalizeDomain(invoice.customerDomain);
    let account = domain ? accountsByDomain.get(domain) : undefined;
    if (!account && invoice.customerName) {
      account = accountsByName.get(invoice.customerName.trim().toLowerCase());
    }

    // The company the deal will land on: the matched account, or (default) a
    // new account this plan proposes for the unmatched customer.
    let companyName: string | undefined = account?.name;
    let companyDomain = normalizeDomain(account?.domain);
    let accountIsNew = false;
    if (!account && createMissingAccounts) {
      const usableDomain = domain && !FREE_EMAIL_DOMAINS.has(domain) ? domain : undefined;
      const name = invoice.customerName?.trim() || usableDomain;
      if (name) {
        companyName = name;
        companyDomain = usableDomain;
        accountIsNew = true;
      }
    }
    if (!companyName) {
      counts.unmatched += 1;
      unmatched.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        customerName: invoice.customerName,
        customerDomain: invoice.customerDomain,
        amountPaid: invoice.amountPaid,
        currency: invoice.currency,
        paidAt: invoice.paidAt,
      });
      continue;
    }

    // Plan-time dupe prefilter by deal name (best-effort; apply-time
    // resolve-first on the invoice-id property is the authoritative gate).
    const dealName = backfillDealName(invoice, companyName);
    if (existingDealNames.has(dealName.trim().toLowerCase())) {
      counts.alreadyInCrm += 1;
      continue;
    }

    const invoiceLabel = invoice.number ?? invoice.id;
    const amountLabel = `${invoice.amountPaid}${invoice.currency ? ` ${invoice.currency}` : ""}`;
    const recordEvidence: GtmEvidence = {
      id: `ev_bkf_${fnv1a(`${source}:${invoice.id}`)}`,
      sourceSystem: "web",
      sourceObjectType: "invoice",
      sourceObjectId: invoice.id,
      title: `Stripe paid invoice ${invoiceLabel}`,
      text:
        `Stripe invoice ${invoiceLabel} (${invoice.id}) for ${invoice.customerName ?? companyName}: ` +
        `${amountLabel} paid${invoice.paidAt ? ` on ${invoice.paidAt}` : ""}.`,
      capturedAt: nowIso,
      metadata: {
        source,
        invoiceId: invoice.id,
        amountPaid: invoice.amountPaid,
        currency: invoice.currency ?? null,
        paidAt: invoice.paidAt ?? null,
        customerId: invoice.customerId ?? null,
      },
    };
    evidence.push(recordEvidence);

    // One explicit account op per NEW customer (not per invoice): the reviewer
    // sees exactly which companies this plan will create. Apply resolves by
    // domain-then-name first, so a concurrently-created account is reused.
    if (accountIsNew) {
      const accountKey = (companyDomain ?? companyName).toLowerCase();
      const existing = proposedByKey.get(accountKey);
      if (existing) {
        existing.invoiceCount += 1;
      } else {
        proposedByKey.set(accountKey, {
          name: companyName,
          ...(companyDomain ? { domain: companyDomain } : {}),
          invoiceCount: 1,
        });
        const accountPayload: CreateRecordPayload = {
          properties: {
            name: companyName,
            ...(companyDomain ? { domain: companyDomain } : {}),
          },
          matchKey: "name",
          matchValue: companyName,
          source,
        };
        operations.push({
          id: `op_bkf_${fnv1a(`${source}:account:${accountKey}`)}`,
          objectType: "account",
          objectId: `create:stripe:customer:${invoice.customerId ?? accountKey}`,
          operation: "create_record",
          beforeValue: null,
          afterValue: accountPayload,
          reason:
            `Stripe customer "${companyName}"${companyDomain ? ` (${companyDomain})` : ""} has paid ` +
            `invoice(s) but no CRM account — create it so the backfilled deals have a home. ` +
            `Resolve-first by ${companyDomain ? "domain, then " : ""}name at apply.`,
          sourceRuleOrPolicy: `backfill:${source}`,
          riskLevel: "medium",
          approvalRequired: true,
          rollback: "Archive the created company (it was net-new).",
          evidenceIds: [recordEvidence.id],
        });
        counts.accountsProposed += 1;
      }
    }

    // Prefer the matched ACCOUNT's own name/domain for the association so the
    // connector's resolve-first company step lands on the matched record; for
    // a new customer these are the proposed account's name/domain.
    const payload: CreateRecordPayload = {
      properties: {
        dealname: dealName,
        amount: String(invoice.amountPaid),
        ...(invoice.paidAt ? { closedate: invoice.paidAt } : {}),
        ...(invoice.description ? { description: invoice.description } : {}),
      },
      matchKey: matchProperty,
      matchValue: invoice.id,
      source,
      dealStage: "closed_won",
      ...(opts.pipeline ? { dealPipeline: opts.pipeline } : {}),
      associateCompanyName: companyName,
      ...(companyDomain ? { associateCompanyDomain: companyDomain } : {}),
    };
    operations.push({
      id: `op_bkf_${fnv1a(`${source}:deal:${invoice.id}`)}`,
      objectType: "deal",
      objectId: `create:stripe:invoice:${invoice.id}`,
      operation: "create_record",
      beforeValue: null,
      afterValue: payload,
      reason:
        `Paid Stripe invoice ${invoiceLabel} (${amountLabel}, paid ${invoice.paidAt ?? "date unknown"}) ` +
        `has no CRM deal — backfill as closed-won on ${accountIsNew ? "NEW account" : "account"} ` +
        `"${companyName}"${accountIsNew ? " (created by this plan)" : ""} ` +
        `(deduped by ${matchProperty}=${invoice.id}).`,
      sourceRuleOrPolicy: `backfill:${source}`,
      riskLevel: "medium",
      approvalRequired: true,
      rollback: "Archive the created deal (it was net-new).",
      evidenceIds: [recordEvidence.id],
    });
    counts.planned += 1;
  }

  const plan: PatchPlan = {
    id: `patch_plan_backfill_${fnv1a(`${source}:${nowIso}:${invoices.map((invoice) => invoice.id).join(",")}`)}`,
    title: `Backfill closed-won deals — ${source}`,
    createdAt: nowIso,
    status: operations.length > 0 ? "needs_approval" : "draft",
    dryRun: true,
    summary:
      `${counts.planned} closed-won deal(s) proposed from ${counts.invoices} paid Stripe invoice(s)` +
      `${counts.accountsProposed > 0 ? `, plus ${counts.accountsProposed} new account(s) proposed for customers the CRM doesn't know` : ""} ` +
      `(${counts.alreadyInCrm} already have a matching deal, ${counts.unmatched} ` +
      `${createMissingAccounts ? "customer(s) with no usable name/domain" : "unmatched customer(s)"} reported only` +
      `${createMissingAccounts ? "" : " — account creation disabled"}). ` +
      `Deduped by ${matchProperty} = invoice id; apply re-checks resolve-first before creating.`,
    findings: [],
    evidence,
    operations,
  };
  return { plan, counts, unmatched, proposedAccounts: [...proposedByKey.values()] };
}
