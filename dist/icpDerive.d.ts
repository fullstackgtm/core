import { type LlmCallOptions } from "./llm.ts";
import type { Icp } from "./icp.ts";
import { type WebsiteIcpDerivation } from "./portable/icpDeriveContract.ts";
export type { WebsiteIcpDerivation, WebsiteIcpEvidence } from "./portable/icpDeriveContract.ts";
export declare const DEFAULT_ICP_DERIVATION_MODEL = "z-ai/glm-5.2";
export declare const OPENROUTER_API_BASE = "https://openrouter.ai/api";
export type IcpDerivationProgress = {
    stage: "fetch" | "model" | "verify";
    message: string;
};
export declare function normalizeCompanyWebsite(raw: string): {
    domain: string;
    url: string;
};
export declare function websiteText(html: string): string;
export declare function deriveWebsiteIcp(args: {
    domain: string;
    apiKey?: string;
    llm?: LlmCallOptions;
    model?: string;
    fetchPages?: (url: string) => Promise<{
        text: string;
        finalUrl: string;
    } | null>;
    derive?: (prompt: string, model: string) => Promise<Record<string, unknown>>;
    onProgress?: (event: IcpDerivationProgress) => void;
}): Promise<WebsiteIcpDerivation>;
export type IcpReviewSegment = {
    id: string;
    label: string;
    value: string;
    kind: "list" | "number";
};
export declare function icpReviewSegments(icp: Icp): IcpReviewSegment[];
