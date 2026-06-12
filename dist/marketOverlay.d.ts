import type { CanonicalGtmSnapshot, PatchPlan } from "./types.ts";
import type { MarketConfig, ObservationSet } from "./market.ts";
/**
 * The directive layer: the market map joined to the company's own ground
 * truth. The map alone says what the category looks like; the overlay says
 * what THIS company should do about it — and two companies running the same
 * map see different directives, because the overlay is their own conversion
 * fingerprint.
 *
 * Everything here is deterministic. Inputs are the observation store (front
 * states), a CRM snapshot (won/lost deals), and call documents (transcript
 * text, optionally linked to deals). Claim mentions are found by exact
 * word-boundary term matching against each claim's configured `terms` —
 * the same posture as the rest of the map: no model in the loop, every
 * directive carries at least one observation and at least one CRM statistic
 * with its sample size, and small samples refuse to become claims (the
 * minimum-evidence thresholds are explicit options, not vibes).
 */
export type CallDocument = {
    id: string;
    text: string;
    /** Links the document to a deal for win/loss statistics; optional. */
    dealId?: string;
    occurredAt?: string;
};
export type ClaimMentionStats = {
    claimId: string;
    /** Documents whose text matches any of the claim's terms. */
    mentionDocIds: string[];
    /** Distinct deals among those documents (only docs with dealId count). */
    mentionDealIds: string[];
    wonDeals: number;
    lostDeals: number;
    /** won / (won + lost) among closed mentioned deals; null below any closure. */
    winRateWhenMentioned: number | null;
};
export type VendorMentionStats = {
    vendorId: string;
    mentionDocIds: string[];
    mentionDealIds: string[];
    wonWhenMentioned: number;
    lostWhenMentioned: number;
};
export type OverlayStats = {
    documents: number;
    documentsWithDeal: number;
    deals: {
        total: number;
        closed: number;
        won: number;
        baselineWinRate: number | null;
    };
    claims: ClaimMentionStats[];
    vendors: VendorMentionStats[];
};
export type DirectiveType = "occupy" | "promote" | "urgent" | "retreat";
export type DirectiveStat = {
    name: string;
    value: number | string;
    n: number;
};
export type MarketDirective = {
    id: string;
    type: DirectiveType;
    claimId: string;
    title: string;
    summary: string;
    recommendation: string;
    /** ≥1 observation id and ≥1 CRM stat — the spec's evidence-chain rule. */
    observationIds: string[];
    stats: DirectiveStat[];
};
export type OverlayOptions = {
    /** Minimum mention documents before OCCUPY/PROMOTE may fire (default 3). */
    minMentions?: number;
    /** Minimum win-rate lift over baseline for PROMOTE (default 0.10). */
    promoteLift?: number;
    /** Minimum won deals in the corpus before RETREAT may fire (default 3). */
    minWonDealsForRetreat?: number;
    /** Prior run's observations: enables URGENT (front drift) directives. */
    priorSet?: ObservationSet;
};
/**
 * Deterministic claim/vendor mention statistics over a call corpus.
 * Claims match on their configured `terms` (claims without terms simply have
 * no mention stats — the directives that need mentions will not fire for
 * them); vendors match on name + configured `aliases`.
 */
export declare function computeOverlayStats(config: MarketConfig, snapshot: CanonicalGtmSnapshot, documents: CallDocument[]): OverlayStats;
/**
 * Directive rules v1 — deterministic over (front states × overlay stats),
 * with explicit minimum-evidence thresholds so small samples cannot mint
 * strategy. Requires config.anchorVendor: directives are advice to someone.
 *
 *   OCCUPY  — open/vacant front the anchor doesn't own loudly, and buyers
 *             demonstrably talk about it (≥ minMentions documents).
 *   PROMOTE — anchor is quiet on a claim whose mentioned-deal win rate beats
 *             baseline by ≥ promoteLift (with ≥ minMentions mentioned deals).
 *   URGENT  — a front the anchor is loud on drifted toward saturation since
 *             the prior run (requires priorSet).
 *   RETREAT — saturated front the anchor is loud on, with zero presence in
 *             won-deal conversations despite a corpus that contains wins.
 */
export declare function computeDirectives(config: MarketConfig, set: ObservationSet, stats: OverlayStats, options?: OverlayOptions): MarketDirective[];
/**
 * Emit directives as a standard dry-run patch plan: one approval-gated
 * create_task per directive against a designated CRM record (the company's
 * own account/deal record — directives are strategy tasks, and the CRM
 * needs somewhere to hang them). Approving and applying goes through the
 * normal plans → approve → apply gate; nothing here writes.
 */
export declare function directivesToPlan(config: MarketConfig, set: ObservationSet, directives: MarketDirective[], target: {
    objectType: "account" | "deal";
    objectId: string;
}, now?: () => Date): PatchPlan;
export declare function overlayToMarkdown(stats: OverlayStats, directives: MarketDirective[]): string;
