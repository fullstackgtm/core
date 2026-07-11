import type { AcquireDiscoveryCheckpoint } from "./enrich.ts";
export type HostedAcquireCheckpoint = {
    checkpoint: AcquireDiscoveryCheckpoint;
    /** Opaque server revision used only for compare-and-swap. */
    version: number;
    updatedAt: number;
};
export type HostedCheckpointReadResult = {
    status: "unpaired";
} | {
    status: "missing";
} | {
    status: "found";
    record: HostedAcquireCheckpoint;
} | {
    status: "unavailable";
    reason: string;
};
export type HostedCheckpointWriteResult = {
    status: "unpaired";
} | {
    status: "saved";
    record: HostedAcquireCheckpoint;
} | {
    status: "conflict";
    current: HostedAcquireCheckpoint | null;
} | {
    status: "unavailable";
    reason: string;
};
type Options = {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
};
/** Read a query/list checkpoint. Inert unless this profile is paired. */
export declare function readHostedAcquireCheckpoint(key: string, options?: Options): Promise<HostedCheckpointReadResult>;
/**
 * Mirror a local checkpoint using compare-and-swap. Pass null only when the
 * caller observed no hosted record (sent as version zero); pass the exact
 * positive version returned by read for an update.
 */
export declare function writeHostedAcquireCheckpoint(key: string, checkpoint: AcquireDiscoveryCheckpoint, expectedVersion: number | null, options?: Options): Promise<HostedCheckpointWriteResult>;
export {};
