import type { EnrichObjectType } from "./enrich.ts";
import type { ApolloPullKey as EnrichPullKey, ApolloPullOptions as EnrichPullOptions, ApolloPullResult as EnrichPullResult } from "./enrichApollo.ts";
/**
 * ZoomInfo source adapter for governed enrichment.
 *
 * ZoomInfo owns authentication and credit accounting in its official `gtm`
 * CLI. fullstackgtm invokes that CLI as a read-only source, normalizes the
 * JSON response, then sends proposed CRM changes through the normal
 * diff → patch plan → approval → apply lifecycle. No ZoomInfo credential is
 * copied into fullstackgtm and this adapter never writes to the CRM directly.
 */
export type ZoomInfoCommandResult = {
    stdout: string;
    stderr: string;
};
export type ZoomInfoCommandRunner = (executable: string, args: string[]) => Promise<ZoomInfoCommandResult>;
export type ZoomInfoClientOptions = {
    /** Official ZoomInfo CLI executable. Defaults to `gtm`. */
    executable?: string;
    /** Injectable command runner for tests. */
    run?: ZoomInfoCommandRunner;
};
export type ZoomInfoClient = {
    enrichCompany(domain: string): Promise<unknown>;
    enrichContact(email: string): Promise<unknown>;
};
export declare function createZoomInfoClient(options?: ZoomInfoClientOptions): ZoomInfoClient;
/** Pull snapshot-driven enrichment keys through ZoomInfo's official CLI. */
export declare function pullZoomInfoRecords(client: ZoomInfoClient, keys: EnrichPullKey[], options?: EnrichPullOptions): Promise<EnrichPullResult>;
export type ZoomInfoPullKey = EnrichPullKey;
export type ZoomInfoPullOptions = EnrichPullOptions;
export type ZoomInfoPullResult = EnrichPullResult;
export type ZoomInfoObjectType = EnrichObjectType;
