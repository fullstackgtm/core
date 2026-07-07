import { type FieldMappings } from "../mappings.ts";
import type { GtmConnector, SnapshotProgress } from "../types.ts";
import { type ProgressEmitter } from "../progress.ts";
export type SalesforceConnection = {
    accessToken: string;
    /** e.g. https://yourorg.my.salesforce.com */
    instanceUrl: string;
};
export type SalesforceConnectorOptions = {
    /** Returns an access token plus the instance URL it belongs to. */
    getConnection: () => SalesforceConnection | Promise<SalesforceConnection>;
    /** Per-org canonical-to-provider field overrides. Defaults cover standard fields. */
    fieldMappings?: FieldMappings;
    apiVersion?: string;
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
 * Reference connector for Salesforce.
 *
 * Reads run SOQL with cursor pagination; writes PATCH sobjects directly.
 * Like the HubSpot connector, it never drops records it cannot fully resolve
 * (ownerless or amountless opportunities are returned so audit rules can
 * surface the gaps). Probabilities are normalized to 0..1 to match the
 * canonical model.
 */
export declare function createSalesforceConnector(options: SalesforceConnectorOptions): Required<GtmConnector>;
