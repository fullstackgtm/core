import { deterministicDecision, scoreAccount, } from "./judge.js";
import { DEFAULT_SIGNALS_CONFIG, computeWeights, normalizeAccountDomain, } from "./signals.js";
/** Hot threshold for the empirical gate — mirrors the judge's strong band (>=80). */
export const HOT_SCORE = 80;
/** Default golden-set pass bar (`--min-accuracy`). */
export const DEFAULT_MIN_ACCURACY = 0.8;
// ---------------------------------------------------------------------------
// Grading a judge against a golden set
/** Collapse the three-way decision to the binary send-vs-not the gate guards. */
function isSend(decision) {
    return decision === "send";
}
function decisionKindOf(result) {
    return typeof result === "string" ? result : result.decision;
}
/**
 * Run `judgeFn` over each golden row and score agreement on the binary
 * send-vs-skip call (nurture counts as not-send). Deterministic given a
 * deterministic `judgeFn`; the only async is the judge itself (so an LLM judge
 * can be graded with the same harness). Empty `rows` → perfect-but-vacuous
 * scores (accuracy 1) — the CLI guards against an empty set separately.
 */
export async function gradeJudge(rows, judgeFn) {
    const confusion = {
        truePositive: 0,
        falsePositive: 0,
        falseNegative: 0,
        trueNegative: 0,
    };
    for (const row of rows) {
        const predicted = isSend(decisionKindOf(await judgeFn(row)));
        const expected = row.expectedDecision === "send";
        if (predicted && expected)
            confusion.truePositive += 1;
        else if (predicted && !expected)
            confusion.falsePositive += 1;
        else if (!predicted && expected)
            confusion.falseNegative += 1;
        else
            confusion.trueNegative += 1;
    }
    const total = rows.length;
    const correct = confusion.truePositive + confusion.trueNegative;
    const predictedSend = confusion.truePositive + confusion.falsePositive;
    const actualSend = confusion.truePositive + confusion.falseNegative;
    return {
        accuracy: total === 0 ? 1 : round4(correct / total),
        // A judge that never says send is vacuously precise; one with no positives
        // to find has perfect recall — the standard 0-denominator conventions.
        precision: predictedSend === 0 ? 1 : round4(confusion.truePositive / predictedSend),
        recall: actualSend === 0 ? 1 : round4(confusion.truePositive / actualSend),
        confusion,
        total,
    };
}
// ---------------------------------------------------------------------------
// The default deterministic judge fn (offline, free, no LLM)
/**
 * The deterministic judge wrapped as an `EvalJudgeFn`: group a row's signals by
 * account, score the (single, by construction) account on timing × fit × memory
 * via `scoreAccount`, and return the deterministic decision. This is the SAME
 * scorer `icp judge` runs key-free, so `gradeJudge(rows, defaultJudgeFn())`
 * grades the real baseline — not a re-implementation. A row with no signals is
 * a skip (nothing changed → nothing to reach out about).
 */
export function defaultJudgeFn(opts = {}) {
    const config = opts.config ?? DEFAULT_SIGNALS_CONFIG;
    return (row) => {
        if (row.signals.length === 0)
            return "skip";
        // A golden row is one account; take the first signal's domain as the anchor.
        const domain = normalizeAccountDomain(row.signals[0].accountDomain);
        const signals = row.signals.filter((s) => normalizeAccountDomain(s.accountDomain) === domain);
        const weights = computeWeights(config, [], new Map(signals.map((s) => [s.id, s])));
        const score = scoreAccount({
            accountDomain: domain,
            signals,
            weights,
            icp: opts.icp,
            recentlyTouched: row.history?.recentlyTouched ?? false,
            now: opts.now,
        });
        return deterministicDecision(score).decision;
    };
}
// ---------------------------------------------------------------------------
// The default golden set (ships inline so `icp eval --golden default` is free)
/**
 * The default golden set's clock. Every `firstSeen` below is relative to this
 * instant, so grading MUST pin `now: new Date(DEFAULT_GOLDEN_NOW_ISO)` —
 * grading against wall time lets freshness decay rot the "fresh → send" rows,
 * and the gate starts failing on a calendar date instead of a code change.
 */
