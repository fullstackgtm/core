import { type LlmCallOptions } from "./llm.ts";
import { type Icp } from "./icp.ts";
import type { Signal, SignalBucket, SignalOutcome } from "./signals.ts";
import { computeWeights } from "./signals.ts";
import type { CanonicalGtmSnapshot } from "./types.ts";
/**
 * The judge layer: turn raw signals into a short ranked list of decisions on
 * `timing × fit × memory`. Every other layer answers "is this CRM record
 * correct?"; the judge answers "did something change at this account this week
 * worth reaching out *about*, to the right person, whom we haven't already
 * chased?" — and, crucially, says **no** when the answer is no.
 *
 * GOVERNANCE — structural, forever: judge is read-only. It reads signals + CRM
 * history and writes a ranked DECISION artifact to the LOCAL judge store; it
 * emits no `PatchOperation`, opens no plan, touches no provider record. `--save`
 * persists a `JudgeRun` and stamps the consumed signals `judgedBy`. The write
 * side is downstream and human-gated (`draft` → `plans approve` → `apply`).
 *
 * EVIDENCE GATE — structural: a decision's `whyNow` must be a verbatim
 * normalized-whitespace substring of a credited signal's stored `quote`. The
 * deterministic baseline takes the why-now verbatim from the top signal's quote
 * (so it is grounded by construction); the LLM path is gated after the call —
 * an ungrounded why-now is rejected (one retry, then fall back to the
 * deterministic why-now). The brain NEVER stores an ungrounded why-now.
 */
export type JudgeDecisionKind = "send" | "nurture" | "skip";
export type JudgeDecision = {
    accountDomain: string;
    /**
     * The CRM account this domain resolves to, when a snapshot was provided.
     * Absent = the account is not in the CRM (a net-new domain) — downstream
     * verbs must acquire it before they can write against it.
     */
    accountId?: string;
    /**
     * The contact at the account to reach, when resolvable from the snapshot —
     * the answer to "who do I message at this hot account". `draft` targets this
     * contact's id; absent contact + present accountId targets the account.
     */
    contact?: ContactRef;
    /**
     * All in-CRM contacts at the account (primary first), capped — so an agent can
     * multi-thread beyond the single primary. `contact` is `contacts[0]`.
     */
    contacts?: ContactRef[];
    /** 0-100. */
    score: number;
    decision: JudgeDecisionKind;
    /** MUST be a verbatim normalized-whitespace substring of a credited signal.quote. */
    whyNow: string;
    /** One line a rep could say (LLM), or "" (deterministic baseline). */
    play: string;
    /** Credited signal ids — the evidence anchors for this decision. */
    evidence: string[];
    skippedReason?: string;
    /** "deterministic" | "llm:<provider>:<model>". */
    producedBy: string;
};
export type JudgeRun = {
    id: string;
    runLabel: string;
    /** The signal run this judgement consumed. */
    signalRunLabel: string;
    createdAt: string;
    decisions: JudgeDecision[];
};
export type JudgeBand = "strong" | "good" | "weak" | "noise";
export declare function scoreBand(score: number): JudgeBand;
export declare function judgeRunId(runLabel: string): string;
/**
 * Whitespace/punctuation-spacing-normalized, lowercased match — the EXACT rule
 * `call`/`market` use for verbatim evidence gates (llm.ts normalizeSpan). A
 * local copy keeps this file importable without the LLM engine (the cross-module
 * duplication precedent in signals.ts/market.ts).
 */
