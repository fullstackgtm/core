import { type Icp } from "./icp.ts";
import { type HostedArtifactState } from "./hostedArtifacts.ts";
export type IcpSyncState = {
    version: 1;
    artifactId: string;
    key: string;
    domain: string;
    revision: number;
    localIcpSha256: string;
    hostedDocumentSha256?: string;
    syncedAt: string;
};
export type IcpSyncStatus = {
    state: "unpaired" | "missing_hosted" | "in_sync" | "local_changed" | "hosted_changed" | "conflict" | "untracked" | "unavailable";
    localIcpSha256: string;
    hostedRevision?: number;
    trackedRevision?: number;
    reason?: string;
};
export declare function classifyIcpSync(localHash: string, hostedRevision: number, hostedHash: string, tracked: IcpSyncState | null): IcpSyncStatus["state"];
export declare function canonicalJson(value: unknown): string;
export declare const icpSha256: (icp: Icp) => string;
export declare function artifactKeyForDomain(domain: string): string;
export declare const sidecarPathFor: (icpPath: string) => string;
export declare function readLocalIcp(path: string): Icp;
export declare function extractHostedIcp(state: HostedArtifactState): Icp;
export declare function readIcpSyncState(icpPath: string): IcpSyncState | null;
export declare function writeIcpSyncState(icpPath: string, state: IcpSyncState): void;
export declare function getIcpSyncStatus(icpPath: string, domain: string): Promise<{
    status: IcpSyncStatus;
    hosted?: HostedArtifactState;
    local: Icp;
}>;
export declare function markIcpSynced(icpPath: string, domain: string, hosted: HostedArtifactState | {
    artifactId: string;
    revision: number;
    documentSha256?: string;
}, icp: Icp): void;
export declare function pushIcp(icpPath: string, domain: string, changeSummary?: string): Promise<{
    status: "conflict";
    checked: {
        status: IcpSyncStatus;
        hosted?: HostedArtifactState;
        local: Icp;
    };
    result?: undefined;
} | {
    status: "conflict" | "unpaired" | "unavailable" | "saved";
    result: import("./hostedArtifacts.ts").HostedArtifactResult;
    checked: {
        status: IcpSyncStatus;
        hosted?: HostedArtifactState;
        local: Icp;
    };
}>;
