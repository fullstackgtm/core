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
    /**
     * Exact terms buyers use for this claim, for deterministic mention
     * matching against call transcripts (the overlay). No terms = no mention
     * stats for this claim; matching is word-boundary, case-insensitive.
     */
    terms?: string[];
};
/**
 * One public, citable scale signal for a vendor (G2 review count, LinkedIn
 * headcount, disclosed revenue, self-reported customer count). The composite
 * of several biased-in-different-directions signals sizes the report's
 * bubbles — a RELATIVE scale index within the mapped set, never "market
 * share" unqualified.
 */
export type ScaleSignal = {
    /** e.g. "g2_reviews", "linkedin_employees", "revenue_usd", "self_reported_customers". */
    metric: string;
    value: number;
    unit: string;
    sourceUrl: string;
    /** Verbatim snippet containing the number — same evidence posture as observations. */
    quote: string;
    asOf: string;
    caveat?: string;
    /**
     * What the signal proxies: revenue (used directly), headcount, or
     * customers (count-of-customers proxies like reviews). Inferred from the
     * metric name when omitted; set explicitly for unusual metrics.
     */
    dimension?: "revenue" | "headcount" | "customers";
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
    /** Alternate names/spellings for deterministic mention matching. */
    aliases?: string[];
    /** Public scale signals; see ScaleSignal. */
    scaleSignals?: ScaleSignal[];
    /**
     * ACV stratum ("smb" | "mid" | "enterprise" by convention) used to
     * calibrate customer-count → revenue conversion in the scale index.
     * Revenue-per-customer differs ~75× between SMB tools and enterprise
     * suites; stratifying kills the many-small-customers bias. Usually
     * obvious from the vendor's own pricing page (which the map captures).
     */
    acvBand?: string;
    /**
     * Optional brand logo for the report (legend + matrix headers). A `data:` URI
     * keeps the rendered report self-contained — no external requests, survives
     * being saved or emailed. The hosted service extracts it from the vendor's
     * homepage; CLI users can set it by hand. Renderers degrade gracefully to the
     * numbered swatch when absent.
     */
    logo?: string;
    notes?: string;
};
export type MarketAxis = {
    id: string;
    label: string;
    negativePole: string;
    positivePole: string;
    /** How a human scores a claim on this axis — the axis IS this rubric. */
    rubric: string;
    /** e.g. "validated", "proposal", "proposal (PC2-validated)". Reviewer-facing. */
    status?: string;
    /** claimId → score in [-1, 1]; null = the axis does not apply to this claim. */
    claimScores: Record<string, number | null>;
};
export type MarketConfig = {
    category: string;
    anchorVendor?: string;
    vendors: MarketVendor[];
    claims: MarketClaim[];
    /** The LOUD/QUIET/ABSENT/UNOBSERVABLE judging rule, stated for reviewers. */
    surfaceRule?: string;
    /** Strategic axes as claim-scoring rubrics — config, not code. */
    axes?: MarketAxis[];
    /** [xAxisId, yAxisId] for the report's strategic map. */
    primaryAxes?: [string, string];
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
export declare function assertPublicUrl(rawUrl: string): Promise<URL>;
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
