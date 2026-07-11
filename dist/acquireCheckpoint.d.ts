/** The complete identity of one independently traversable provider audience. */
export type AcquireCheckpointKey = {
    provider: string;
    source: string;
    listId: string | null;
    queryFingerprint: string;
};
export type AcquireContinuation = {
    cursor?: string | null;
    offset?: number | null;
    exhausted: boolean;
};
/** Versioned wire format shared by local persistence and hosted sync. */
export type AcquireCheckpoint = {
    version: 1;
    id: string;
    key: AcquireCheckpointKey;
    continuation: AcquireContinuation;
    updatedAt: string;
};
export declare function validateAcquireCheckpointKey(value: unknown): AcquireCheckpointKey;
/** Stable, non-secret filename/key suitable for both filesystem and hosted records. */
export declare function acquireCheckpointId(key: AcquireCheckpointKey): string;
export declare function validateAcquireCheckpoint(value: unknown): AcquireCheckpoint;
export declare function acquireCheckpointsDir(baseDir?: string): string;
export interface AcquireCheckpointStore {
    get(key: AcquireCheckpointKey): Promise<AcquireCheckpoint | null>;
    put(key: AcquireCheckpointKey, continuation: AcquireContinuation, updatedAt?: Date): Promise<AcquireCheckpoint>;
    /** Import a validated local/hosted record without changing its timestamp. */
    putRecord(record: AcquireCheckpoint): Promise<AcquireCheckpoint>;
    list(): Promise<AcquireCheckpoint[]>;
}
export declare function createFileAcquireCheckpointStore(baseDir?: string): AcquireCheckpointStore;