export declare function normalizeSpan(value: string): string;
/** Verbatim evidence gate: `produced` must be a ≥12-char normalized substring of `source`. */
export declare function isGroundedSpan(produced: string, source: string): boolean;
export type AccountScore = {
    accountDomain: string;
    /** 0-100. */
    score: number;
    band: JudgeBand;
    decision: JudgeDecisionKind;
    /** The single highest-credited signal — the why-now anchor. */
    topSignal: Signal;
    /** All credited signal ids (the cluster). */
    evidence: string[];
    /** Raw 0..1 fit against the best-matching contact. */
    fit: number;
    /** Raw timing component (max bucket weight × recency [+cluster bonus]). */
    timing: number;
    /** True when the account was touched within the memory window (caps to nurture/skip). */
    recentlyTouched: boolean;
    skippedReason?: string;
    /**
     * Internal: every credited signal indexed by id, attached by `judgeSignals`
     * so the LLM path can resolve quotes beyond `topSignal`. Not part of the
     * stored artifact.
     */
    _signalsById?: Map<string, Signal>;
};
/**
 * Score one account on timing × fit × memory and map to a 0-100 score + band +
 * decision. Deterministic.
 *
 * - **timing**: each credited signal's bucket weight (learned overlay over
 *   config defaults via `computeWeights`) × recency decay × its already-baked
 *   repost boost; the account's timing is the MAX credited signal weight, plus a
 *   cluster bonus when ≥2 signals are fresh (the article's compounding "fresh
 *   round AND a live req" case → 80-100 band).
 * - **fit**: `scoreProspectAgainstIcp(bestContact, icp)` (0..1). No ICP / no
 *   contact → a neutral 0.5 so a strong, well-grounded timing signal can still
 *   surface (fit then doesn't sink an otherwise-hot account).
 * - **memory** (`recentlyTouched`): touched within `TOUCHED_WINDOW_DAYS` → never
 *   pile on: cap the decision at `nurture` (or `skip` if already lukewarm).
 *
 * `decision` from the band: strong→send, good→nurture, weak/noise→skip — then
 * the memory cap applies. `skip` is a first-class output: a lone low-intent
 * signal (e.g. a single `social` blip) lands in `weak`/`noise` and is skipped
 * with a reason, not mailed.
 */
export declare function scoreAccount(opts: {
    accountDomain: string;
    signals: Signal[];
    weights: Record<SignalBucket, number>;
    icp?: Icp;
    bestContact?: {
        jobTitle?: string;
        jobLevel?: string;
        jobDepartment?: string;
        headline?: string;
    };
    recentlyTouched?: boolean;
    now?: Date;
}): AccountScore;
/**
 * Has this account been touched within `TOUCHED_WINDOW_DAYS`? Reads the snapshot:
 * the account record's `lastActivityAt`, plus any `activities` whose `occurredAt`
 * is recent and that link to the account (directly or via a contact at it). Pure;
 * with no snapshot, returns false (the no-history path — caller passes `false`).
 */
export declare function accountRecentlyTouched(accountDomain: string, snapshot: CanonicalGtmSnapshot, now?: Date, windowDays?: number): boolean;
/**
 * Best-matching contact for an account, shaped for fit scoring (the title is
 * what `scoreProspectAgainstIcp` reads). Returns undefined when the
 * account/contact isn't in the snapshot.
 */
export declare function bestContactForAccount(accountDomain: string, snapshot: CanonicalGtmSnapshot): {
    jobTitle?: string;
    jobLevel?: string;
    jobDepartment?: string;
    headline?: string;
} | undefined;
/**
 * Resolve the CRM target for an account domain: its `accountId` (when the
 * account exists in the snapshot) and the best `contact` to reach (id + email +
 * title). This is what `draft` writes against — a real record id, never the
 * domain. `{}` when the account is not in the CRM (a net-new domain).
 */
export type ContactRef = {
    id: string;
    email?: string;
    title?: string;
};
export declare function resolveAccountTarget(accountDomain: string, snapshot: CanonicalGtmSnapshot): {
    accountId?: string;
    contact?: ContactRef;
    contacts?: ContactRef[];
};
/**
 * Build a `JudgeDecision` from an `AccountScore` with the deterministic baseline:
 * whyNow taken VERBATIM from the top credited signal's quote (grounded by
 * construction), no `play`, producedBy "deterministic".
 */
