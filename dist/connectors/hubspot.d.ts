import { type FieldMappings } from "../mappings.ts";
import type { GtmConnector } from "../types.ts";
export type HubspotConnectorOptions = {
    /** Returns a HubSpot access token (private app token or OAuth access token). */
    getAccessToken: () => string | Promise<string>;
    /** Per-org canonical-to-provider field overrides. Defaults cover standard properties. */
    fieldMappings?: FieldMappings;
    apiBaseUrl?: string;
    /** Injectable fetch for testing. */
    fetchImpl?: typeof fetch;
};
/**
 * Reference connector for HubSpot.
 *
 * Unlike sync pipelines that drop records they cannot fully resolve, the
 * connector returns every record it can read — including ownerless or
 * amountless deals — so audit rules can surface the gaps instead of hiding
 * them.
 */
export declare function createHubspotConnector(options: HubspotConnectorOptions): Required<GtmConnector>;
