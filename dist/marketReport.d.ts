import type { MarketConfig, ObservationSet } from "./market.ts";
/**
 * Serialize JSON for embedding inside an inline <script> block. JSON.stringify
 * does not escape `<`, `>`, `&`, or the U+2028/U+2029 line separators, so a
 * vendor name containing `</script>` (these are untrusted, competitor-authored
 * strings) would close the tag and inject markup. Replacing them with their
 * \uXXXX escapes keeps the parsed value identical while making the breakout
 * sequence unrepresentable in the HTML source.
 */
export declare function safeJsonForScript(value: unknown): string;
export declare function marketMapToMarkdown(config: MarketConfig, set: ObservationSet): string;
export declare function marketMapToHtml(config: MarketConfig, set: ObservationSet): string;