export declare function deterministicDecision(score: AccountScore): JudgeDecision;
/**
 * A grounded why-now drawn verbatim from the signal's quote — capped to a
 * sentence-ish span so it reads as a why-now, not the whole JD. We take the
 * leading clause up to the first sentence boundary (or the whole quote if
 * short), guaranteeing `isGroundedSpan(whyNow, quote)` holds.
 */
export declare function deterministicWhyNow(signal: Signal): string;
export declare const JUDGE_SCHEMA: {
    readonly type: "object";
    readonly required: readonly ["decision", "whyNow", "play"];
    readonly properties: {
        readonly decision: {
            readonly type: "string";
            readonly enum: readonly ["send", "nurture", "skip"];
        };
        readonly whyNow: {
            readonly type: "string";
            readonly description: string;
        };
        readonly play: {
            readonly type: "string";
            readonly description: "One line a rep could say out loud, grounded in the trigger. Max 25 words. No em dashes.";
        };
        readonly skippedReason: {
            readonly type: "string";
            readonly description: "skip only: one phrase why this is not a send.";
        };
    };
};
export declare const DEFAULT_JUDGE_PROMPT = "You are a GTM judge deciding whether to reach out to an account based on fresh signals.\nScore bands (the operator owns these \u2014 edit this prompt to change them):\n- 80-100 (send): strong fit AND high intent \u2014 a live demand search, fresh funding, or >=2 clustered signals.\n- 50-79 (nurture): good fit and one solid signal, but not enough to interrupt cold.\n- 20-49 (skip): a weak or lone low-intent signal.\n- 0-19 (skip): off-ICP or noise.\nRules:\n- whyNow MUST be a verbatim span copied from one of the signal quotes below. If you cannot ground a why-now in a real quote, you cannot send.\n- play is one line a rep could say out loud, tied to the trigger. No greeting, no \"Hi {{firstName}}\". No em dashes.\n- Saying \"skip\" is a first-class, valuable answer. A judge that skips a lukewarm account is doing its job.";
/**
 * The LLM judge for one account. Forced tool call with `JUDGE_SCHEMA` + an
 * editable prompt; then the verbatim-quote GATE: `whyNow` must be a normalized
 * ≥12-char substring of one of the credited signal quotes. Retry once with
 * corrective feedback (the market classify idiom), then fall back to the
 * deterministic why-now — NEVER store an ungrounded why-now. The deterministic
 * `score`/`band`/`decision`/`evidence` are authoritative; the model contributes
 * `whyNow` (gated) and `play` only — score is not delegated to the model.
 */
export declare function judgeDecisionLlm(score: AccountScore, promptTemplate: string, llm: LlmCallOptions): Promise<JudgeDecision>;
/**
 * Judge a batch of signals: group by account, score each, and produce one
 * decision per account (deterministic when no LLM options, gated-LLM otherwise).
 * `--min-score` filtering and the snapshot/ICP wiring happen in the caller; this
 * takes resolved inputs. Returns decisions sorted by score desc (the ranked list).
 */
export declare function judgeSignals(opts: {
    signals: Signal[];
    outcomes?: SignalOutcome[];
    config: Parameters<typeof computeWeights>[0];
    icp?: Icp;
    snapshot?: CanonicalGtmSnapshot;
    withHistory?: boolean;
    promptTemplate?: string;
    llm?: LlmCallOptions;
    now?: Date;
    /** Per-account progress (presentation only — a throwing callback never fails the run). */
    onAccount?: (done: number, total: number, domain: string) => void;
}): Promise<JudgeDecision[]>;
export declare function judgeDir(baseDir?: string): string;
export interface JudgeStore {
    /** Append a new judge run; refuses an existing label (runs are append-only). */
    appendRun(run: JudgeRun): Promise<JudgeRun>;
    getRun(runLabel: string): Promise<JudgeRun | null>;
    listRuns(): Promise<JudgeRun[]>;
    latestRun(): Promise<JudgeRun | null>;
}
export declare function createFileJudgeStore(directory?: string): JudgeStore;
