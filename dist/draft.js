import { forcedToolCall } from "./llm.js";
import { isGroundedSpan } from "./judge.js";
import { normalizeAccountDomain } from "./signals.js";
export const DRAFT_CHANNELS = ["email", "linkedin", "task"];
// ---------------------------------------------------------------------------
// Stable hashing (FNV-1a) — duplicated to keep this file importable without the
// audit engine (the judge.ts/signals.ts/market.ts/enrich.ts precedent).
function fnv1a(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
/** Stable patch-operation id for a draft op (mirrors enrich's `op_enr_<hash>`). */
export function draftOperationId(channel, accountDomain) {
    return `op_draft_${fnv1a(`${channel}:${accountDomain}`)}`;
}
/** Stable evidence id for the signal a draft is grounded in. */
export function draftEvidenceId(signalId) {
    return `ev_draft_${fnv1a(signalId)}`;
}
// ---------------------------------------------------------------------------
// Freshness / stale-trigger
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Default freshness window for the self-discard rule. A draft whose grounding
 * signal's `firstSeen` is older than this is flagged `staleTrigger` so the human
 * reviewer catches a manufactured-relevance opener before approving it. 14 days
 * mirrors the judge's `FRESH_SIGNAL_DAYS`.
 */
export const DEFAULT_FRESHNESS_DAYS = 14;
export function isStaleTrigger(firstSeen, now, windowDays = DEFAULT_FRESHNESS_DAYS) {
    const seen = Date.parse(firstSeen);
    if (!Number.isFinite(seen))
        return true; // an undateable trigger can't be proven fresh — treat as stale
    return now.getTime() - seen > windowDays * DAY_MS;
}
// ---------------------------------------------------------------------------
// Voice rules / opener hygiene (the editable prompt's mechanically-checkable contract)
export const DEFAULT_DRAFT_PROMPT = `You are writing ONE cold opener for a single hot account, grounded in a real, fresh trigger.
The opener's FIRST LINE must quote the trigger back in the buyer's own words — copy a verbatim span of the why-now below into line 1. Never open with "Hi {{firstName}}" or any greeting placeholder.
Rules (the operator owns these — edit this prompt to change them):
- Line 1: open on the real trigger, in the buyer's words. It MUST contain a verbatim span of the why-now quote.
- One sentence tying the trigger to ONE problem you solve. Specific, not generic.
- End with ONE low-friction ask. No fake urgency, no "circling back".
- No em dashes. No "Hi {{firstName}}". Keep it short — a real trigger does not need nine sentences.`;
/**
 * Strip em dashes (voice rule), collapse runs of whitespace WITHIN a line while
 * preserving line breaks (line 1 grounding depends on the first line surviving
 * intact), and trim trailing whitespace. Returns the cleaned opener.
 */
export function sanitizeOpener(opener) {
    return opener
        .replace(/—/g, "-")
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
/** The first non-empty line of an opener — the line the evidence gate checks. */
export function firstLine(opener) {
    for (const line of opener.split("\n")) {
        if (line.trim())
            return line.trim();
    }
    return "";
}
/**
 * Does the opener's first line contain a verbatim ≥12-char normalized span of the
 * decision's whyNow? This is the self-discard gate: a draft that doesn't ground
 * line 1 in the trigger is rejected, not saved.
 */
export function firstLineGroundedInTrigger(opener, whyNow) {
    return isGroundedSpan(whyNow, firstLine(opener));
}
/** Reject openers that lead with a banned greeting placeholder. */
export function hasBannedGreeting(opener) {
    return /\bhi\s+\{\{\s*firstname\s*\}\}/i.test(opener) || /^\s*hi\s+\{\{/i.test(opener);
}
// ---------------------------------------------------------------------------
// Evidence builder (evidenceFor idiom)
/**
 * Build a `GtmEvidence` from the signal a draft is grounded in — the trigger that
 * justified the opener. `sourceSystem` is "web" for fetched signals (ATS boards
 * via global fetch) and "manual" for ingested ones; `text` is the VERBATIM signal
 * quote (the evidence anchor reused all the way from `signals fetch`).
 */
export function draftEvidence(signal, capturedAt) {
    const fetched = signal.source !== "ingest";
    return {
        id: draftEvidenceId(signal.id),
        sourceSystem: fetched ? "web" : "manual",
        sourceObjectType: "signal",
        sourceObjectId: signal.id,
        title: `${signal.bucket} signal for ${signal.accountDomain}: ${signal.trigger}`,
        text: signal.quote,
        capturedAt,
        metadata: {
            bucket: signal.bucket,
            trigger: signal.trigger,
            sourceUrl: signal.sourceUrl,
            firstSeen: signal.firstSeen,
            signalSource: signal.source,
        },
    };
}
// ---------------------------------------------------------------------------
// Opener authoring: deterministic stub + gated LLM path
/**
 * The no-key, honestly-degraded baseline. Emits a clearly-labeled template stub
 * — NEVER fake authored copy. Line 1 is the verbatim whyNow (so the first-line
 * evidence gate passes by construction), followed by the play (if any) as the
 * "what to say" scaffold the operator fills in once they add a key.
 */
export function deterministicOpener(decision) {
    const whyNow = decision.whyNow.trim();
    const play = decision.play.trim();
    const tail = play ? `\n→ ${play}` : "";
    return `[[DRAFT - no LLM key]] ${whyNow}${tail}`;
}
export const DRAFT_SCHEMA = {
    type: "object",
    required: ["opener"],
    properties: {
        opener: {
            type: "string",
            description: "The full cold opener. The FIRST line MUST contain a verbatim span copied from the why-now quote. " +
                "One problem sentence, one low-friction ask. No greeting, no 'Hi {{firstName}}', no em dashes.",
        },
    },
};
/**
 * The LLM drafter for one account. Forced tool call with `DRAFT_SCHEMA` + the
 * editable prompt; then the FIRST-LINE evidence gate: line 1 must contain a
 * verbatim ≥12-char span of the decision's whyNow. Retry once with corrective
 * feedback (the judge/market idiom), then — rather than store an ungrounded
 * opener — fall back to the deterministic stub. The brain NEVER ships an opener
 * whose first line isn't grounded in the trigger.
 */
export async function draftOpenerLlm(decision, signal, promptTemplate, llm) {
    const model = llm.model ?? "claude-haiku-4-5";
    const producedBy = `llm:${llm.provider}:${model}`;
    const basePrompt = `${promptTemplate}

Account: ${decision.accountDomain}
Why now (your FIRST line must contain a verbatim span of THIS): "${decision.whyNow}"
The trigger quote (verbatim source): "${signal.quote}"${decision.play ? `\nA play the judge suggested (do not copy verbatim): ${decision.play}` : ""}`;
    const attempt = async (feedback) => {
        const result = (await forcedToolCall(feedback ? `${basePrompt}\n${feedback}` : basePrompt, "draft_opener", DRAFT_SCHEMA, model, llm));
        const opener = sanitizeOpener((result.opener ?? "").trim());
        if (!opener)
            return null;
        if (hasBannedGreeting(opener))
            return null;
        if (!firstLineGroundedInTrigger(opener, decision.whyNow))
            return null; // gate failed
        return opener;
    };
    const first = await attempt("");
    if (first)
        return { opener: first, producedBy, grounded: true };
    const retried = await attempt("\nYour previous opener's FIRST line did NOT contain a verbatim span of the why-now quote " +
        "(or it used a banned greeting). Copy a span character-for-character from the why-now into line 1 and rewrite.");
    if (retried)
        return { opener: retried, producedBy, grounded: true };
    // Both attempts ungrounded — never store an ungrounded opener. Fall back to the
    // labeled deterministic stub (grounded by construction), but stamp the path that
    // ran so the operator can see the model was reached and gated.
    return { opener: deterministicOpener(decision), producedBy, grounded: false };
}
// ---------------------------------------------------------------------------
// Orchestration: judge decisions → drafts → governed plan
/**
 * Author one opener per hot account and stage them as a `needs_approval` plan of
 * `create_task` PatchOperations, each carrying a `GtmEvidence` (the signal quote)
 * on `plan.evidence` and referenced via `op.evidenceIds`. Read-only: builds the
 * plan in memory; the caller persists it via `createFilePlanStore().save(plan)`
 * only on `--save`. NEVER sends.
 *
 * - Takes decisions with `decision === "send"` and `score >= minScore`.
 * - Picks the credited signal whose quote grounds the whyNow as the trigger
 *   anchor (the evidence the opener traces back to).
 * - Authors the opener: LLM (gated, first-line evidence) when `llm` is provided,
 *   else the labeled deterministic stub.
 * - First-line evidence gate: an opener whose line 1 doesn't ground in the whyNow
 *   is REJECTED (surfaced in `rejected`, never an op). The deterministic stub and
 *   the LLM fallback are grounded by construction, so they always pass.
 * - Stale-trigger: a draft whose grounding signal is older than the freshness
 *   window gets a `staleTrigger` warning appended to the op `reason`.
 */
export function draft(opts) {
    const now = opts.now ?? new Date();
    const nowIso = now.toISOString();
    const minScore = opts.minScore ?? 80;
    const channel = opts.channel ?? "task";
    const freshnessDays = opts.freshnessDays ?? DEFAULT_FRESHNESS_DAYS;
    // `task`/`email`/`linkedin` all write a CRM task through the same gate; the
    // object the task hangs off is the contact when known, else the account.
    const objectType = "contact";
    const hot = opts.decisions
        .filter((d) => d.decision === "send" && d.score >= minScore)
        .sort((a, b) => b.score - a.score || a.accountDomain.localeCompare(b.accountDomain));
    const operations = [];
    const evidence = [];
    const drafts = [];
    const rejected = [];
    for (const decision of hot) {
        const domain = normalizeAccountDomain(decision.accountDomain);
        const signal = creditedTriggerSignal(decision, opts.signalsById);
        if (!signal) {
            // No credited signal quote grounds the whyNow — we cannot trace this opener
            // to a trigger, so we cannot draft it. Surface, never emit.
            rejected.push({
                accountDomain: domain,
                opener: "",
                reason: "no credited signal quote grounds the why-now — cannot anchor an opener",
            });
            continue;
        }
        const authored = opts.openers?.get(domain);
        const opener = authored ? authored.opener : deterministicOpener(decision);
        const producedBy = authored ? authored.producedBy : "deterministic";
        // First-line evidence gate — the self-discard rule. The deterministic stub and
        // the LLM fallback are grounded by construction; an LLM opener that reached here
        // already passed in draftOpenerLlm, but we re-check defensively (a caller could
        // inject any opener).
        if (!firstLineGroundedInTrigger(opener, decision.whyNow)) {
            rejected.push({
                accountDomain: domain,
                opener,
                reason: "first line does not contain a verbatim span of the why-now trigger",
            });
            continue;
        }
        const stale = isStaleTrigger(signal.firstSeen, now, freshnessDays);
        const ev = draftEvidence(signal, nowIso);
        evidence.push(ev);
        const reasonBase = `Signal-grounded opener for ${domain}: "${signal.trigger}"`;
        const reason = stale
            ? `${reasonBase} [staleTrigger: grounding signal first seen ${signal.firstSeen}, older than ${freshnessDays}d — could this have gone out last month unchanged?]`
            : reasonBase;
        operations.push({
            id: draftOperationId(channel, domain),
            objectType,
            objectId: domain,
            operation: "create_task",
            field: "follow_up_task",
            beforeValue: null,
            afterValue: opener.slice(0, 255),
            reason,
            sourceRuleOrPolicy: `draft:${channel}`,
            riskLevel: "low",
            approvalRequired: true,
            rollback: "Close or delete the created task; nothing was sent.",
            evidenceIds: [ev.id],
        });
        drafts.push({
            accountDomain: domain,
            opener,
            decision,
            signal,
            producedBy,
            staleTrigger: stale,
        });
    }
    const plan = {
        id: `draft_${fnv1a(`${channel}:${nowIso}:${operations.map((o) => o.id).join(",")}`)}`,
        title: `Draft openers (${channel}) — ${operations.length} hot account(s)`,
        createdAt: nowIso,
        status: operations.length > 0 ? "needs_approval" : "draft",
        dryRun: true,
        summary: `${operations.length} drafted opener(s) staged as create_task proposals` +
            `${rejected.length ? `; ${rejected.length} rejected (ungrounded first line)` : ""}. ` +
            "A draft is a proposal — nothing is sent until plans approve -> apply.",
        findings: [],
        evidence,
        operations,
    };
    return { plan, drafts, rejected };
}
/**
 * Pick the credited signal whose quote grounds the decision's whyNow — the
 * trigger the opener traces back to. Prefers a signal whose quote verbatim
 * contains the whyNow span; falls back to the first resolvable credited signal so
 * the evidence chain is never empty when a credit exists.
 */
export function creditedTriggerSignal(decision, signalsById) {
    let firstResolved;
    for (const id of decision.evidence) {
        const signal = signalsById.get(id);
        if (!signal)
            continue;
        if (!firstResolved)
            firstResolved = signal;
        if (isGroundedSpan(decision.whyNow, signal.quote))
            return signal;
    }
    return firstResolved;
}
/**
 * Author openers for the hot decisions via the LLM path (or the deterministic
 * stub when no `llm` is provided), returning the map `draft()` consumes. Kept
 * separate from `draft()` so the plan-assembly stays pure/synchronous and the
 * async authoring is testable in isolation.
 */
export async function authorOpeners(opts) {
    const minScore = opts.minScore ?? 80;
    const out = new Map();
    for (const decision of opts.decisions) {
        if (decision.decision !== "send" || decision.score < minScore)
            continue;
        const domain = normalizeAccountDomain(decision.accountDomain);
        const signal = creditedTriggerSignal(decision, opts.signalsById);
        if (!signal)
            continue;
        if (opts.llm && opts.promptTemplate) {
            const { opener, producedBy, grounded } = await draftOpenerLlm(decision, signal, opts.promptTemplate, opts.llm);
            out.set(domain, { opener, producedBy, grounded, signalId: signal.id });
        }
        else {
            out.set(domain, {
                opener: deterministicOpener(decision),
                producedBy: "deterministic",
                grounded: true,
                signalId: signal.id,
            });
        }
    }
    return out;
}
