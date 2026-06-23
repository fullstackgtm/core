/**
 * LinkedIn connector — Phase 1 discovery (read-only).
 *
 * A provider-agnostic surface for pulling prospects out of LinkedIn via a
 * rented execution layer (default: HeyReach; Unipile is a drop-in alternative).
 * Deliberately decoupled from the acquire spine — the `Icp`→filter and
 * `LinkedInProspect`→`Prospect` bridges live in the `enrich acquire --source
 * linkedin` wiring, not here — so this layer can land and be tested on its own.
 *
 * Phase 2 (future) extends `LinkedInProvider` with send actions
 * (connect/message) routed through the plan/apply gate. Spec:
 * docs/linkedin-connector-spec.md. Nothing here ever writes or sends.
 */
export type LinkedInProspect = {
    firstName: string;
    lastName: string;
    fullName?: string;
    headline?: string;
    jobTitle?: string;
    company?: string;
    /** Canonical LinkedIn profile URL — the identity key dedup uses downstream. */
    profileUrl: string;
    location?: string;
    email?: string;
    emailStatus?: string;
    /** The raw provider payload, preserved for debugging and later mapping. */
    raw?: unknown;
};
export type LinkedInSource = {
    /** Provider-native id of a prospect source (HeyReach: a lead-list id). */
    id: string;
    name: string;
    /** Approximate prospect count, when the provider reports it. */
    count?: number;
};
export type FetchProspectsOptions = {
    /** Which source to read (HeyReach lead-list id); provider may have a default. */
    sourceId?: string;
    /** Hard cap on prospects returned; also bounds pagination. */
    max?: number;
};
export type ConnectionStatus = {
    ok: boolean;
    detail: string;
};
/**
 * Provider-agnostic LinkedIn discovery surface (Phase 1). Read-only: it
 * enumerates prospect sources and pulls normalized prospects, never sends.
 */
export interface LinkedInProvider {
    readonly name: string;
    /** Cheap auth/connectivity check; never throws — returns ok:false instead. */
    checkConnection(): Promise<ConnectionStatus>;
    /** Enumerate prospect sources (HeyReach lead lists). */
    listSources(): Promise<LinkedInSource[]>;
    /** Pull prospects from a source, normalized + capped. */
    fetchProspects(options?: FetchProspectsOptions): Promise<LinkedInProspect[]>;
}
export declare const HEYREACH_BASE = "https://api.heyreach.io/api/public";
export type HeyReachProviderOptions = {
    apiKey: string;
    fetchImpl?: typeof fetch;
    baseUrl?: string;
    /** Lead-list id used when fetchProspects is called without an explicit sourceId. */
    defaultListId?: string;
    /** Page size for paginated reads (≤ server max). Lower in tests. */
    pageSize?: number;
};
export declare function createHeyReachProvider(options: HeyReachProviderOptions): LinkedInProvider;
/** Map a HeyReach lead (nested `profile` or flat) into the normalized shape. */
export declare function normalizeHeyReachLead(raw: any): LinkedInProspect;
export declare const FAKE_LINKEDIN_PROSPECTS: LinkedInProspect[];
export type FakeLinkedInOptions = {
    prospects?: LinkedInProspect[];
    sources?: LinkedInSource[];
    connection?: ConnectionStatus;
};
export declare function createFakeLinkedInProvider(opts?: FakeLinkedInOptions): LinkedInProvider;
