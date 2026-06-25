import type { AtsBoardSource, AtsJob } from "./connectors/atsBoards.ts";
/**
 * The signals layer: a deterministic, read-only timing ledger. Every other CLI
 * layer answers "is this CRM record correct?"; signals answers "did something
 * change at this account this week?" — the premise of signal-based outbound.
 *
 * `signals fetch` runs a watchlist of accounts through bucketed adapters (ATS
 * job boards are the free, no-auth example), captures each detected change as a
 * `Signal` carrying a VERBATIM source quote and URL, dedups against the store,
 * stamps `firstSeen`, and ranks by a learned-then-defaulted weight. Outcomes
 * feed back via `signals outcome`; `signals weights` drifts the bucket priors
 * toward what actually books meetings.
 *
 * GOVERNANCE — structural, forever: signals is Detect-side. It produces no
 * `PatchOperation`, opens no plan, touches no provider record. `fetch --save`
 * persists a `SignalRun` to the LOCAL signal store only; the write side is
 * downstream and human-gated (`draft` → `plans approve` → `apply`). State stays
 * local — the CLI never writes signal custom properties into the customer's
 * portal. Recurring execution is owned by the horizontal scheduler; signals
 * knows nothing about cron.
 */
export type SignalBucket = "demand" | "funding" | "job" | "company" | "social";
export declare const SIGNAL_BUCKETS: SignalBucket[];
export type Signal = {
    /** sig_<fnv1a(accountDomain|bucket|trigger)> — stable per detected change. */
    id: string;
    /** Normalized domain (strip protocol/www/path), matching enrich's key logic. */
    accountDomain: string;
    bucket: SignalBucket;
    /** Short human label, e.g. "reposted: Head of Growth" or "hiring: VP Sales". */
    trigger: string;
    /** VERBATIM source text — the evidence anchor reused by judge/drafter. */
    quote: string;
    sourceUrl: string;
    /** ISO 8601. */
    firstSeen: string;
    /** Bucket weight × recency × repost boost, computed at fetch. */
    weight: number;
    reposted?: boolean;
    /** "greenhouse" | "lever" | "ashby" | "ingest". */
    source: string;
    /** judge runLabel that consumed this signal (null until judged). */
    judgedBy?: string | null;
    /**
     * Stable per-role identity within a board (provider id when present, else the
     * title). Lets the reposted heuristic tell "same role, gone, back" (a new req
     * id under the same title) from one continuously-open req. job-bucket only.
     */
    roleKey?: string;
};
export type SignalOutcomeResult = "replied" | "meeting" | "bounced" | "no_reply";
export type SignalOutcome = {
    id: string;
    accountDomain: string;
    touchId?: string;
    /** The contact the touch went to (from the judge decision), when known — so an
     *  outcome credits the person reached, not just the account domain. */
    contactId?: string;
    result: SignalOutcomeResult;
    recordedAt: string;
    /** Signal ids credited (from the judge decision). */
    creditedSignals: string[];
};
export type SignalBucketConfig = {
    sources: string[];
    keywords?: string[];
    weight: number;
};
export type SignalsConfig = {
    watchlist: {
        /** "crm:<segment>" derives domains from a CRM segment at run time. */
        source?: string;
        domains?: string[];
        /** domain -> ATS board token, for boards not resolvable from the domain. */
        boards?: Record<string, string>;
    };
    buckets: Record<SignalBucket, SignalBucketConfig>;
    /** Dedup + reposted-detection window. Default 30. */
    dedupWindowDays: number;
    /** Extra weight for a reposted role (the "first hire fell through" heuristic). */
    repostedRoleBoost: number;
};
/**
 * Zero-config preset. `signals fetch` works with no `signals.config.json`
 * (preset-first, like enrich). The four free buckets carry the system; `demand`
 * is schema-reserved (privileged source, unbuilt) so its `sources` stay empty.
 */
export declare const DEFAULT_SIGNALS_CONFIG: SignalsConfig;
export declare function normalizeAccountDomain(value: string | undefined | null): string;
/** Dedup key: a signal is "the same change" iff (account, bucket, trigger) match. */
export declare function dedupKey(signal: Pick<Signal, "accountDomain" | "bucket" | "trigger">): string;
export declare function signalId(signal: Pick<Signal, "accountDomain" | "bucket" | "trigger">): string;
export declare function parseSignalsConfig(raw: string): SignalsConfig;
export declare const SIGNALS_CONFIG_FILE_NAME = "signals.config.json";
export declare function loadSignalsConfig(path: string): SignalsConfig;
/**
 * Recency decay over the dedup window: a signal seen today is 1.0; one at the
 * window edge is ~`floor`. Linear, clamped, deterministic — no surprise from
 * an exponential's tail. Older than the window → `floor`.
 */
