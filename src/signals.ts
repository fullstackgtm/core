import { mkdirSync, readFileSync, readdirSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { credentialsDir, ensureSecureHomeDir, writeSecureFile } from "./credentials.ts";
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

// ---------------------------------------------------------------------------
// Types

export type SignalBucket = "demand" | "funding" | "job" | "company" | "social";

export const SIGNAL_BUCKETS: SignalBucket[] = ["demand", "funding", "job", "company", "social"];

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
export const DEFAULT_SIGNALS_CONFIG: SignalsConfig = {
  watchlist: {},
  buckets: {
    demand: { sources: [], weight: 2.0 },
    funding: { sources: ["news"], weight: 1.6 },
    job: { sources: ["greenhouse", "lever", "ashby"], keywords: [], weight: 1.0 },
    company: { sources: ["web"], weight: 1.0 },
    social: { sources: ["web"], weight: 0.4 },
  },
  dedupWindowDays: 30,
  repostedRoleBoost: 0.5,
};

// ---------------------------------------------------------------------------
// Domain normalization — mirrors enrich's normalizeKeyValue("domain", ...)
// (strip protocol/www/path, lowercased) so a signal account key lines up with
// the canonical snapshot / enrich matcher.

export function normalizeAccountDomain(value: string | undefined | null): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "";
  return text
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

// ---------------------------------------------------------------------------
// Stable hashing (FNV-1a) — mirrors enrich.ts fnv1a, duplicated to keep this
// file importable without the audit engine (the market.ts/enrich.ts precedent).

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Dedup key: a signal is "the same change" iff (account, bucket, trigger) match. */
export function dedupKey(signal: Pick<Signal, "accountDomain" | "bucket" | "trigger">): string {
  return `${signal.accountDomain}|${signal.bucket}|${signal.trigger}`;
}

export function signalId(signal: Pick<Signal, "accountDomain" | "bucket" | "trigger">): string {
  return `sig_${fnv1a(dedupKey(signal))}`;
}

function outcomeId(o: Pick<SignalOutcome, "accountDomain" | "touchId" | "result" | "recordedAt">): string {
  return `out_${fnv1a(`${o.accountDomain}|${o.touchId ?? ""}|${o.result}|${o.recordedAt}`)}`;
}

// ---------------------------------------------------------------------------
// Config parsing — strict, up-front, names the offending entry (enrich pattern).

function fail(message: string): never {
  throw new Error(`signals config: ${message}`);
}

export function parseSignalsConfig(raw: string): SignalsConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("expected a JSON object with watchlist, buckets, dedupWindowDays, repostedRoleBoost");
  }
  const config = parsed as Partial<SignalsConfig>;

  // watchlist
  const watchlist = config.watchlist ?? {};
  if (typeof watchlist !== "object" || Array.isArray(watchlist)) {
    fail('"watchlist" must be an object (source / domains / boards)');
  }
  if (watchlist.source !== undefined && typeof watchlist.source !== "string") {
    fail('watchlist.source must be a string (e.g. "crm:open-pipeline")');
  }
  if (watchlist.domains !== undefined) {
    if (!Array.isArray(watchlist.domains) || watchlist.domains.some((d) => typeof d !== "string")) {
      fail("watchlist.domains must be an array of domain strings");
    }
  }
  if (watchlist.boards !== undefined) {
    if (typeof watchlist.boards !== "object" || Array.isArray(watchlist.boards)) {
      fail("watchlist.boards must be an object mapping domain -> board token");
    }
    for (const [domain, tok] of Object.entries(watchlist.boards)) {
      if (typeof tok !== "string" || !tok) fail(`watchlist.boards["${domain}"] must be a non-empty board token`);
    }
  }

  // buckets — fill missing buckets from the default so a partial config is valid.
  const buckets = {} as Record<SignalBucket, SignalBucketConfig>;
  const rawBuckets = (config.buckets ?? {}) as Partial<Record<SignalBucket, unknown>>;
  if (typeof rawBuckets !== "object" || Array.isArray(rawBuckets)) {
    fail('"buckets" must be an object keyed by bucket name');
  }
  for (const key of Object.keys(rawBuckets)) {
    if (!SIGNAL_BUCKETS.includes(key as SignalBucket)) {
      fail(`unknown bucket "${key}" (use: ${SIGNAL_BUCKETS.join(", ")})`);
    }
  }
  for (const bucket of SIGNAL_BUCKETS) {
    const provided = rawBuckets[bucket] as Partial<SignalBucketConfig> | undefined;
    if (provided === undefined) {
      buckets[bucket] = { ...DEFAULT_SIGNALS_CONFIG.buckets[bucket] };
      continue;
    }
    if (typeof provided !== "object" || Array.isArray(provided)) fail(`buckets.${bucket} must be an object`);
    if (!Array.isArray(provided.sources) || provided.sources.some((s) => typeof s !== "string")) {
      fail(`buckets.${bucket}.sources must be an array of source strings`);
    }
    if (provided.weight !== undefined && (!Number.isFinite(provided.weight) || provided.weight < 0)) {
      fail(`buckets.${bucket}.weight must be a non-negative number`);
    }
    if (provided.keywords !== undefined) {
      if (!Array.isArray(provided.keywords) || provided.keywords.some((k) => typeof k !== "string")) {
        fail(`buckets.${bucket}.keywords must be an array of strings`);
      }
    }
    buckets[bucket] = {
      sources: provided.sources,
      weight: provided.weight ?? DEFAULT_SIGNALS_CONFIG.buckets[bucket].weight,
      ...(provided.keywords !== undefined ? { keywords: provided.keywords } : {}),
    };
  }

  const dedupWindowDays = config.dedupWindowDays ?? DEFAULT_SIGNALS_CONFIG.dedupWindowDays;
  if (!Number.isFinite(dedupWindowDays) || dedupWindowDays <= 0) {
    fail(`dedupWindowDays must be a positive number (got ${JSON.stringify(config.dedupWindowDays)})`);
  }
  const repostedRoleBoost = config.repostedRoleBoost ?? DEFAULT_SIGNALS_CONFIG.repostedRoleBoost;
  if (!Number.isFinite(repostedRoleBoost) || repostedRoleBoost < 0) {
    fail(`repostedRoleBoost must be a non-negative number (got ${JSON.stringify(config.repostedRoleBoost)})`);
  }

  return {
    watchlist: {
      ...(watchlist.source !== undefined ? { source: watchlist.source } : {}),
      ...(watchlist.domains !== undefined ? { domains: watchlist.domains } : {}),
      ...(watchlist.boards !== undefined ? { boards: watchlist.boards } : {}),
    },
    buckets,
    dedupWindowDays,
    repostedRoleBoost,
  };
}

