import { type LlmCallOptions } from "./llm.ts";
import { type FetchPage, type MarketConfig, type MarketStore } from "./market.ts";
/**
 * Cold-start taxonomy bootstrap. `market init` writes a stub for a human
 * analyst to fill in; the self-serve hosted map has no analyst in the loop, so
 * this proposes the claim taxonomy automatically from the seed vendors' own
 * pages.
 *
 * Posture matches the rest of the market layer: the LLM is a *proposal* layer
 * grounded in captured evidence (it only sees text we actually fetched), and
 * everything downstream — capture, classify with verbatim-span verification,
 * front states, the report — stays deterministic over the stored observations.
 * The taxonomy it emits is a normal `market.config.json` a human can still edit.
 */
export type SeedVendor = {
    url: string;
    /** Display name; derived from the host when omitted. */
    name?: string;
    /** Marks the user's own company as the anchor vendor. */
    anchor?: boolean;
};
export type SuggestTaxonomyOptions = {
    category: string;
    vendors: SeedVendor[];
    llm: LlmCallOptions;
    /** Upper bound on proposed claims, to keep classification bounded. */
    maxClaims?: number;
    /** Per-vendor captured-text budget fed to the proposer (chars). */
    perVendorChars?: number;
    /** Test injectables. */
    fetchPage?: FetchPage;
    capturesDir?: string;
    /**
     * Storage seam for the bootstrap captures; defaults to the file layout.
     * Pass createMemoryMarketStore for throwaway grounding (hosted flow).
     */
    store?: MarketStore;
    now?: () => Date;
};
export type SuggestTaxonomyResult = {
    config: MarketConfig;
    /** Vendors whose homepage capture was empty/failed (excluded from grounding). */
    unreadableVendorIds: string[];
    model: string;
};
export declare function suggestMarketConfig(options: SuggestTaxonomyOptions): Promise<SuggestTaxonomyResult>;