export const DEFAULT_GOLDEN_NOW_ISO = "2026-06-23T12:00:00.000Z";
const GOLD_NOW_ISO = DEFAULT_GOLDEN_NOW_ISO;
function goldSignal(over) {
    const domain = normalizeAccountDomain(over.accountDomain);
    return {
        id: `gold_${domain}_${over.bucket}_${over.trigger}`.replace(/[^\w]+/g, "_").toLowerCase(),
        accountDomain: domain,
        bucket: over.bucket,
        trigger: over.trigger,
        quote: over.quote,
        sourceUrl: "https://example.com/golden",
        firstSeen: over.firstSeen ?? GOLD_NOW_ISO,
        weight: 1,
        source: "ingest",
        judgedBy: null,
        ...(over.reposted ? { reposted: true } : {}),
    };
}
/**
 * A starter labeled set covering the four rubric corners, so `icp eval --golden
 * default` runs offline and the deterministic baseline passes it (>= the default
 * min-accuracy). Each row is a single account.
 *
 * - SEND: a fresh clustered account (funding + reposted live req) — strong band.
 * - SEND: a single high-weight demand/funding signal that still clears the bar.
 * - SKIP: a lone low-intent social blip — weak band, first-class no.
 * - SKIP: a single company-news mention with no in-persona trigger — weak.
 * - SKIP: a hot account TOUCHED within the memory window — don't pile on.
 */
export const DEFAULT_GOLDEN_SET = [
    {
        label: "clustered funding + reposted role -> send",
        expectedDecision: "send",
        signals: [
            goldSignal({
                accountDomain: "apexnorth.agency",
                bucket: "funding",
                trigger: "raised Series B",
                quote: "ApexNorth raised a $40M Series B led by Acme Ventures this week.",
            }),
            goldSignal({
                accountDomain: "apexnorth.agency",
                bucket: "job",
                trigger: "reposted: Head of Growth",
                quote: "Head of Growth reopened — own demand gen and marketing ops for the next stage of growth.",
                reposted: true,
            }),
        ],
    },
    {
        label: "fresh funding + live req -> send",
        expectedDecision: "send",
        signals: [
            goldSignal({
                accountDomain: "brightloop.io",
                bucket: "funding",
                trigger: "raised Series A",
                quote: "Brightloop closed a $12M Series A to expand its go-to-market team this quarter.",
            }),
            goldSignal({
                accountDomain: "brightloop.io",
                bucket: "job",
                trigger: "hiring: VP Marketing",
                quote: "VP Marketing — build the demand engine and own pipeline targets from scratch.",
            }),
        ],
    },
    {
        label: "lone social blip -> skip",
        expectedDecision: "skip",
        signals: [
            goldSignal({
                accountDomain: "quietco.io",
                bucket: "social",
                trigger: "liked a post",
                quote: "Their VP of Sales liked a post about pipeline hygiene last Tuesday.",
            }),
        ],
    },
    {
        label: "single low-intent company mention -> skip",
        expectedDecision: "skip",
        signals: [
            goldSignal({
                accountDomain: "stillwater.co",
                bucket: "social",
                trigger: "shared an article",
                quote: "Stillwater's account exec shared an industry article on LinkedIn over the weekend.",
            }),
        ],
    },
    {
        label: "hot but touched within 7 days -> skip (don't pile on)",
        expectedDecision: "skip",
        history: { recentlyTouched: true },
        signals: [
            goldSignal({
                accountDomain: "veridian.com",
                bucket: "social",
                trigger: "liked a post",
                quote: "A Veridian director liked a post about outbound sequencing yesterday afternoon.",
            }),
        ],
    },
];
/**
 * Parse a golden set from JSON or JSONL (one row per line). Validates each row
 * up front and names the offending entry (the enrich/signals parse idiom). The
 * literal "default" resolves to `DEFAULT_GOLDEN_SET` (handled by the CLI before
 * reading a file; this parses an actual file's contents).
 */
