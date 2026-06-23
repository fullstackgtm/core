/**
 * LinkedIn → acquire bridge (Phase 1, step 2).
 *
 * Connects the provider-agnostic LinkedIn discovery layer (connectors/linkedin.ts)
 * to the `enrich acquire` spine: pull prospects from a LinkedIn source, map them
 * to the canonical `Prospect`, and hand them to the existing ICP-score → dedup →
 * create_record → meter → dry-run/apply pipeline unchanged.
 *
 * Kept out of cli.ts on purpose: the only remaining wiring is a ~3-line
 * discovery branch in `acquireFromApi` (call `createLinkedInProvider` +
 * `discoverLinkedInProspects`), a `builtinAcquirePreset('linkedin')` entry, the
 * source allowlist/help, and a `login heyreach` credential. That lands once
 * cli.ts is clean of other in-flight work — see docs/linkedin-connector-spec.md.
 *
 * HeyReach reads a pre-populated lead LIST (not an ICP-driven search), and the
 * natural identity key is the LinkedIn profile URL — so acquire's matchKey is
 * `linkedin`, which means the spine skips pipe0 email resolution automatically.
 */
import { type HeyReachProviderOptions, type LinkedInProspect, type LinkedInProvider } from "./connectors/linkedin.ts";
import type { Prospect } from "./connectors/prospectSources.ts";
/** Map a normalized LinkedIn prospect into the canonical acquire `Prospect`. */
export declare function linkedInProspectToProspect(lp: LinkedInProspect): Prospect;
export type DiscoverLinkedInOptions = {
    /** Which source (HeyReach lead-list id) to read; provider may have a default. */
    sourceId?: string;
    /** Hard cap on prospects pulled. */
    max?: number;
};
/**
 * Discovery branch for `acquireFromApi`: read prospects from a LinkedIn source
 * and return them as canonical `Prospect`s. Read-only — never sends. The
 * provider is injected so this is fully testable against the fake (no key).
 */
export declare function discoverLinkedInProspects(provider: LinkedInProvider, options?: DiscoverLinkedInOptions): Promise<Prospect[]>;
export type CreateLinkedInProviderOptions = Omit<HeyReachProviderOptions, "apiKey">;
/**
 * Build the execution provider for a LinkedIn acquire source. HeyReach is the
 * default; `unipile` is the planned alternative (same interface). Called by the
 * cli acquire branch with the stored/env API key.
 */
export declare function createLinkedInProvider(source: string, apiKey: string, options?: CreateLinkedInProviderOptions): LinkedInProvider;
