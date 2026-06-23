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
import { createHeyReachProvider, } from "./connectors/linkedin.js";
/** Map a normalized LinkedIn prospect into the canonical acquire `Prospect`. */
export function linkedInProspectToProspect(lp) {
    return {
        firstName: lp.firstName || undefined,
        lastName: lp.lastName || undefined,
        fullName: lp.fullName,
        // Title drives ICP scoring; fall back to the headline when no title is set.
        jobTitle: lp.jobTitle ?? lp.headline,
        companyName: lp.company,
        linkedin: lp.profileUrl || undefined,
        email: lp.email,
        // The profile URL is LinkedIn's stable native id — use it for traceability.
        sourceId: lp.profileUrl || undefined,
    };
}
/**
 * Discovery branch for `acquireFromApi`: read prospects from a LinkedIn source
 * and return them as canonical `Prospect`s. Read-only — never sends. The
 * provider is injected so this is fully testable against the fake (no key).
 */
export async function discoverLinkedInProspects(provider, options = {}) {
    const raw = await provider.fetchProspects({ sourceId: options.sourceId, max: options.max });
    return raw.map(linkedInProspectToProspect);
}
/**
 * Build the execution provider for a LinkedIn acquire source. HeyReach is the
 * default; `unipile` is the planned alternative (same interface). Called by the
 * cli acquire branch with the stored/env API key.
 */
export function createLinkedInProvider(source, apiKey, options = {}) {
    switch (source) {
        case "linkedin":
        case "heyreach":
            return createHeyReachProvider({ apiKey, ...options });
        default:
            throw new Error(`Unknown LinkedIn execution provider "${source}" (supported: heyreach).`);
    }
}