export declare function recencyFactor(firstSeen: string, now: Date, windowDays: number): number;
/**
 * Final signal weight = bucketWeight × recency (+ repost boost when reposted).
 * Rounded to 4 dp so the same inputs always serialize the same string (the
 * deterministic-store property the tests and dedup ledger rely on).
 */
export declare function signalWeight(opts: {
    bucketWeight: number;
    firstSeen: string;
    now: Date;
    windowDays: number;
    reposted?: boolean;
    repostedRoleBoost: number;
}): number;
/**
 * Map a board's open roles to `job` signals for one account, computing weights
 * and applying the reposted heuristic against `priorSignals` (the store's prior
 * job signals for this account). A role is REPOSTED when the store saw a
 * same-title job signal inside `dedupWindowDays` under a DIFFERENT role id (the
 * old req closed, a new req opened with the same title) — the "first hire fell
 * through, more pain now" signal the article calls out.
 *
 * A role only becomes a signal if its quote can carry a configured keyword
 * verbatim (the evidence anchor). With no keywords configured, every open role
 * qualifies and the quote is title + leading JD snippet.
 */
export declare function buildSignalsFromAts(rawJobs: Array<AtsJob & {
    source: AtsBoardSource;
}>, account: {
    domain: string;
}, config: SignalsConfig, opts?: {
    now?: Date;
    priorSignals?: Signal[];
}): Signal[];
/**
 * Split candidate signals into fresh vs. deduped against prior signals. A
 * candidate is deduped when a prior signal shares its `dedupKey`
 * (account|bucket|trigger) AND that prior was seen inside `windowDays` — the
 * store's dedup ledger role. A reposted role carries a DIFFERENT trigger
 * ("reposted: X" vs "hiring: X"), so it is correctly fresh. Deterministic.
 */
export declare function dedupeSignals(candidates: Signal[], priorSignals: Signal[], windowDays: number, now: Date): {
    fresh: Signal[];
    deduped: Signal[];
};
/**
 * Recompute a per-bucket weight multiplier from the outcome ledger: the
 * booked-meeting rate of touches credited to each bucket, Beta-smoothed against
 * the declared default so a single reply does not swing a bucket. With NO
 * outcomes, weights == config defaults (graceful cold start). Deterministic:
 * same ledger → same weights.
 *
 * Mechanic: a bucket's declared default `w` acts as the prior mean. We observe
 * `booked` booked meetings out of `total` credited touches and form a
 * Beta(α,β)-style posterior mean with prior strength `priorStrength`, then scale
 * the default by (posteriorRate / priorRate). priorRate is a fixed baseline
 * booked-rate the default is calibrated against, so a bucket that books above
 * baseline gets heavier and one that dies gets cut — the config value is never
 * overwritten, only this overlay moves.
 */
export declare function computeWeights(config: SignalsConfig, outcomes: SignalOutcome[], signalsById?: Map<string, Signal>): Record<SignalBucket, number>;
export declare function signalsDir(baseDir?: string): string;
export type SignalRun = {
    id: string;
    runLabel: string;
    startedAt: string;
    completedAt: string | null;
    /** Buckets the run scanned. */
    buckets: SignalBucket[];
    counts: {
        fetched: number;
        new: number;
        deduped: number;
    };
    signals: Signal[];
};
export declare function signalRunId(runLabel: string): string;
export interface SignalStore {
    /** Append a new run; refuses an existing label (runs are append-only). */
    appendRun(run: SignalRun): Promise<SignalRun>;
    /** Update an existing run in place (e.g. stamp judgedBy); id must match. */
    updateRun(run: SignalRun): Promise<SignalRun>;
    getRun(runLabel: string): Promise<SignalRun | null>;
    listRuns(): Promise<SignalRun[]>;
    latestRun(): Promise<SignalRun | null>;
    /** Append-only outcome ledger (outcomes.jsonl). */
    appendOutcome(outcome: SignalOutcome): Promise<SignalOutcome>;
    listOutcomes(): Promise<SignalOutcome[]>;
    /** Every signal across all runs, newest run last (the timing source). */
    allSignals(): Promise<Signal[]>;
}
export declare function createFileSignalStore(directory?: string): SignalStore;
/** Construct a SignalOutcome with a stable id and a recordedAt stamp. */
export declare function makeOutcome(input: {
    accountDomain: string;
    touchId?: string;
    contactId?: string;
    result: SignalOutcomeResult;
    creditedSignals?: string[];
    recordedAt?: string;
}): SignalOutcome;
