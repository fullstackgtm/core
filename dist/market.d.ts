import type { GtmEvidence } from "./types.ts";
/**
 * The Market Map: a live model of the competitive category a company sells
 * into. Vendors publish claims constantly (pricing pages, feature pages,
 * hero copy); each (vendor × claim) cell gets a messaging-intensity reading,
 * and each claim row gets a derived front state. Observations are
 * append-only — history is the product; "what changed since last run" is a
 * first-class question.
 *
 * Division of labor mirrors call intelligence: intensity readings are
 * *proposals* (LLM or human, always with verbatim quoted evidence), while
 * everything downstream — front states, drift, the report — is deterministic
 * over the stored observations. Same stored observations, same map.
 *
 * The claim taxonomy and vendor registry live in a reviewable config file
 * (git-friendly, analyst-edited); captures and observations live under the
 * profile home so one client's category intel never bleeds into another's.
 */
export type ClaimIntensity = "loud" | "quiet" | "absent" | "unobservable";
export type ObservationConfidence = "high" | "medium" | "low";
export type FrontState = "open" | "contested" | "owned" | "saturated" | "vacant";
export type MarketClaim = {
    id: string;
    /** The capability being claimed, precise enough to judge loud/quiet/absent. */
    capability: string;
    /** Which ICP the claim cell addresses (category-specific vocabulary). */
    icp: string;
    /** Which pricing structure the claim cell implies (category-specific). */
    pricingStructure: string;
    /** Operational definition: how a reader judges LOUD vs QUIET vs ABSENT. */
    definition: string;
};
export type MarketVendor = {
    id: string;
    name: string;
    urls: {
        home: string;
        /** null is itself an observation: no public pricing surface. */
        pricing: string | null;
        product: string[];
    };
    notes?: string;
};
export type MarketConfig = {
    category: string;
    anchorVendor?: string;
    vendors: MarketVendor[];
    claims: MarketClaim[];
    /** The LOUD/QUIET/ABSENT/UNOBSERVABLE judging rule, stated for reviewers. */
    surfaceRule?: string;
};
export type MarketObservation = {
    /** stableHash(category, runLabel, vendorId, claimId) — deterministic. */
    id: string;
    vendorId: string;
    claimId: string;
    observedAt: string;
    intensity: ClaimIntensity;
    confidence: ObservationConfidence;
    /** Reviewer-facing: why the reading is what it is. */
    reason: string;
    /**
     * Verbatim quoted spans grounding any non-absent reading
     * (sourceSystem "web", metadata.url + metadata.captureHash).
     */
    evidence: GtmEvidence[];
};
export type ObservationSet = {
    id: string;
    category: string;
    runLabel: string;
    runAt: string;
    /** What produced the readings: "manual" or "llm:<provider>:<model>". */
    extractor: string;
    observations: MarketObservation[];
};
export type CaptureEntry = {
    runLabel: string;
    vendorId: string;
    kind: "home" | "pricing" | "product";
    url: string;
    fetchedAt: string;
    httpStatus: number | null;
    /** sha256 of the extracted text; null when the fetch failed or was empty. */
    captureHash: string | null;
    textChars: number;
};
export declare function observationId(category: string, runLabel: string, vendorId: string, claimId: string): string;
export declare function parseMarketConfig(raw: string): MarketConfig;
export declare function loadMarketConfig(path: string): MarketConfig;
export declare function starterMarketConfig(category: string): MarketConfig;
export declare function marketHome(category: string, baseDir?: string): string;
export declare function extractReadableText(html: string): string;
export type FetchPage = (url: string) => Promise<{
    status: number;
    body: string;
}>;
export type CaptureOptions = {
    /** Directory for captures; defaults to <marketHome>/captures. */
    dir?: string;
    runLabel?: string;
    /** Injectable for tests; defaults to global fetch. */
    fetchPage?: FetchPage;
    now?: () => Date;
};
export type CaptureResult = {
    entries: CaptureEntry[];
    manifestPath: string;
};
export declare function captureMarket(config: MarketConfig, options?: CaptureOptions): Promise<CaptureResult>;
export interface ObservationStore {
    append(set: ObservationSet): Promise<ObservationSet>;
    get(runLabel: string): Promise<ObservationSet | null>;
    list(): Promise<Array<{
        runLabel: string;
        runAt: string;
        observations: number;
    }>>;
    latest(): Promise<ObservationSet | null>;
}
export declare function createFileObservationStore(category: string, directory?: string): ObservationStore;
/**
 * Validate a proposed observation set against the config before it enters
 * the store: known vendors/claims, full coverage, legal readings, and the
 * verbatim-evidence rule (non-absent readings must quote something).
 * Returns problems; an empty array means accept.
 */
export declare function validateObservationSet(config: MarketConfig, set: ObservationSet): string[];
export declare function loadCaptureTexts(category: string, directory?: string): {
    entries: CaptureEntry[];
    textByHash: Map<string, string>;
};
/**
 * Whitespace-only normalization for span matching, plus one extraction
 * artifact: the HTML-to-text step can emit a line break before punctuation
 * that follows an inline tag ("placements\n. Districts"), which no honest
 * quoter would reproduce — so whitespace *before* punctuation is dropped
 * too. Words, casing, and characters must still match the page exactly.
 */
export declare function normalizeForMatch(value: string): string;
export type SpanVerificationFailure = {
    vendorId: string;
    claimId: string;
    quote: string;
    problem: string;
};
export declare function verifyEvidenceSpans(observations: MarketObservation[], textByHash: Map<string, string>): SpanVerificationFailure[];
export type ClaimFront = {
    claimId: string;
    state: FrontState;
    loudVendorIds: string[];
    quietVendorIds: string[];
};
/**
 * Front rule v1: 0 loud → open (if anyone is quiet) or vacant; 1 loud →
 * owned; 2–3 loud → contested; ≥4 loud → saturated. Unobservable cells are
 * excluded — a failed capture never reads as absence.
 */
export declare function computeFrontStates(config: MarketConfig, set: ObservationSet): ClaimFront[];
export type FrontDrift = {
    claimId: string;
    before: FrontState;
    after: FrontState;
};
/** What changed in the category between two runs — the refresh's whole point. */
export declare function diffFrontStates(before: ClaimFront[], after: ClaimFront[]): FrontDrift[];
