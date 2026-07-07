import { type FieldMappings } from "../mappings.ts";
import type { GtmConnector, SnapshotProgress } from "../types.ts";
import { type ProgressEmitter } from "../progress.ts";
export type HubspotWritableConnector = GtmConnector & Required<Pick<GtmConnector, "applyOperation" | "readField">>;
export type HubspotConnectorOptions = {
    /** Returns a HubSpot access token (private app token or OAuth access token). */
    getAccessToken: () => string | Promise<string>;
    /** Per-org canonical-to-provider field overrides. Defaults cover standard properties. */
    fieldMappings?: FieldMappings;
    apiBaseUrl?: string;
    /** Injectable fetch for testing. */
    fetchImpl?: typeof fetch;
    /** Per-page snapshot-pull progress (presentation only — errors are swallowed). */
    onProgress?: (progress: SnapshotProgress) => void;
    /**
     * Shared progress vocabulary (src/progress.ts): the snapshot pull emits a
     * `stage` per object type and an `items` heartbeat per page. Additive
     * alongside the legacy `onProgress` callback; both are presentation-only.
     */
    progress?: ProgressEmitter;
};
/**
 * Reference connector for HubSpot.
 *
 * Unlike sync pipelines that drop records they cannot fully resolve, the
 * connector returns every record it can read — including ownerless or
 * amountless deals — so audit rules can surface the gaps instead of hiding
 * them.
 */
export declare function createHubspotConnector(options: HubspotConnectorOptions): HubspotWritableConnector;