export const SIGNALS_CONFIG_FILE_NAME = "signals.config.json";

export function loadSignalsConfig(path: string): SignalsConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `No signals config at ${path}. Create ${SIGNALS_CONFIG_FILE_NAME} (watchlist/buckets/` +
        "dedupWindowDays/repostedRoleBoost — see docs/signals.md) or run with the zero-config defaults.",
    );
  }
  return parseSignalsConfig(raw);
}

// ---------------------------------------------------------------------------
// Recency + weight

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Recency decay over the dedup window: a signal seen today is 1.0; one at the
 * window edge is ~`floor`. Linear, clamped, deterministic — no surprise from
 * an exponential's tail. Older than the window → `floor`.
 */
export function recencyFactor(firstSeen: string, now: Date, windowDays: number): number {
  const seen = Date.parse(firstSeen);
  if (!Number.isFinite(seen)) return 1;
  const ageDays = Math.max(0, (now.getTime() - seen) / DAY_MS);
  const floor = 0.4;
  if (windowDays <= 0) return 1;
  const decayed = 1 - (1 - floor) * Math.min(1, ageDays / windowDays);
  return Math.max(floor, decayed);
}

/**
 * Final signal weight = bucketWeight × recency (+ repost boost when reposted).
 * Rounded to 4 dp so the same inputs always serialize the same string (the
 * deterministic-store property the tests and dedup ledger rely on).
 */
