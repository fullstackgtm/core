/**
 * `tam` — Total Addressable Market mapping.
 *
 * Market mapping (`market`) answers "who else is in this category and where are
 * the open fronts." TAM mapping answers a different, longer-horizon question:
 * "how big is the reachable market for *my* ICP, and how far along am I in
 * actually putting it in the CRM?"
 *
 * It is deliberately NOT a one-shot "$10B TAM" headline. The flow is iterative:
 *   1. `tam estimate` — derive a defensible universe from the ICP: a real
 *      account count (a discovery provider's total-match for the ICP filter, or
 *      an explicit assumption), × ACV for the dollar figure, with buyers/account
 *      giving the *contact* population target. Citable cross-checks optional.
 *   2. `tam populate` — schedule governed `enrich acquire --save` runs that chip
 *      away at the universe (plan-only; apply stays a separate human gate).
 *   3. `tam status` / `tam report` — coverage over time: accounts/contacts/$
 *      in the CRM vs. the universe, what THIS campaign added since baseline, and
 *      an ETA at the current burn rate — so "it'll take a while" is quantified.
 *
 * This module is the pure, deterministic core (estimation + coverage + ETA math
 * + a profile-scoped store). The CLI wires it to the ICP, the CRM snapshot, the
 * discovery providers, and the scheduler.
 */
import type { CanonicalAccount, CanonicalGtmSnapshot } from "./types.ts";
/**
 * ACV basis. `account` (per logo / contract — the standard TAM basis) makes
 * TAM = accounts × ACV. `buyer` (per seat) makes TAM = contacts × ACV, for
 * genuinely seat-priced products. Buyers/account always drives the *contact*
 * population target regardless of basis.
 */
export type AcvBasis = "account" | "buyer";
/** A citable market-research figure that cross-checks the bottom-up estimate. */
export type TamCrossCheck = {
    claim: string;
    /** Parsed dollar value, when the claim is a $ figure — enables a direct compare. */
    valueUsd?: number;
    sourceUrl: string;
    /** Verbatim snippet (same evidence posture as market signals). */
    quote: string;
    asOf?: string;
};
/** Real CRM counts that "fill" the TAM — accounts with a domain + their contacts. */
export type TamCoverageCounts = {
    accounts: number;
    contacts: number;
};
export type TamUniverse = {
    accounts: number;
    /** Where the account count came from: "provider:explorium" or "assumption". */
    accountsSource: string;
    buyersPerAccount: number;
    /** how buyersPerAccount was set: "crm:avg-contacts-per-account (N)" or "explicit" or "assumption:...". */
    buyersSource: string;
    /** accounts × buyersPerAccount — the contact population target. */
    contacts: number;
};
/**
 * The ICP criteria the TAM was estimated against — captured at estimate time so
 * `status` can classify CRM accounts as in/out of THIS TAM. geo/technology aren't
 * on a CanonicalAccount, so only `employeeBands`/`industries` are CRM-checkable;
 * geo + technographic verification needs re-enrichment (`--reverify`, future).
 */
export type TamTargeting = {
    geos?: string[];
    employeeBands?: string[];
    industries?: string[];
    technologies?: string[];
};
export type TamModel = {
    name: string;
    icpName: string;
    universe: TamUniverse;
    /** the ICP filter this TAM was sized against (for coverage classification). */
    targeting?: TamTargeting;
    /** ACV must be REAL, never a fabricated default: `source` says where it came
     *  from ("explicit" from the operator, or "crm:closed-won (N deals, median)"). */
    acv: {
        basis: AcvBasis;
        valueUsd: number;
        source: string;
    };
    /** accounts × ACV (account basis) or contacts × ACV (buyer basis). */
    tamUsd: number;
    crossChecks: TamCrossCheck[];
    /** CRM counts at estimate time, so `status` can attribute what the campaign added. */
    baseline: TamCoverageCounts;
    createdAt: string;
};
/** CRM accounts classified against the TAM ICP — only the in-TAM bucket counts. */
export type TamClassified = {
    /** matches every CRM-checkable criterion (no contradiction) — counts toward coverage. */
    inTam: number;
    /** fails a checkable criterion (wrong size/industry) — NOT in this market. */
    outOfTam: number;
    /** missing the data to classify — surfaced, never silently counted. */
    unknown: number;
    /** all domain-bearing CRM accounts (inTam + outOfTam + unknown). */
    totalCrm: number;
    /** which criteria were CRM-checkable, e.g. ["size","industry"]. */
    criteria: string[];
};
export type TamCoverage = {
    at: string;
    universe: {
        accounts: number;
        contacts: number;
        tamUsd: number;
    };
    inCrm: TamCoverageCounts;
    /** current − baseline (floored at 0) — what's been added since the TAM was set. */
    addedSinceBaseline: TamCoverageCounts;
    /** in-TAM (or total when unclassified) / universe, capped at 1. */
    accountCoverage: number;
    contactCoverage: number;
    /** accountCoverage × tamUsd. */
    dollarCovered: number;
    /** present when the model carries targeting — the in/out/unknown breakdown. */
    classified?: TamClassified;
    /** max(estimate, inTam): the bottom-up count is a floor on the real universe. */
    reconciledUniverse?: number;
    /** inTam > the top-down estimate — the estimate was low; revise it UP. */
    bottomUpExceedsEstimate?: boolean;
};
/** Linear projection of when the universe is filled, from the coverage timeline. */
export type TamEta = {
    /** accounts added per day, measured across the timeline window. */
    accountsPerDay: number;
    accountsRemaining: number;
    daysRemaining: number;
    /** ISO date (YYYY-MM-DD) the account universe is projected to be covered. */
    etaDate: string;
    /** how the rate was measured — the timeline span used. */
    basis: string;
};
export type EstimateTamInput = {
    name: string;
    icpName: string;
    accounts: number;
    accountsSource: string;
    buyersPerAccount?: number;
    buyersSource?: string;
    targeting?: TamTargeting;
    acv: {
        basis?: AcvBasis;
        valueUsd: number;
        source?: string;
    };
    crossChecks?: TamCrossCheck[];
    baseline: TamCoverageCounts;
    createdAt: string;
};
export declare function estimateTam(input: EstimateTamInput): TamModel;
export type DerivedAcv = {
    valueUsd: number;
    dealCount: number;
    meanUsd: number;
};
/**
 * Derive a real ACV from the CRM's closed-won deals (median amount — robust to
 * outliers). Returns null when there are no usable won deals, so the caller can
 * refuse to fabricate a dollar TAM. The median is the headline; the mean is
 * surfaced too so a skewed pipeline is visible.
 */
