const DEFAULT_REP_SPEAKERS = [
    "rep",
    "sales",
    "seller",
    "ae",
    "sdr",
    "bdr",
    "account executive",
    "host",
];
const CUSTOMER_HINTS = [
    "customer",
    "prospect",
    "buyer",
    "client",
    "champion",
    "participant",
];
const insightPatterns = [
    {
        type: "pain_point",
        title: "Customer pain point",
        confidence: 0.78,
        importance: 4,
        patterns: [
            /\b(struggling|struggle|pain|problem|challenge|frustrat(?:ed|ing)|manual|messy|broken|hard to|difficult|too much time|takes too long)\b/i,
        ],
    },
    {
        type: "objection",
        title: "Sales objection",
        confidence: 0.76,
        importance: 4,
        patterns: [
            /\b(concern|worried|not sure|too expensive|budget|price|pricing|timing|procurement|security review|legal review|need to think|another vendor)\b/i,
        ],
    },
    {
        type: "competitor_mention",
        title: "Competitor or alternative mentioned",
        confidence: 0.72,
        importance: 3,
        patterns: [
            /\b(competitor|alternative|evaluating|looked at|using|salesforce|hubspot|gong|chorus|clari|outreach|salesloft|6sense|demandbase|clay|zapier|workato)\b/i,
        ],
    },
    {
        type: "next_step",
        title: "Next step",
        confidence: 0.82,
        importance: 5,
        patterns: [
            /\b(next step|follow up|send over|circle back|schedule|book|meet again|by (monday|tuesday|wednesday|thursday|friday)|action item|I'll send|we'll send)\b/i,
        ],
    },
    {
        type: "feature_request",
        title: "Feature request",
        confidence: 0.74,
        importance: 3,
        patterns: [
            /\b(wish|would love|need it to|feature|capability|does it support|can it|integration|custom field|dashboard|report|export|import)\b/i,
        ],
    },
    {
        type: "pricing",
        title: "Pricing or budget signal",
        confidence: 0.76,
        importance: 4,
        patterns: [
            /\b(price|pricing|budget|cost|discount|contract|renewal|procurement|purchase order|PO|invoice|annual|monthly|ARR|MRR|\$\d+)\b/i,
        ],
    },
    {
        type: "decision_criteria",
        title: "Decision criteria",
        confidence: 0.73,
        importance: 4,
        patterns: [
            /\b(criteria|decision|evaluate|evaluation|success looks like|requirements|must have|need to see|stakeholder|committee|approve|approval)\b/i,
        ],
    },
    {
        type: "risk",
        title: "Deal risk",
        confidence: 0.75,
        importance: 5,
        patterns: [
            /\b(delay|blocked|risk|concern|not a priority|no budget|push|slip|stalled|ghost|unresponsive|champion left|reorg)\b/i,
        ],
    },
    {
        type: "coaching_moment",
        title: "Coaching moment",
        confidence: 0.68,
        importance: 2,
        patterns: [
            /\b(let me tell you|obviously|basically|trust me|to be honest|just checking in|does that make sense\?)\b/i,
        ],
    },
];
export function parseTranscript(transcript) {
    const normalized = transcript.replace(/\r\n/g, "\n").trim();
    if (!normalized)
        return [];
    const lines = normalized.split(/\n+/);
    const segments = [];
    let cursor = 0;
    let current = null;
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            cursor += rawLine.length + 1;
            continue;
        }
        const startChar = normalized.indexOf(line, cursor);
        const lineStart = startChar >= 0 ? startChar : cursor;
        const lineEnd = lineStart + line.length;
        const match = line.match(/^([^:\[\]]{1,60}|\[[^\]]{1,60}\])\s*:\s*(.+)$/);
        if (match) {
            const speaker = match[1].replace(/^\[|\]$/g, "").trim();
            const text = match[2].trim();
            current = {
                index: segments.length,
                speaker,
                speakerRole: inferSpeakerRole(speaker),
                text,
                startChar: lineStart + line.indexOf(text),
                endChar: lineEnd,
            };
            segments.push(current);
        }
        else if (current) {
            current.text = `${current.text}\n${line}`;
            current.endChar = lineEnd;
        }
        else {
            current = {
                index: segments.length,
                speakerRole: "unknown",
                text: line,
                startChar: lineStart,
                endChar: lineEnd,
            };
            segments.push(current);
        }
        cursor = lineEnd;
    }
    return segments;
}
export function extractCallInsights(transcript, segments = parseTranscript(transcript)) {
    const seen = new Set();
    const insights = [];
    for (const segment of segments) {
        const text = segment.text.trim();
        if (!text || text.length < 12)
            continue;
        for (const pattern of insightPatterns) {
            if (!pattern.patterns.some((candidate) => candidate.test(text)))
                continue;
            const key = `${pattern.type}:${text.slice(0, 180).toLowerCase()}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            insights.push({
                type: pattern.type,
                title: pattern.title,
                text: text.length > 500 ? `${text.slice(0, 497)}...` : text,
                evidence: text,
                speaker: segment.speaker,
                confidence: pattern.confidence,
                importance: pattern.importance,
                segmentIndex: segment.index,
                startChar: segment.startChar,
                endChar: segment.endChar,
            });
        }
    }
    return insights.sort((a, b) => b.importance - a.importance || b.confidence - a.confidence);
}
export function summarizeInsights(insights) {
    const byType = {};
    let highImportance = 0;
    for (const insight of insights) {
        byType[insight.type] = (byType[insight.type] ?? 0) + 1;
        if (insight.importance >= 4)
            highImportance += 1;
    }
    return {
        total: insights.length,
        highImportance,
        byType,
        topTypes: Object.entries(byType)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([type, count]) => ({ type, count })),
    };
}
function inferSpeakerRole(speaker) {
    const normalized = speaker.toLowerCase();
    if (DEFAULT_REP_SPEAKERS.some((hint) => normalized.includes(hint)))
        return "rep";
    if (CUSTOMER_HINTS.some((hint) => normalized.includes(hint)))
        return "customer";
    return "unknown";
}
/** Detect and normalize a raw transcript payload into "Speaker: text" lines. */
export function normalizeTranscript(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed);
            const utterances = Array.isArray(parsed)
                ? parsed
                : Array.isArray(parsed.transcript)
                    ? (parsed.transcript)
                    : null;
            if (utterances && utterances.every((u) => typeof u === "object" && u !== null && "text" in u)) {
                return utterances
                    .filter((u) => typeof u.text === "string" && u.text.trim())
                    .map((u) => `${u.source === "microphone" ? "[Me]" : "[Them]"}: ${String(u.text).trim()}`)
                    .join("\n");
            }
        }
        catch {
            // not JSON — fall through and treat as plain text
        }
    }
    // Granola's formatted text export writes "[Speaker] text" with no colon;
    // rewrite those lines to the canonical "[Speaker]: text" form.
    return raw
        .split(/\r?\n/)
        .map((line) => {
        const match = /^(\[[^\]]{1,60}\])\s+(\S.*)$/.exec(line);
        return match && !line.slice(match[1].length).trimStart().startsWith(":")
            ? `${match[1]}: ${match[2]}`
            : line;
    })
        .join("\n");
}
/**
 * Parse any supported transcript dialect into a canonical call: segments,
 * deterministic insights, and GtmEvidence records ready for findings and
 * patch plans. Pure and deterministic — same transcript, same ids.
 */
export function parseCall(raw, options = {}) {
    const normalized = normalizeTranscript(raw);
    const segments = parseTranscript(normalized);
    const insights = options.insights ?? extractCallInsights(normalized, segments);
    const sourceSystem = options.sourceSystem ?? "manual";
    const id = `call_${callHash(normalized)}`;
    const evidence = insights.map((insight, index) => ({
        id: `ev_${callHash(`${id}:${insight.type}:${index}:${insight.text.slice(0, 80)}`)}`,
        sourceSystem,
        sourceObjectType: "call",
        sourceObjectId: id,
        title: insight.title,
        text: insight.evidence,
        capturedAt: options.capturedAt,
        metadata: {
            extractor: options.extractor ?? "deterministic",
            insightType: insight.type,
            speaker: insight.speaker,
            confidence: insight.confidence,
            importance: insight.importance,
            segmentIndex: insight.segmentIndex,
        },
    }));
    return {
        id,
        title: options.title,
        sourceSystem,
        extractor: options.extractor ?? "deterministic",
        segments,
        insights,
        evidence,
        summary: summarizeInsights(insights),
    };
}
/**
 * Suggest which deal a call belongs to: attendee email domains → account
 * (contact emails or account domain) → open deals, most recent activity
 * first. Deterministic; mirrors the heuristic every call pipeline hand-rolls.
 */
export function suggestCallDeal(snapshot, options) {
    const domains = new Set();
    if (options.domain)
        domains.add(options.domain.trim().toLowerCase());
    for (const email of options.attendeeEmails ?? []) {
        const at = email.indexOf("@");
        if (at > 0)
            domains.add(email.slice(at + 1).trim().toLowerCase());
    }
    if (domains.size === 0) {
        return { dealId: null, confidence: "none", reason: "No attendee emails or domain supplied to match on." };
    }
    const accountIds = new Set();
    let viaDomain = false;
    let viaEmail = false;
    const matchedContacts = [];
    for (const account of snapshot.accounts) {
        const domain = account.domain?.trim().toLowerCase().replace(/^www\./, "");
        if (domain && domains.has(domain)) {
            accountIds.add(account.id);
            viaDomain = true;
        }
    }
    for (const contact of snapshot.contacts) {
        const email = contact.email?.trim().toLowerCase();
        const at = email ? email.indexOf("@") : -1;
        if (email && at > 0 && domains.has(email.slice(at + 1)) && contact.accountId) {
            accountIds.add(contact.accountId);
            viaEmail = true;
            matchedContacts.push({ id: contact.id, ...(contact.email ? { email: contact.email } : {}), accountId: contact.accountId });
        }
    }
    const resolvedVia = viaDomain && viaEmail ? "both" : viaDomain ? "account_domain" : "contact_email";
    const via = { resolvedVia, ...(matchedContacts.length ? { matchedContacts } : {}) };
    if (accountIds.size === 0) {
        return {
            dealId: null,
            confidence: "none",
            reason: `No account matches the attendee domain(s) ${[...domains].join(", ")} by account domain or contact email.`,
        };
    }
    const accountsById = new Map(snapshot.accounts.map((a) => [a.id, a]));
    const openDeals = snapshot.deals
        .filter((deal) => deal.accountId && accountIds.has(deal.accountId))
        .filter((deal) => deal.isClosed !== true && deal.isWon !== true)
        .sort((a, b) => Date.parse(b.lastActivityAt ?? "1970") - Date.parse(a.lastActivityAt ?? "1970"));
    if (openDeals.length === 0) {
        const names = [...accountIds].map((id) => accountsById.get(id)?.name ?? id).join(", ");
        return {
            dealId: null,
            confidence: "none",
            reason: `Matched account(s) ${names} but found no open deals on them.`,
        };
    }
    const top = openDeals[0];
    const account = top.accountId ? accountsById.get(top.accountId) : undefined;
    if (openDeals.length === 1) {
        return {
            dealId: top.id,
            dealName: top.name,
            accountId: top.accountId,
            accountName: account?.name,
            ...via,
            confidence: "high",
            reason: `"${top.name}" is the only open deal on matched account "${account?.name ?? top.accountId}" (via ${resolvedVia}).`,
        };
    }
    return {
        dealId: top.id,
        dealName: top.name,
        accountId: top.accountId,
        accountName: account?.name,
        ...via,
        confidence: "low",
        reason: `${openDeals.length} open deals on matched account(s); "${top.name}" has the most recent activity (matched via ${resolvedVia}). Confirm before writing.`,
    };
}
function callHash(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
    }
    return hash.toString(36);
}
