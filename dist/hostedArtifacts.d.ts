export type HostedArtifact = {
    kind: "icp" | "signal_run";
    key: string;
    label: string;
    domain?: string;
    document: unknown;
    sourceVersion?: string;
};
export type HostedArtifactResult = {
    status: "unpaired";
} | {
    status: "saved";
    created: boolean;
    updatedAt: number;
} | {
    status: "unavailable";
    reason: string;
};
export declare function writeHostedArtifact(artifact: HostedArtifact, options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}): Promise<HostedArtifactResult>;