export function signalWeight(opts: {
  bucketWeight: number;
  firstSeen: string;
  now: Date;
  windowDays: number;
  reposted?: boolean;
  repostedRoleBoost: number;
}): number {
  const base = opts.bucketWeight * recencyFactor(opts.firstSeen, opts.now, opts.windowDays);
  const boosted = opts.reposted ? base + opts.repostedRoleBoost : base;
  return Math.round(boosted * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Build signals from ATS jobs

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
export function buildSignalsFromAts(
  rawJobs: Array<AtsJob & { source: AtsBoardSource }>,
  account: { domain: string },
  config: SignalsConfig,
  opts: { now?: Date; priorSignals?: Signal[] } = {},
): Signal[] {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const windowDays = config.dedupWindowDays;
  const bucketWeight = config.buckets.job.weight;
  const keywords = config.buckets.job.keywords ?? [];
  const accountDomain = normalizeAccountDomain(account.domain);

  // Prior same-title job signals (within window) indexed by title key, with the
  // set of role ids seen — a different role id under a known title = reposted.
  const priorByTitle = new Map<string, { roleKeys: Set<string>; withinWindow: boolean }>();
  for (const prior of opts.priorSignals ?? []) {
    if (prior.bucket !== "job" || prior.accountDomain !== accountDomain) continue;
    const titleKey = roleTitleKey(prior.trigger);
    const entry = priorByTitle.get(titleKey) ?? { roleKeys: new Set<string>(), withinWindow: false };
    if (prior.roleKey) entry.roleKeys.add(prior.roleKey);
    if (withinWindow(prior.firstSeen, now, windowDays)) entry.withinWindow = true;
    priorByTitle.set(titleKey, entry);
  }

  const signals: Signal[] = [];
  for (const job of rawJobs) {
    const title = job.title.trim();
    if (!title) continue;
    // Quote must carry a configured keyword verbatim; with no keywords, any role
    // qualifies. Reject a role whose JD contains none of the keywords — the
    // judge/drafter could not ground a why-now on it.
    const quote = jobQuote(title, job.jdSnippet, keywords);
    if (quote === null) continue;

    const titleKey = roleTitleKey(title);
    const prior = priorByTitle.get(titleKey);
    const reposted = Boolean(
      prior && prior.withinWindow && job.firstSeenKey != null && !prior.roleKeys.has(job.firstSeenKey),
    );
    const trigger = reposted ? `reposted: ${title}` : `hiring: ${title}`;
    const base = { accountDomain, bucket: "job" as const, trigger };
    signals.push({
      id: signalId(base),
      accountDomain,
      bucket: "job",
      trigger,
      quote,
      sourceUrl: job.url,
      firstSeen: nowIso,
      weight: signalWeight({
        bucketWeight,
        firstSeen: nowIso,
        now,
        windowDays,
        reposted,
        repostedRoleBoost: config.repostedRoleBoost,
      }),
      ...(reposted ? { reposted: true } : {}),
      source: job.source,
      judgedBy: null,
      roleKey: job.firstSeenKey,
    });
  }
  return signals;
}

/** Normalize a role title for same-role matching (collapse spacing, lowercase). */
function roleTitleKey(triggerOrTitle: string): string {
  return triggerOrTitle
    .replace(/^(reposted|hiring):\s*/i, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Build the verbatim evidence quote for a job signal. The keyword (if any) must
 * appear verbatim in the title or JD snippet; returns null when keywords are
 * configured but none match (so the role is dropped, not faked).
 */
function jobQuote(title: string, jdSnippet: string, keywords: string[]): string | null {
  const snippet = jdSnippet.trim();
  const composed = snippet ? `${title} — ${snippet}` : title;
  const active = keywords.map((k) => k.trim()).filter(Boolean);
  if (active.length === 0) return composed;
  const hay = composed.toLowerCase();
  const matched = active.some((k) => hay.includes(k.toLowerCase()));
  return matched ? composed : null;
}

function withinWindow(iso: string, now: Date, windowDays: number): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t <= windowDays * DAY_MS;
}

// ---------------------------------------------------------------------------
// Staged rows -> signals (shared by `--from` ingest and source connectors)

/**
 * One staged signal row: the platform-agnostic intake shape every NON-job source
 * produces (a source connector's output, or a `--from` JSON row). It carries the
 * evidence anchor (`quote`) but none of the derived fields (`id`, `weight`,
 * `source`) — `stagedRowToSignal` fills those so there is ONE place that gates
 * evidence and stamps identity, whether the row came from a file or an API.
 */
export type StagedSignalRow = {
  bucket: SignalBucket;
  accountDomain: string;
  trigger: string;
  /** VERBATIM evidence — required, non-empty. */
  quote: string;
  sourceUrl?: string;
  /** ISO 8601; defaults to run time when absent. */
  firstSeen?: string;
  /** Optional explicit weight; defaults to the bucket's configured weight. */
  weight?: number;
};

/**
 * Validate one loosely-typed staged row and turn it into a `Signal`, applying
 * the verbatim-evidence gate (a row with no quote is rejected, never faked) and
 * the same id/normalization logic the ATS path uses. `errorLabel` lets the
 * caller produce a precise message ("--from f.json: row 3", "serpapi-news row 0")
 * since both the `--from` ingest and the source-connector registry funnel here.
 *
 * Throws on a malformed row; returns the canonical `Signal` on success. Bucket
 * FILTERING (skip rows outside a `--bucket` selection) stays with the caller —
 * this function is per-row validation only.
 */
export function stagedRowToSignal(
  entry: Record<string, unknown>,
  opts: { now: Date; source: string; errorLabel: string },
): Signal {
  const { now, source, errorLabel } = opts;
  const bucket = String(entry.bucket ?? "");
  if (!SIGNAL_BUCKETS.includes(bucket as SignalBucket)) {
    throw new Error(`${errorLabel} has unknown bucket "${bucket}" (one of ${SIGNAL_BUCKETS.join(", ")}).`);
  }
  const accountDomain = normalizeAccountDomain(String(entry.accountDomain ?? entry.domain ?? ""));
  if (!accountDomain) throw new Error(`${errorLabel} is missing accountDomain.`);
  const trigger = String(entry.trigger ?? "").trim();
  if (!trigger) throw new Error(`${errorLabel} is missing trigger.`);
  const quote = String(entry.quote ?? "").trim();
  if (!quote) throw new Error(`${errorLabel} is missing the verbatim quote (the evidence anchor).`);
  const base = { accountDomain, bucket: bucket as SignalBucket, trigger };
  const firstSeen = typeof entry.firstSeen === "string" && entry.firstSeen ? entry.firstSeen : now.toISOString();
  return {
    id: signalId(base),
    accountDomain,
    bucket: bucket as SignalBucket,
    trigger,
    quote,
    sourceUrl: String(entry.sourceUrl ?? ""),
    firstSeen,
    weight: typeof entry.weight === "number" ? entry.weight : DEFAULT_SIGNALS_CONFIG.buckets[bucket as SignalBucket].weight,
    source,
    judgedBy: null,
  };
}

// ---------------------------------------------------------------------------
// Dedup

/**
 * Split candidate signals into fresh vs. deduped against prior signals. A
 * candidate is deduped when a prior signal shares its `dedupKey`
 * (account|bucket|trigger) AND that prior was seen inside `windowDays` — the
 * store's dedup ledger role. A reposted role carries a DIFFERENT trigger
 * ("reposted: X" vs "hiring: X"), so it is correctly fresh. Deterministic.
 */
export function dedupeSignals(
  candidates: Signal[],
  priorSignals: Signal[],
  windowDays: number,
  now: Date,
): { fresh: Signal[]; deduped: Signal[] } {
  const recentKeys = new Set<string>();
  for (const prior of priorSignals) {
    if (withinWindow(prior.firstSeen, now, windowDays)) recentKeys.add(dedupKey(prior));
  }
  const fresh: Signal[] = [];
  const deduped: Signal[] = [];
  const seenThisRun = new Set<string>();
  for (const candidate of candidates) {
    const key = dedupKey(candidate);
    if (recentKeys.has(key) || seenThisRun.has(key)) {
      deduped.push(candidate);
      continue;
    }
    seenThisRun.add(key);
    fresh.push(candidate);
  }
  return { fresh, deduped };
}

// ---------------------------------------------------------------------------
// Learn loop: bucket weights from outcomes (Beta-smoothed booked-meeting rate)

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
export function computeWeights(
  config: SignalsConfig,
  outcomes: SignalOutcome[],
  signalsById?: Map<string, Signal>,
): Record<SignalBucket, number> {
  const PRIOR_STRENGTH = 4; // pseudo-touches; damps small samples
  const PRIOR_RATE = 0.2; // baseline booked-meeting rate the defaults assume

  // Per-bucket booked / total over credited touches. A touch books if its
  // result is "meeting". Credit flows to the bucket of each credited signal.
  const booked: Record<SignalBucket, number> = blankCounts();
  const total: Record<SignalBucket, number> = blankCounts();
  for (const outcome of outcomes) {
    const buckets = creditedBuckets(outcome, signalsById);
    const isBooked = outcome.result === "meeting" ? 1 : 0;
    for (const bucket of buckets) {
      total[bucket] += 1;
      booked[bucket] += isBooked;
    }
  }

  const weights = {} as Record<SignalBucket, number>;
  for (const bucket of SIGNAL_BUCKETS) {
    const declared = config.buckets[bucket].weight;
    const n = total[bucket];
    if (n === 0) {
      weights[bucket] = declared; // cold start: exactly the declared default
      continue;
    }
    const posteriorRate =
      (booked[bucket] + PRIOR_STRENGTH * PRIOR_RATE) / (n + PRIOR_STRENGTH);
    const scaled = declared * (posteriorRate / PRIOR_RATE);
    weights[bucket] = Math.round(scaled * 10000) / 10000;
  }
  return weights;
}

/**
 * Which buckets an outcome credits. When the credited signal objects are known
 * (`signalsById`), use their real buckets; otherwise fall back to parsing the
 * `sig_` ids' bucket is not recoverable, so credit nothing (the cold-start /
 * unknown path leaves weights at defaults rather than mis-crediting).
 */
function creditedBuckets(outcome: SignalOutcome, signalsById?: Map<string, Signal>): SignalBucket[] {
  if (!signalsById) return [];
  const buckets = new Set<SignalBucket>();
  for (const id of outcome.creditedSignals) {
    const signal = signalsById.get(id);
    if (signal) buckets.add(signal.bucket);
  }
  return [...buckets];
}

function blankCounts(): Record<SignalBucket, number> {
  return { demand: 0, funding: 0, job: 0, company: 0, social: 0 };
}

// ---------------------------------------------------------------------------
// Store: per-label JSON runs + append-only outcomes.jsonl, profile-scoped.

export function signalsDir(baseDir?: string): string {
  return join(baseDir ?? credentialsDir(), "signals");
}

/**
 * Conventional webhook landing zone: `<signals>/spool`, profile-scoped. A
 * webhook receiver (hosted, or the operator's own glue) appends one JSONL row
 * per event to a `*.jsonl` file here; `signals fetch --connector file` reads the
 * whole directory when given no explicit path. The CLI never writes here — the
 * receiver does — so this is just the agreed-upon location, not a managed store.
 * Per-source files (`rb2b.jsonl`, `hubspot.jsonl`, …) coexist. See
 * docs/signal-spool-format.md.
 */
export function signalsSpoolDir(baseDir?: string): string {
  return join(signalsDir(baseDir), "spool");
}

/**
 * Conventional outbox: `<signals>/outbox`, profile-scoped — the SEND-side mirror
 * of the spool. `apply --channel outbox` renders each APPROVED drafted opener to
 * a `<channel>.jsonl` file here (one row per touch); a downstream sender (hosted,
 * or the operator's own) drains it. The CLI WRITES governed, approved send
 * intents here but TRANSMITS NOTHING — the "drafts everything, transmits nothing"
 * invariant holds. See docs/outbox-format.md.
 */
export function signalsOutboxDir(baseDir?: string): string {
  return join(signalsDir(baseDir), "outbox");
}

export type SignalRun = {
  id: string;
  runLabel: string;
  startedAt: string;
  completedAt: string | null;
  /** Buckets the run scanned. */
  buckets: SignalBucket[];
  counts: { fetched: number; new: number; deduped: number };
  signals: Signal[];
};

export function signalRunId(runLabel: string): string {
  return `sigr_${fnv1a(runLabel)}`;
}

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

export function createFileSignalStore(directory?: string): SignalStore {
  const dir = directory ?? signalsDir();
  const runsDir = join(dir, "runs");
  const outcomesPath = join(dir, "outcomes.jsonl");

  function fileFor(runLabel: string): string {
    if (!/^[\w.-]+$/.test(runLabel)) throw new Error(`Invalid run label: ${runLabel}`);
    return join(runsDir, `${runLabel}.json`);
  }

  function read(runLabel: string): SignalRun | null {
    try {
      return JSON.parse(readFileSync(fileFor(runLabel), "utf8")) as SignalRun;
    } catch {
      return null;
    }
  }

  function write(run: SignalRun): SignalRun {
    // Run files carry account domains + source quotes/URLs; keep them owner-only
    // like plan/enrich files (and lock the home down even before any login).
    if (!directory) ensureSecureHomeDir();
    mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    writeSecureFile(fileFor(run.runLabel), `${JSON.stringify(run, null, 2)}\n`);
    return run;
  }

  function listRunsSync(): SignalRun[] {
    let names: string[] = [];
    try {
      names = readdirSync(runsDir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .map((name) => read(name.slice(0, -".json".length)))
      .filter((run): run is SignalRun => run !== null)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  function readOutcomes(): SignalOutcome[] {
    let raw: string;
    try {
      raw = readFileSync(outcomesPath, "utf8");
    } catch {
      return [];
    }
    const out: SignalOutcome[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as SignalOutcome);
      } catch {
        // Skip a corrupt line rather than fail the whole ledger read.
      }
    }
    return out;
  }

  return {
    async appendRun(run) {
      if (read(run.runLabel)) {
        throw new Error(
          `Signal run "${run.runLabel}" already exists — runs are append-only; use a new run label`,
        );
      }
      return write(run);
    },
    async updateRun(run) {
      const existing = read(run.runLabel);
      if (!existing) throw new Error(`No signal run "${run.runLabel}" to update`);
      if (existing.id !== run.id) {
        throw new Error(`Signal run "${run.runLabel}" belongs to a different run id (${existing.id})`);
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
    async appendOutcome(outcome) {
      if (!directory) ensureSecureHomeDir();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Append-only ledger: one JSON object per line, never rewritten.
      if (!existsSync(outcomesPath)) writeSecureFile(outcomesPath, "");
      appendFileSync(outcomesPath, `${JSON.stringify(outcome)}\n`, { mode: 0o600 });
      return outcome;
    },
    async listOutcomes() {
      return readOutcomes();
    },
    async allSignals() {
      return listRunsSync().flatMap((run) => run.signals);
    },
  };
}

/** Construct a SignalOutcome with a stable id and a recordedAt stamp. */
export function makeOutcome(input: {
  accountDomain: string;
  touchId?: string;
  contactId?: string;
  result: SignalOutcomeResult;
  creditedSignals?: string[];
  recordedAt?: string;
}): SignalOutcome {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const accountDomain = normalizeAccountDomain(input.accountDomain);
  return {
    id: outcomeId({ accountDomain, touchId: input.touchId, result: input.result, recordedAt }),
    accountDomain,
    ...(input.touchId !== undefined ? { touchId: input.touchId } : {}),
    ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
    result: input.result,
    recordedAt,
    creditedSignals: input.creditedSignals ?? [],
  };
}
