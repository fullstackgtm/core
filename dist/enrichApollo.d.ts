import type { CanonicalGtmSnapshot } from "./types.ts";
import type { EnrichObjectType, EnrichSourceRecord, EnrichWorkItem } from "./enrich.ts";
export type ApolloClientOptions = {
    getApiKey: () => string | Promise<string>;
    apiBaseUrl?: string;
    /** Injectable fetch for testing — tests must never hit the real Apollo API. */
    fetchImpl?: typeof fetch;
    /** Max retries after a 429 (default 3). */
    maxRetries?: number;
    /** Injectable sleep for testing backoff without waiting. */
    sleep?: (ms: number) => Promise<void>;
};
export type ApolloClient = {
    /** GET /api/v1/organizations/enrich?domain=… → response body, or null on no data. */
    enrichOrganization(domain: string): Promise<Record<string, unknown> | null>;
    /** POST /api/v1/people/match { email } → response body, or null on no data. */
    matchPerson(email: string): Promise<Record<string, unknown> | null>;
};
export declare function createApolloClient(options: ApolloClientOptions): ApolloClient;
export type ApolloPullKey = {
    objectType: EnrichObjectType;
    /** "domain" for companies, "email" for contacts. */
    key: "domain" | "email";
    value: string;
};
export type ApolloPullResult = {
    records: EnrichSourceRecord[];
    /** Pull keys Apollo returned no data for. */
    misses: ApolloPullKey[];
};
export type ApolloPullProgress = {
    /** The pull key just processed — the run-store cursor value. */
    lastKeyValue: string;
    record?: EnrichSourceRecord;
    miss?: ApolloPullKey;
};
export type ApolloPullOptions = {
    /** Resume checkpoint: pull keys at or before this value are skipped. */
    resumeAfter?: string | null;
    /** Checkpoint callback after each pull key is processed. */
    onProgress?: (progress: ApolloPullProgress) => void | Promise<void>;
};
/**
 * Pull keys for an append run: records of the requested types where at least
 * one configured field is blank and the pull key (companies: domain,
 * contacts: email) is present. Deduplicated — two CRM companies sharing a
 * domain produce ONE Apollo call, and the matcher then reports the collision.
 */
export declare function apolloPullKeysForAppend(snapshot: CanonicalGtmSnapshot, objectTypes: EnrichObjectType[], needsEnrichment: (objectType: EnrichObjectType, record: Record<string, unknown>) => boolean): ApolloPullKey[];
/** Pull keys for a refresh run: the stale work set mapped back to pull keys. */
export declare function apolloPullKeysForRefresh(snapshot: CanonicalGtmSnapshot, workSet: EnrichWorkItem[]): ApolloPullKey[];
/**
 * Execute the pull: one Apollo call per key, normalized into source records.
 * Sequential on purpose (enrichment endpoints rate-limit aggressively); the
 * 429 backoff lives in the client. `onProgress` checkpoints the run-store
 * cursor after every key so an interrupted pull resumes instead of re-paying
 * for completed lookups.
 */
export declare function pullApolloRecords(client: ApolloClient, keys: ApolloPullKey[], options?: ApolloPullOptions): Promise<ApolloPullResult>;