export declare function deriveAcvFromClosedWon(snapshot: CanonicalGtmSnapshot): DerivedAcv | null;
export type DerivedBuyers = {
    value: number;
    accountsSampled: number;
};
/**
 * Derive buyers/account from the CRM: the average number of contacts on accounts
 * that have at least one. A real proxy for the buying group, vs. a hardcoded
 * guess. Returns null when no account has a contact.
 */
export declare function deriveBuyersPerAccount(snapshot: CanonicalGtmSnapshot): DerivedBuyers | null;
/**
 * Count what "fills" the TAM from a CRM snapshot: accounts that carry a domain
 * (real, signal-watchable records — a name-only stub doesn't count) and the
 * contacts at them. Coverage is measured against these, so a TAM you've started
 * filling reads truthfully even for accounts that pre-dated the campaign.
 */
export declare function coverageCountsFromSnapshot(snapshot: CanonicalGtmSnapshot): TamCoverageCounts;
export type AccountTamClass = "in" | "out" | "unknown";
/** The TAM criteria checkable from a CanonicalAccount — geo/technology are NOT on
 *  the record, so they need re-enrichment and are excluded here. */
export declare function crmCheckableCriteria(t: TamTargeting): string[];
/**
 * Classify one CRM account against the TAM ICP, using only CRM-checkable criteria
 * (size, industry). "out" if any criterion contradicts (wrong size/industry);
 * "in" if at least one passes and none contradict; "unknown" if nothing could be
 * evaluated (missing fields, or the TAM is defined only by geo/technology). Note:
 * geo + "uses a CRM" can't be confirmed from a CanonicalAccount, so an "in" here
 * means "matches what the CRM lets us check" — not a full technographic match.
 */
export declare function classifyAccount(account: CanonicalAccount, t: TamTargeting): AccountTamClass;
/**
 * Coverage that classifies CRM accounts against THIS TAM's ICP — so accounts
 * loaded from anywhere that DON'T match the target market (wrong size/industry)
 * land in out-of-TAM/unknown and never inflate coverage. Reconciles bottom-up vs
 * top-down: the in-TAM count is a FLOOR on the real universe (you've verified
 * those exist), so when it exceeds the estimate, the estimate was low.
 */
export declare function classifyCoverage(model: TamModel, snapshot: CanonicalGtmSnapshot, at: string): TamCoverage;
/** The covered-account count a coverage reading represents: in-TAM when
 *  classified, else the raw CRM count (legacy). Used for ETA + reconciliation. */
export declare function coveredAccounts(c: TamCoverage): number;
export declare function computeCoverage(model: TamModel, inCrm: TamCoverageCounts, at: string): TamCoverage;
/**
 * Project when the account universe is filled, from the coverage timeline. Uses
 * the first and last readings that show real movement. Returns null when there
 * isn't enough signal (fewer than two readings, no elapsed time, or a flat/
 * negative burn rate) — an honest "can't project yet" rather than a fake date.
 */
export declare function projectEta(model: TamModel, timeline: TamCoverage[]): TamEta | null;
/** `$FSGTM_HOME[/profiles/<profile>]/tam/<name>/`. */
export declare function tamDir(name: string): string;
export declare function saveTamModel(model: TamModel): string;
export declare function loadTamModel(name: string): TamModel | null;
/** Append a coverage reading to the TAM's append-only timeline (0600). */
export declare function appendCoverage(name: string, coverage: TamCoverage): void;
/** Read the TAM's coverage timeline; tolerant of partial/corrupt lines. */
export declare function readCoverageTimeline(name: string): TamCoverage[];
/** A compact human summary for `tam status`. */
export declare function coverageToText(model: TamModel, coverage: TamCoverage, eta: TamEta | null): string;
/** A client-ready markdown deliverable for `tam report`. */
export declare function tamReportToMarkdown(model: TamModel, timeline: TamCoverage[], eta: TamEta | null): string;
