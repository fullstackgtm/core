import { type LlmCallOptions } from "./llm.ts";
import { type CaptureEntry, type MarketClaim, type MarketConfig, type ObservationSet } from "./market.ts";
export type ClassifyMarketOptions = {
    llm: LlmCallOptions;
    /** Observation run label to produce; must be new (the store is append-only). */
    runLabel: string;
    /** Capture run to classify; defaults to the most recent run in the manifest. */
    captureRun?: string;
    /** Restrict to these vendor ids (e.g. one new vendor); defaults to all. */
    vendors?: string[];
    /** Captures directory override (tests); defaults to the profile market home. */
    capturesDir?: string;
    now?: () => Date;
    /** Per-vendor progress (presentation only — a throwing callback never fails the run). */
    onVendor?: (done: number, total: number, vendorId: string) => void;
};
export type ClassifyMarketResult = {
    set: ObservationSet;
    model: string;
    /** Cells where the model's quote failed mechanical verification and the retry fixed it. */
    retriedVendorIds: string[];
};
export declare function classifyMarket(config: MarketConfig, options: ClassifyMarketOptions): Promise<ClassifyMarketResult>;
/**
 * The agent-driven alternative to LLM classification: a worksheet carrying
 * everything needed to classify one vendor by hand or by an agent driving
 * the CLI/MCP — claims with judging definitions, the surface rule, and the
 * captured page texts. Submissions come back through `market observe`,
 * which runs the same validation and span verification as `classify`.
 */
export type MarketWorksheet = {
    category: string;
    captureRun: string;
    surfaceRule?: string;
    vendor: {
        id: string;
        name: string;
    };
    claims: MarketClaim[];
    pages: Array<{
        kind: CaptureEntry["kind"];
        url: string;
        captureHash: string;
        text: string;
    }>;
    instructions: string;
};
export declare function buildWorksheet(config: MarketConfig, vendorId: string, options?: {
    captureRun?: string;
    capturesDir?: string;
}): MarketWorksheet;
