import type { Icp, TriggerHypothesis } from "./icp.ts";
import { type Signal, type SignalsConfig } from "./signals.ts";
export declare const DEFAULT_DISCOVERY_ATS_DOMAINS: string[];
export type EvidenceCandidate = {
    hypothesisId: string;
    hypothesisLabel: string;
    companyName: string;
    jobTitle: string;
    sourceUrl: string;
    quote: string;
    publishedAt?: string;
    accountDomain?: string;
};
export type SignalDiscoverySummary = {
    provider: "exa";
    readOnly: true;
    searchesUsed: number;
    searchLimit: number;
    costUsd: number;
    costLimitUsd: number;
    rawResults: number;
    matchedEvidence: number;
    resolvedAccounts: number;
    unresolvedAccounts: number;
    warnings: string[];
};
export type SignalDiscoveryResult = {
    summary: SignalDiscoverySummary;
    candidates: EvidenceCandidate[];
    signals: Signal[];
};
export type DiscoverSignalsOptions = {
    icp: Icp;
    apiKey: string;
    since: Date;
    maxAccounts: number;
    maxResults: number;
    maxSearches: number;
    maxUsd: number;
    now?: Date;
    config?: SignalsConfig;
    fetch?: typeof globalThis.fetch;
    apiBaseUrl?: string;
};
/** Explicit hypotheses win; intent topics remain a backwards-compatible fallback. */
export declare function triggerHypothesesForIcp(icp: Icp): TriggerHypothesis[];
export declare function exaQueryForHypothesis(hypothesis: TriggerHypothesis): string;
export declare function parseJobIdentity(rawTitle: string, sourceUrl?: string): {
    companyName: string;
    jobTitle: string;
} | null;
export declare function discoverSignalsWithExa(options: DiscoverSignalsOptions): Promise<SignalDiscoveryResult>;