export function parseGoldenSet(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        throw new Error("golden set: empty file (expected a JSON array or JSONL of rows)");
    let candidates;
    if (trimmed.startsWith("[")) {
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch (error) {
            throw new Error(`golden set: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
        }
        if (!Array.isArray(parsed))
            throw new Error("golden set: expected a JSON array of rows");
        candidates = parsed;
    }
    else {
        // JSONL: one row object per non-empty line.
        candidates = [];
        const lines = trimmed.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i].trim();
            if (!line)
                continue;
            try {
                candidates.push(JSON.parse(line));
            }
            catch (error) {
                throw new Error(`golden set: line ${i + 1} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
            }
        }
    }
    return candidates.map((row, i) => validateGoldenRow(row, i));
}
function validateGoldenRow(row, index) {
    const where = `golden set: row ${index}`;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error(`${where} must be an object with signals + expectedDecision`);
    }
    const r = row;
    if (r.expectedDecision !== "send" && r.expectedDecision !== "skip") {
        throw new Error(`${where}: expectedDecision must be "send" or "skip"`);
    }
    if (!Array.isArray(r.signals)) {
        throw new Error(`${where}: signals must be an array of Signal objects`);
    }
    for (let s = 0; s < r.signals.length; s += 1) {
        const sig = r.signals[s];
        if (!sig || typeof sig !== "object")
            throw new Error(`${where} signal ${s} must be an object`);
        if (typeof sig.accountDomain !== "string" || !sig.accountDomain) {
            throw new Error(`${where} signal ${s}: accountDomain must be a non-empty string`);
        }
        if (typeof sig.bucket !== "string")
            throw new Error(`${where} signal ${s}: bucket must be a string`);
        if (typeof sig.quote !== "string")
            throw new Error(`${where} signal ${s}: quote must be a string`);
    }
    const history = r.history && typeof r.history === "object" && !Array.isArray(r.history)
        ? { recentlyTouched: Boolean(r.history.recentlyTouched) }
        : undefined;
    return {
        ...(typeof r.label === "string" ? { label: r.label } : {}),
        signals: r.signals,
        ...(history ? { history } : {}),
        expectedDecision: r.expectedDecision,
    };
}
// ---------------------------------------------------------------------------
// The empirical gate: do hot scores book more than cold scores?
/**
 * Grade the judge's decisions against accumulated `signals outcome` results: of
 * the decisions scored hot (>=80) vs cold (<80), which books meetings more
 * often? A decision is matched to outcomes by account domain (and an outcome
 * "books" when its result is "meeting"). Accounts with no recorded outcome are
 * excluded from the denominators. `calibrated` is true iff hot strictly beats
 * cold — absent or inverted correlation is NOT calibrated (the CLI exits
 * nonzero on it). Deterministic.
 */
export function gradeAgainstOutcomes(decisions, outcomes) {
    // Per-account: did any credited touch book a meeting? (Domain-level booking.)
    const booked = new Map();
    const sawOutcome = new Map();
    for (const outcome of outcomes) {
        const domain = normalizeAccountDomain(outcome.accountDomain);
        if (!domain)
            continue;
        sawOutcome.set(domain, true);
        if (outcome.result === "meeting")
            booked.set(domain, true);
        else if (!booked.has(domain))
            booked.set(domain, false);
    }
    let hotBooked = 0;
    let hotCount = 0;
    let coldBooked = 0;
    let coldCount = 0;
    // One decision per account; if a domain repeats, the highest score wins the
    // bucket assignment so a single domain isn't double-counted across buckets.
    const scoreByDomain = new Map();
    for (const decision of decisions) {
        const domain = normalizeAccountDomain(decision.accountDomain);
        if (!domain || !sawOutcome.get(domain))
            continue;
        const prior = scoreByDomain.get(domain);
        if (prior === undefined || decision.score > prior)
            scoreByDomain.set(domain, decision.score);
    }
    for (const [domain, score] of scoreByDomain) {
        const didBook = booked.get(domain) === true ? 1 : 0;
        if (score >= HOT_SCORE) {
            hotCount += 1;
            hotBooked += didBook;
        }
        else {
            coldCount += 1;
            coldBooked += didBook;
        }
    }
    const hotBookRate = hotCount === 0 ? 0 : round4(hotBooked / hotCount);
    const coldBookRate = coldCount === 0 ? 0 : round4(coldBooked / coldCount);
    return {
        hotBookRate,
        coldBookRate,
        calibrated: hotBookRate > coldBookRate,
        hotCount,
        coldCount,
    };
}
// ---------------------------------------------------------------------------
function round4(value) {
    return Math.round(value * 10000) / 10000;
}
