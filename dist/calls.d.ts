export type CallInsightType = "pain_point" | "objection" | "competitor_mention" | "next_step" | "feature_request" | "pricing" | "decision_criteria" | "risk" | "coaching_moment";
export type ParsedTranscriptSegment = {
    index: number;
    speaker?: string;
    speakerRole: "rep" | "customer" | "unknown";
    text: string;
    startChar: number;
    endChar: number;
};
export type ExtractedCallInsight = {
    type: CallInsightType;
    title: string;
    text: string;
    evidence: string;
    speaker?: string;
    confidence: number;
    importance: number;
    segmentIndex?: number;
    startChar?: number;
    endChar?: number;
};
export declare function parseTranscript(transcript: string): ParsedTranscriptSegment[];
export declare function extractCallInsights(transcript: string, segments?: ParsedTranscriptSegment[]): ExtractedCallInsight[];
export declare function summarizeInsights(insights: ExtractedCallInsight[]): {
    total: number;
    highImportance: number;
    byType: Record<string, number>;
    topTypes: {
        type: string;
        count: number;
    }[];
};
import type { CanonicalGtmSnapshot, GtmEvidence, GtmEvidenceSourceSystem } from "./types.ts";
export type ParsedCall = {
    /** Stable hash of the normalized transcript — same input, same id. */
    id: string;
    title?: string;
    sourceSystem: GtmEvidenceSourceSystem;
    /** What produced the insights: "deterministic" or "llm:<provider>:<model>". */
    extractor: string;
    segments: ParsedTranscriptSegment[];
    insights: ExtractedCallInsight[];
    evidence: GtmEvidence[];
    summary: ReturnType<typeof summarizeInsights>;
};
/** Detect and normalize a raw transcript payload into "Speaker: text" lines. */
export declare function normalizeTranscript(raw: string): string;
/**
 * Parse any supported transcript dialect into a canonical call: segments,
 * deterministic insights, and GtmEvidence records ready for findings and
 * patch plans. Pure and deterministic — same transcript, same ids.
 */
export declare function parseCall(raw: string, options?: {
    title?: string;
    sourceSystem?: GtmEvidenceSourceSystem;
    capturedAt?: string;
    /** Pre-extracted insights (e.g. LLM); skips the deterministic extractor. */
    insights?: ExtractedCallInsight[];
    extractor?: string;
}): ParsedCall;
export type CallDealSuggestion = {
    dealId: string | null;
    dealName?: string;
    accountId?: string;
    accountName?: string;
    /**
     * HOW the deal's account was matched — `account_domain` (the company-wide,
     * reliable signal) vs `contact_email` (a specific person, possibly stale) vs
     * `both`. An agent needs this to weight the match; the bare confidence hides it.
     */
    resolvedVia?: "account_domain" | "contact_email" | "both";
    /** The attendee contacts that matched (the email path), so the contact↔account
     *  hop is visible, not just the resolved account. */
    matchedContacts?: {
        id: string;
        email?: string;
        accountId?: string;
    }[];
    confidence: "high" | "low" | "none";
    reason: string;
};
/**
 * Suggest which deal a call belongs to: attendee email domains → account
 * (contact emails or account domain) → open deals, most recent activity
 * first. Deterministic; mirrors the heuristic every call pipeline hand-rolls.
 */
export declare function suggestCallDeal(snapshot: CanonicalGtmSnapshot, options: {
    attendeeEmails?: string[];
    domain?: string;
}): CallDealSuggestion;
