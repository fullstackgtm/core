import { DEFAULT_MODELS, forcedToolCall } from "./llm.js";
import { loadCaptureTexts, observationId, verifyEvidenceSpans, } from "./market.js";
import { MARKET_CAPTURE_STAGES, nullProgressEmitter } from "./progress.js";
/**
 * LLM intensity classification for the market map — the same
 * semi-deterministic posture as call extraction, with one upgrade calls
 * can't have: because the source pages are stored captures, every quoted
 * span is verified mechanically against the capture it cites before the
 * observation is accepted. A reading whose quote isn't verbatim on the page
 * bounces back to the model once with the failures named; if it still can't
 * quote the page, classification fails rather than storing unverifiable
 * evidence.
 *
 * Deterministic parts stay deterministic: vendors with no usable captures
 * score UNOBSERVABLE on every claim without an LLM call, and front states
 * downstream are computed from the store, never from model output.
 */
// Bound cost and context: a vendor's pages are classified in one call.
const MAX_DOSSIER_CHARS = 48_000;
const CLASSIFY_INSTRUCTIONS = `Classify this vendor's messaging intensity for EVERY claim listed.
Rules:
- Judge ONLY from the captured pages below. Do not use outside knowledge of the vendor.
- intensity per the surface rule: "loud" = hero copy or a top-level-nav named product/program with a dedicated page; "quiet" = present on any page below that; "absent" = nowhere in the captures.
- evidence quotes MUST be verbatim spans copied exactly from the captured text (≤300 chars). Every loud or quiet reading needs at least one quote. If you cannot quote it, the reading is absent.
- An explicit disavowal ("we do not offer X", "call 988") is absent — put the disavowal quote in reason, it is informative signal.
- url must be the page the quote came from, exactly as given in the page headers below.
- reason: one reviewer-facing sentence.
- Return a reading for every claim id. Never invent claim ids.`;
const classifySchema = (claimIds) => ({
    type: "object",
    required: ["readings"],
    properties: {
        readings: {
            type: "array",
            items: {
                type: "object",
                required: ["claimId", "intensity", "confidence", "reason", "evidence"],
                properties: {
                    claimId: { type: "string", enum: claimIds },
                    intensity: { type: "string", enum: ["loud", "quiet", "absent"] },
                    confidence: { type: "string", enum: ["high", "medium", "low"] },
                    reason: { type: "string", description: "One reviewer-facing sentence." },
                    evidence: {
                        type: "array",
                        items: {
                            type: "object",
                            required: ["quote", "url"],
                            properties: {
                                quote: { type: "string", description: "VERBATIM span copied exactly from the captured page text. Never paraphrase." },
                                url: { type: "string", description: "The page URL the quote came from, exactly as shown in the page header." },
                            },
                        },
                    },
                },
            },
        },
    },
});
function buildDossier(entries, textByHash) {
    const pages = entries
        .filter((entry) => entry.captureHash && textByHash.has(entry.captureHash))
        .map((entry) => ({ entry, text: textByHash.get(entry.captureHash) }));
    if (pages.length === 0)
        return "";
    const budget = Math.floor(MAX_DOSSIER_CHARS / pages.length);
    return pages
        .map(({ entry, text }) => {
        const body = text.length <= budget
            ? text
            : `${text.slice(0, budget / 2)}\n[... middle of page truncated ...]\n${text.slice(-budget / 2)}`;
        return `=== PAGE (${entry.kind}) ${entry.url} ===\n${body}`;
    })
        .join("\n\n");
}
function claimsBlock(claims) {
    return claims
        .map((claim) => `- ${claim.id}: ${claim.capability}\n  How to judge: ${claim.definition}`)
        .join("\n");
}
export async function classifyMarket(config, options) {
    const model = options.llm.model ?? DEFAULT_MODELS[options.llm.provider];
    const progress = options.progress ?? nullProgressEmitter();
    const { entries, textByHash } = options.store
        ? await options.store.loadCaptureTexts()
        : loadCaptureTexts(config.category, options.capturesDir);
    if (entries.length === 0) {
        throw new Error(`No captures for ${config.category} — run \`market capture\` first`);
    }
    const captureRun = options.captureRun ?? entries[entries.length - 1].runLabel;
    const runEntries = entries.filter((entry) => entry.runLabel === captureRun);
    if (runEntries.length === 0) {
        throw new Error(`No captures for run "${captureRun}" — available: ${[...new Set(entries.map((e) => e.runLabel))].join(", ")}`);
    }
    const observedAt = (options.now ?? (() => new Date()))().toISOString();
    const vendorIds = options.vendors ?? config.vendors.map((vendor) => vendor.id);
    const claimIds = config.claims.map((claim) => claim.id);
    const observations = [];
    const retriedVendorIds = [];
    progress.stage(MARKET_CAPTURE_STAGES[2], 2, MARKET_CAPTURE_STAGES.length);
    for (const [vendorIndex, vendorId] of vendorIds.entries()) {
        try {
            options.onVendor?.(vendorIndex, vendorIds.length, vendorId);
        }
        catch {
            // progress is presentation-only
        }
        progress.note(vendorId);
        const vendor = config.vendors.find((candidate) => candidate.id === vendorId);
        if (!vendor)
            throw new Error(`Unknown vendor "${vendorId}"`);
        const vendorEntries = runEntries.filter((entry) => entry.vendorId === vendorId);
        const hashByUrl = new Map(vendorEntries.filter((entry) => entry.captureHash).map((entry) => [entry.url, entry.captureHash]));
        const dossier = buildDossier(vendorEntries, textByHash);
        if (!dossier) {
            // Deterministic: no usable captures means UNOBSERVABLE everywhere — never
            // ask a model to judge pages that were never read.
            for (const claim of config.claims) {
                observations.push({
                    id: observationId(config.category, options.runLabel, vendorId, claim.id),
                    vendorId,
                    claimId: claim.id,
                    observedAt,
                    intensity: "unobservable",
                    confidence: "high",
                    reason: `No usable captures for ${vendor.name} in run ${captureRun} — cannot judge.`,
                    evidence: [],
                });
            }
            progress.items(vendorIndex + 1, vendorIds.length);
            continue;
        }
        const prompt = (feedback) => `${CLASSIFY_INSTRUCTIONS}\n\nSurface rule for this category:\n${config.surfaceRule ?? "(default rule above)"}\n\nClaims to classify (all of them):\n${claimsBlock(config.claims)}\n${feedback}\nVendor: ${vendor.name}\nCaptured pages:\n${dossier}`;
        const attempt = async (feedback) => {
            const result = (await forcedToolCall(prompt(feedback), "classify_market_claims", classifySchema(claimIds), model, options.llm));
            const readings = (result.readings ?? []).filter((reading) => claimIds.includes(reading.claimId));
            const seen = new Set(readings.map((reading) => reading.claimId));
            const problems = claimIds.filter((claimId) => !seen.has(claimId)).map((claimId) => `missing reading for ${claimId}`);
            const candidate = readings.map((reading) => toObservation(reading, vendorId));
            const failures = verifyEvidenceSpans(candidate, textByHash);
            return { readings, problems, failures };
        };
        const toObservation = (reading, vendor) => ({
            id: observationId(config.category, options.runLabel, vendor, reading.claimId),
            vendorId: vendor,
            claimId: reading.claimId,
            observedAt,
            intensity: reading.intensity,
            confidence: reading.confidence,
            reason: reading.reason,
            evidence: (reading.evidence ?? []).map((item, index) => ({
                id: `${observationId(config.category, options.runLabel, vendor, reading.claimId)}_ev${index}`,
                sourceSystem: "web",
                sourceObjectType: "page",
                sourceObjectId: item.url,
                text: item.quote,
                observedAt,
                metadata: { url: item.url, captureHash: hashByUrl.get(item.url) ?? "" },
            })),
        });
        let outcome = await attempt("");
        if (outcome.problems.length > 0 || outcome.failures.length > 0) {
            retriedVendorIds.push(vendorId);
            const failureLines = [
                ...outcome.problems,
                ...outcome.failures.map((failure) => `${failure.claimId}: ${failure.problem} (your quote: "${failure.quote.slice(0, 80)}")`),
            ].join("\n- ");
            outcome = await attempt(`\nYour previous answer had problems. Fix exactly these and answer again in full:\n- ${failureLines}\nQuotes must be copied character-for-character from the captured text.\n`);
        }
        if (outcome.problems.length > 0 || outcome.failures.length > 0) {
            const detail = [...outcome.problems, ...outcome.failures.map((failure) => `${failure.claimId}: ${failure.problem}`)].slice(0, 10);
            throw new Error(`Classification for ${vendor.name} failed mechanical verification after a retry:\n  ${detail.join("\n  ")}\nNothing was stored. Re-run, try another --model, or classify this vendor by hand via the worksheet.`);
        }
        for (const reading of outcome.readings)
            observations.push(toObservation(reading, vendorId));
        progress.items(vendorIndex + 1, vendorIds.length);
    }
    progress.flush();
    return {
        set: {
            id: `set_${config.category}_${options.runLabel}`,
            category: config.category,
            runLabel: options.runLabel,
            runAt: observedAt,
            extractor: `llm:${options.llm.provider}:${model}`,
            observations,
        },
        model,
        retriedVendorIds,
    };
}
export function buildWorksheet(config, vendorId, options = {}) {
    const vendor = config.vendors.find((candidate) => candidate.id === vendorId);
    if (!vendor)
        throw new Error(`Unknown vendor "${vendorId}"`);
    const { entries, textByHash } = loadCaptureTexts(config.category, options.capturesDir);
    const captureRun = options.captureRun ?? entries[entries.length - 1]?.runLabel;
    if (!captureRun)
        throw new Error(`No captures for ${config.category} — run \`market capture\` first`);
    const pages = entries
        .filter((entry) => entry.runLabel === captureRun && entry.vendorId === vendorId && entry.captureHash)
        .map((entry) => ({
        kind: entry.kind,
        url: entry.url,
        captureHash: entry.captureHash,
        text: textByHash.get(entry.captureHash) ?? "",
    }));
    return {
        category: config.category,
        captureRun,
        surfaceRule: config.surfaceRule,
        vendor: { id: vendor.id, name: vendor.name },
        claims: config.claims,
        pages,
        instructions: "Produce one observation per claim (intensity loud|quiet|absent from these pages only; unobservable only if a page you need failed to capture). Every loud/quiet reading must quote a verbatim span (≤300 chars) from a page's text, with that page's url and captureHash in evidence metadata. Submit as an ObservationSet via `market observe --from <file>` — quotes are mechanically verified against the captures.",
    };
}
