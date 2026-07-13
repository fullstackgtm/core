export type HostedArtifactKind = "icp" | "signal_run" | "lead_run";
export type HostedArtifact = {
    kind: HostedArtifactKind;
    key: string;
    label: string;
    domain?: string;
    document: unknown;
    sourceVersion?: string;
    expectedRevision?: number;
    changeSummary?: string;
};
export type HostedArtifactState = HostedArtifact & {
    artifactId: string;
    revision: number;
    documentSha256?: string;
    origin: "cli" | "hosted";
    updatedAt: number;
};
export type HostedArtifactResult = {
    status: "unpaired";
} | {
    status: "saved";
    artifactId: string;
    created: boolean;
    updatedAt: number;
    revision: number;
    documentSha256: string;
    unchanged: boolean;
} | {
    status: "conflict";
    reason: string;
    currentRevision?: number;
    documentSha256?: string;
} | {
    status: "unavailable";
    reason: string;
};
export type HostedArtifactReadResult = {
    status: "unpaired";
} | {
    status: "found";
    state: HostedArtifactState;
} | {
    status: "missing";
} | {
    status: "unavailable";
    reason: string;
};
export declare function readHostedArtifact(kind: HostedArtifactKind, key: string, options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}): Promise<HostedArtifactReadResult>;
export declare function writeHostedArtifact(artifact: HostedArtifact, options?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}): Promise<HostedArtifactResult>;
