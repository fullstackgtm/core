import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { credentialsDir, ensureSecureHomeDir, writeSecureFile } from "./credentials.ts";
import { forcedToolCall, type LlmCallOptions } from "./llm.ts";
import { scoreProspectAgainstIcp, type Icp } from "./icp.ts";
import type { Signal, SignalBucket, SignalOutcome } from "./signals.ts";
import { computeWeights, normalizeAccountDomain } from "./signals.ts";
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

// ---------------------------------------------------------------------------
// Types

export type JudgeDecisionKind = "send" | "nurture" | "skip";

export type JudgeDecision = {
  accountDomain: string;
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

// ---------------------------------------------------------------------------
// Score bands (article rubric) — 80-100 / 50-79 / 20-49 / 0-19

export type JudgeBand = "strong" | "good" | "weak" | "noise";

export function scoreBand(score: number): JudgeBand {
  if (score >= 80) return "strong";
  if (score >= 50) return "good";
  if (score >= 20) return "weak";
  return "noise";
}

// ---------------------------------------------------------------------------
// Stable hashing (FNV-1a) — duplicated to keep this file importable without the
// audit engine (the signals.ts/market.ts/enrich.ts precedent).

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function judgeRunId(runLabel: string): string {
  return `jdg_${fnv1a(runLabel)}`;
}

/**
 * Whitespace/punctuation-spacing-normalized, lowercased match — the EXACT rule
 * `call`/`market` use for verbatim evidence gates (llm.ts normalizeSpan). A
 * local copy keeps this file importable without the LLM engine (the cross-module
 * duplication precedent in signals.ts/market.ts).
 */
export function normalizeSpan(value: string): string {
  return value
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Verbatim evidence gate: `produced` must be a ≥12-char normalized substring of `source`. */
export function isGroundedSpan(produced: string, source: string): boolean {
  const span = normalizeSpan(produced);
  if (span.length < 12) return false;
  return normalizeSpan(source).includes(span);
}

// ---------------------------------------------------------------------------
// Scoring: timing × fit × memory

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default freshness/clustering knobs. Editable via the deterministic scorer's opts. */
const RECENCY_FLOOR = 0.4;
const RECENCY_WINDOW_DAYS = 30;
/** Flat timing-norm boost when ≥2 fresh signals cluster (the "strong fit + high intent" band). */
const CLUSTER_BONUS = 0.25;
const FRESH_SIGNAL_DAYS = 14;
/** "Touched recently" memory window — pile-on guard. */
const TOUCHED_WINDOW_DAYS = 7;

function recencyFactor(firstSeen: string, now: Date, windowDays = RECENCY_WINDOW_DAYS): number {
  const seen = Date.parse(firstSeen);
  if (!Number.isFinite(seen)) return 1;
  const ageDays = Math.max(0, (now.getTime() - seen) / DAY_MS);
  if (windowDays <= 0) return 1;
  const decayed = 1 - (1 - RECENCY_FLOOR) * Math.min(1, ageDays / windowDays);
  return Math.max(RECENCY_FLOOR, decayed);
}

function isFresh(firstSeen: string, now: Date): boolean {
  const seen = Date.parse(firstSeen);
  if (!Number.isFinite(seen)) return false;
  return now.getTime() - seen <= FRESH_SIGNAL_DAYS * DAY_MS;
}

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
export function scoreAccount(opts: {
  accountDomain: string;
  signals: Signal[];
  weights: Record<SignalBucket, number>;
  icp?: Icp;
  bestContact?: { jobTitle?: string; jobLevel?: string; jobDepartment?: string; headline?: string };
  recentlyTouched?: boolean;
  now?: Date;
}): AccountScore {
  const now = opts.now ?? new Date();
  const domain = normalizeAccountDomain(opts.accountDomain);
  const signals = opts.signals.filter((s) => normalizeAccountDomain(s.accountDomain) === domain);
  if (signals.length === 0) {
    throw new Error(`scoreAccount: no signals for ${opts.accountDomain}`);
  }

  // Timing: per-signal effective weight = learned bucket weight × recency,
  // scaled by the signal's already-baked repost/recency weight ratio so the
  // store's repost boost still counts. The account's timing is the max.
  let topSignal = signals[0];
  let maxWeight = -Infinity;
  for (const signal of signals) {
    const bucketWeight = opts.weights[signal.bucket] ?? 0;
    const effective = bucketWeight * recencyFactor(signal.firstSeen, now) + repostBoostOf(signal);
    if (effective > maxWeight) {
      maxWeight = effective;
      topSignal = signal;
    }
  }
  const freshCount = signals.filter((s) => isFresh(s.firstSeen, now)).length;
  const isCluster = freshCount >= 2;
  const timing = Math.max(0, maxWeight);

  // Fit: best-matching contact vs ICP, neutral 0.5 when unknown so timing leads.
  const fit =
    opts.icp && opts.bestContact ? scoreProspectAgainstIcp(opts.bestContact, opts.icp).score : 0.5;

  // Map timing×fit to 0-100 along two axes (the article rubric):
  //  - timingNorm (0..1): timing relative to TIMING_REF (~a single strong-bucket
  //    fresh signal at funding/demand weight). A lone strong signal lands in the
  //    "good" band; a lone low-intent signal (social ≈ 0.4) stays weak/noise.
  //  - A fresh ≥2-signal CLUSTER adds a flat boost so "a fresh round AND a live
  //    req" reaches the 80-100 strong band — the rubric's compounding case.
  //  - fitMultiplier (0.7..1.0): fit SHAPES the score ±30% but never zeroes a
  //    well-timed account; unknown fit (0.5) sits in the middle at 0.85.
  const TIMING_REF = 2.0;
  let timingNorm = Math.min(1, timing / TIMING_REF);
  if (isCluster) timingNorm = Math.min(1, timingNorm + CLUSTER_BONUS);
  const fitMultiplier = 0.7 + 0.3 * fit;
  const raw = timingNorm * fitMultiplier;
  let score = Math.round(Math.max(0, Math.min(1, raw)) * 100);

  const band = scoreBand(score);
  let decision: JudgeDecisionKind = band === "strong" ? "send" : band === "good" ? "nurture" : "skip";
  let skippedReason: string | undefined;
  if (decision === "skip") {
    skippedReason =
      band === "noise"
        ? "off-ICP / low-intent noise — no fresh, in-persona trigger"
        : "weak lone signal — one low-intent trigger, not enough to reach out about";
  }

  // Memory cap: touched within the window → never pile on. send→nurture,
  // nurture→skip, skip stays skip.
  const recentlyTouched = Boolean(opts.recentlyTouched);
  if (recentlyTouched && decision !== "skip") {
    if (decision === "send") {
      decision = "nurture";
    } else {
      decision = "skip";
      skippedReason = `touched within ${TOUCHED_WINDOW_DAYS}d — already engaged; don't pile on`;
    }
    // Reflect the pile-on guard in the score so ranking de-prioritizes it, but
    // keep the band-decision mapping coherent for nurture (50-79).
    if (decision === "nurture" && score >= 80) score = 79;
  }

  // Evidence = the credited cluster (all signals on this account this run).
  const evidence = signals.map((s) => s.id);

  return {
    accountDomain: domain,
    score,
    band,
    decision,
    topSignal,
    evidence,
    fit: Number(fit.toFixed(3)),
    timing: Number(timing.toFixed(4)),
    recentlyTouched,
    ...(skippedReason !== undefined ? { skippedReason } : {}),
  };
}

/**
 * The repost boost already baked into a signal's stored weight, recovered as
 * weight − (weight without boost would be) — but since we don't have the
 * un-boosted weight here, we credit a small fixed bump only when the signal is
 * flagged `reposted`. Deterministic, additive, bounded.
 */
function repostBoostOf(signal: Signal): number {
  return signal.reposted ? 0.5 : 0;
}

// ---------------------------------------------------------------------------
// Memory: read account activity from the canonical snapshot

/**
 * Has this account been touched within `TOUCHED_WINDOW_DAYS`? Reads the snapshot:
 * the account record's `lastActivityAt`, plus any `activities` whose `occurredAt`
 * is recent and that link to the account (directly or via a contact at it). Pure;
 * with no snapshot, returns false (the no-history path — caller passes `false`).
 */
export function accountRecentlyTouched(
  accountDomain: string,
  snapshot: CanonicalGtmSnapshot,
  now: Date = new Date(),
  windowDays = TOUCHED_WINDOW_DAYS,
): boolean {
  const domain = normalizeAccountDomain(accountDomain);
  const cutoff = now.getTime() - windowDays * DAY_MS;

  const account = (snapshot.accounts ?? []).find(
    (a) => normalizeAccountDomain(a.domain ?? "") === domain && domain !== "",
  );
  if (account?.lastActivityAt) {
    const t = Date.parse(account.lastActivityAt);
    if (Number.isFinite(t) && t >= cutoff) return true;
  }
  if (!account) return false;

  const contactIds = new Set(
    (snapshot.contacts ?? []).filter((c) => c.accountId === account.id).map((c) => c.id),
  );
  for (const contact of snapshot.contacts ?? []) {
    if (contact.accountId !== account.id) continue;
    if (contact.lastActivityAt) {
      const t = Date.parse(contact.lastActivityAt);
      if (Number.isFinite(t) && t >= cutoff) return true;
    }
  }
  for (const activity of snapshot.activities ?? []) {
    const linked = activity.accountId === account.id || (activity.contactId && contactIds.has(activity.contactId));
    if (!linked) continue;
    const t = Date.parse(activity.occurredAt);
    if (Number.isFinite(t) && t >= cutoff) return true;
  }
  return false;
}

/**
 * Find the best-matching contact for an account from the snapshot, for fit
 * scoring: the account's contacts, preferring one with a title (a title is what
 * fit scores on). Returns undefined when the account/contact isn't in snapshot.
 */
export function bestContactForAccount(
  accountDomain: string,
  snapshot: CanonicalGtmSnapshot,
): { jobTitle?: string; jobLevel?: string; jobDepartment?: string; headline?: string } | undefined {
  const domain = normalizeAccountDomain(accountDomain);
  if (!domain) return undefined;
  const account = (snapshot.accounts ?? []).find((a) => normalizeAccountDomain(a.domain ?? "") === domain);
  if (!account) return undefined;
  const contacts = (snapshot.contacts ?? []).filter((c) => c.accountId === account.id);
  const withTitle = contacts.find((c) => c.title) ?? contacts[0];
  if (!withTitle) return undefined;
  return { jobTitle: withTitle.title };
}

// ---------------------------------------------------------------------------
// Deterministic baseline decision

/**
 * Build a `JudgeDecision` from an `AccountScore` with the deterministic baseline:
 * whyNow taken VERBATIM from the top credited signal's quote (grounded by
 * construction), no `play`, producedBy "deterministic".
 */
export function deterministicDecision(score: AccountScore): JudgeDecision {
  return {
    accountDomain: score.accountDomain,
    score: score.score,
    decision: score.decision,
    whyNow: deterministicWhyNow(score.topSignal),
    play: "",
    evidence: score.evidence,
    ...(score.skippedReason !== undefined ? { skippedReason: score.skippedReason } : {}),
    producedBy: "deterministic",
  };
}

/**
 * A grounded why-now drawn verbatim from the signal's quote — capped to a
 * sentence-ish span so it reads as a why-now, not the whole JD. We take the
 * leading clause up to the first sentence boundary (or the whole quote if
 * short), guaranteeing `isGroundedSpan(whyNow, quote)` holds.
 */
export function deterministicWhyNow(signal: Signal): string {
  const quote = signal.quote.trim();
  // First sentence/clause boundary; keep ≥12 chars so the gate passes.
  const match = quote.match(/^.{12,}?[.!?](\s|$)/);
  const candidate = match ? match[0].trim() : quote;
  // Cap length but only on a verbatim prefix (still a substring of the quote).
  const capped = candidate.length > 180 ? candidate.slice(0, 180).trimEnd() : candidate;
  // Guarantee groundedness against the full quote.
  return isGroundedSpan(capped, quote) ? capped : quote.slice(0, Math.max(12, Math.min(quote.length, 180)));
}

// ---------------------------------------------------------------------------
// LLM path: forced tool call + verbatim why-now gate, retry-once, then fall back

export const JUDGE_SCHEMA = {
  type: "object",
  required: ["decision", "whyNow", "play"],
  properties: {
    decision: { type: "string", enum: ["send", "nurture", "skip"] },
    whyNow: {
      type: "string",
      description:
        "The reason to reach out NOW, quoted VERBATIM from one of the provided signal quotes. " +
        "Copy a span character-for-character from a quote — never paraphrase, never invent. " +
        "If no quote supports a reach-out, set decision to skip and whyNow to the strongest quote span anyway.",
    },
    play: {
      type: "string",
      description: "One line a rep could say out loud, grounded in the trigger. Max 25 words. No em dashes.",
    },
    skippedReason: { type: "string", description: "skip only: one phrase why this is not a send." },
  },
} as const;

export const DEFAULT_JUDGE_PROMPT = `You are a GTM judge deciding whether to reach out to an account based on fresh signals.
Score bands (the operator owns these — edit this prompt to change them):
- 80-100 (send): strong fit AND high intent — a live demand search, fresh funding, or >=2 clustered signals.
- 50-79 (nurture): good fit and one solid signal, but not enough to interrupt cold.
- 20-49 (skip): a weak or lone low-intent signal.
- 0-19 (skip): off-ICP or noise.
Rules:
- whyNow MUST be a verbatim span copied from one of the signal quotes below. If you cannot ground a why-now in a real quote, you cannot send.
- play is one line a rep could say out loud, tied to the trigger. No greeting, no "Hi {{firstName}}". No em dashes.
- Saying "skip" is a first-class, valuable answer. A judge that skips a lukewarm account is doing its job.`;

type JudgeLlmResult = {
  decision?: JudgeDecisionKind;
  whyNow?: string;
  play?: string;
  skippedReason?: string;
};

/**
 * The LLM judge for one account. Forced tool call with `JUDGE_SCHEMA` + an
 * editable prompt; then the verbatim-quote GATE: `whyNow` must be a normalized
 * ≥12-char substring of one of the credited signal quotes. Retry once with
 * corrective feedback (the market classify idiom), then fall back to the
 * deterministic why-now — NEVER store an ungrounded why-now. The deterministic
 * `score`/`band`/`decision`/`evidence` are authoritative; the model contributes
 * `whyNow` (gated) and `play` only — score is not delegated to the model.
 */
export async function judgeDecisionLlm(
  score: AccountScore,
  promptTemplate: string,
  llm: LlmCallOptions,
): Promise<JudgeDecision> {
  const model = llm.model ?? "claude-haiku-4-5";
  const producedBy = `llm:${llm.provider}:${model}`;
  const quotes = score.evidence
    .map((id, i) => {
      const signal = findSignal(score, id);
      return signal ? `[${i + 1}] (${signal.bucket}) "${signal.quote}"` : null;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
  const basePrompt = `${promptTemplate}

Account: ${score.accountDomain}
Computed band: ${score.band} (score ${score.score}/100; fit ${score.fit}, timing ${score.timing}${
    score.recentlyTouched ? "; touched within 7 days — do not pile on" : ""
  })
Signal quotes (your whyNow must be a verbatim span of ONE of these):
${quotes}`;

  const attempt = async (feedback: string): Promise<JudgeDecision | null> => {
    const result = (await forcedToolCall(
      feedback ? `${basePrompt}\n${feedback}` : basePrompt,
      "judge_account",
      JUDGE_SCHEMA,
      model,
      llm,
    )) as JudgeLlmResult;
    const whyNow = (result.whyNow ?? "").trim();
    if (!grounded(score, whyNow)) return null; // gate failed
    return {
      accountDomain: score.accountDomain,
      // Score/band/decision stay deterministic; memory cap already applied.
      score: score.score,
      decision: score.decision,
      whyNow,
      play: sanitizePlay(result.play ?? ""),
      evidence: score.evidence,
      ...(score.skippedReason !== undefined ? { skippedReason: score.skippedReason } : {}),
      producedBy,
    };
  };

  const first = await attempt("");
  if (first) return first;
  const retried = await attempt(
    "\nYour previous whyNow was NOT a verbatim span of any signal quote. " +
      "Copy a span character-for-character from one of the quotes above and answer again in full.",
  );
  if (retried) return retried;

  // Both attempts ungrounded — fall back to the deterministic (grounded) why-now,
  // but keep the play empty (we won't ship an ungrounded play either).
  return {
    ...deterministicDecision(score),
    producedBy,
  };
}

function grounded(score: AccountScore, whyNow: string): boolean {
  for (const id of score.evidence) {
    const signal = findSignal(score, id);
    if (signal && isGroundedSpan(whyNow, signal.quote)) return true;
  }
  return false;
}

function findSignal(score: AccountScore, id: string): Signal | undefined {
  if (score.topSignal.id === id) return score.topSignal;
  return score._signalsById?.get(id);
}

/** Light play hygiene: strip em dashes (voice rule), collapse whitespace, cap length. */
function sanitizePlay(play: string): string {
  return play
    .replace(/—/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

// ---------------------------------------------------------------------------
// Orchestration: group signals by account → score → decide (det. or LLM)

/**
 * Judge a batch of signals: group by account, score each, and produce one
 * decision per account (deterministic when no LLM options, gated-LLM otherwise).
 * `--min-score` filtering and the snapshot/ICP wiring happen in the caller; this
 * takes resolved inputs. Returns decisions sorted by score desc (the ranked list).
 */
export async function judgeSignals(opts: {
  signals: Signal[];
  outcomes?: SignalOutcome[];
  config: Parameters<typeof computeWeights>[0];
  icp?: Icp;
  snapshot?: CanonicalGtmSnapshot;
  withHistory?: boolean;
  promptTemplate?: string;
  llm?: LlmCallOptions;
  now?: Date;
}): Promise<JudgeDecision[]> {
  const now = opts.now ?? new Date();
  const signalsById = new Map(opts.signals.map((s) => [s.id, s]));
  const weights = computeWeights(opts.config, opts.outcomes ?? [], signalsById);

  // Group signals by normalized account domain.
  const byAccount = new Map<string, Signal[]>();
  for (const signal of opts.signals) {
    const domain = normalizeAccountDomain(signal.accountDomain);
    if (!domain) continue;
    const list = byAccount.get(domain) ?? [];
    list.push(signal);
    byAccount.set(domain, list);
  }

  const decisions: JudgeDecision[] = [];
  for (const [domain, signals] of byAccount) {
    const recentlyTouched =
      opts.withHistory && opts.snapshot ? accountRecentlyTouched(domain, opts.snapshot, now) : false;
    const bestContact =
      opts.icp && opts.snapshot ? bestContactForAccount(domain, opts.snapshot) : undefined;
    const score = scoreAccount({
      accountDomain: domain,
      signals,
      weights,
      icp: opts.icp,
      bestContact,
      recentlyTouched,
      now,
    });
    // Attach the signal map so the LLM path can resolve credited quotes.
    score._signalsById = signalsById;
    const decision =
      opts.llm && opts.promptTemplate
        ? await judgeDecisionLlm(score, opts.promptTemplate, opts.llm)
        : deterministicDecision(score);
    decisions.push(decision);
  }

  return decisions.sort((a, b) => b.score - a.score || a.accountDomain.localeCompare(b.accountDomain));
}

// ---------------------------------------------------------------------------
// Store: per-label JSON judge runs, profile-scoped (mirrors the signal store).

export function judgeDir(baseDir?: string): string {
  return join(baseDir ?? credentialsDir(), "judge");
}

export interface JudgeStore {
  /** Append a new judge run; refuses an existing label (runs are append-only). */
  appendRun(run: JudgeRun): Promise<JudgeRun>;
  getRun(runLabel: string): Promise<JudgeRun | null>;
  listRuns(): Promise<JudgeRun[]>;
  latestRun(): Promise<JudgeRun | null>;
}

export function createFileJudgeStore(directory?: string): JudgeStore {
  const dir = directory ?? judgeDir();
  const runsDir = join(dir, "runs");

  function fileFor(runLabel: string): string {
    if (!/^[\w.-]+$/.test(runLabel)) throw new Error(`Invalid run label: ${runLabel}`);
    return join(runsDir, `${runLabel}.json`);
  }

  function read(runLabel: string): JudgeRun | null {
    try {
      return JSON.parse(readFileSync(fileFor(runLabel), "utf8")) as JudgeRun;
    } catch {
      return null;
    }
  }

  function write(run: JudgeRun): JudgeRun {
    // Run files carry account domains + verbatim source quotes; keep them
    // owner-only like plan/enrich/signal files.
    if (!directory) ensureSecureHomeDir();
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    writeSecureFile(fileFor(run.runLabel), `${JSON.stringify(run, null, 2)}\n`);
    return run;
  }

  function listRunsSync(): JudgeRun[] {
    let names: string[] = [];
    try {
      names = readdirSync(runsDir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .map((name) => read(name.slice(0, -".json".length)))
      .filter((run): run is JudgeRun => run !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  return {
    async appendRun(run) {
      if (read(run.runLabel)) {
        throw new Error(
          `Judge run "${run.runLabel}" already exists — runs are append-only; use a new run label`,
        );
      }
      return write(run);
    },
    async getRun(runLabel) {
      return read(runLabel);
    },
    async listRuns() {
      return listRunsSync();
    },
    async latestRun() {
      const runs = listRunsSync();
      return runs.length ? runs[runs.length - 1] : null;
    },
  };
}
