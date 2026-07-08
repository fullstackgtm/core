import type { CanonicalGtmSnapshot } from "./types.ts";
export type StakeholderRole = "economic_buyer" | "decision_maker" | "technical_buyer" | "champion" | "influencer" | "unknown";
export type StakeholderSentiment = "positive" | "neutral" | "negative" | "unknown";
export type StakeholderNode = {
    contactId: string;
    name: string;
    title?: string;
    email?: string;
    role: StakeholderRole;
    sentiment: StakeholderSentiment;
    lastActivityAt?: string;
    evidence: string[];
};
export type RelationshipMap = {
    account: {
        accountId: string;
        name: string;
        domain?: string;
    };
    stakeholders: StakeholderNode[];
    openDeals: Array<{
        dealId: string;
        name: string;
        stage?: string;
        amount?: number;
        ownerId?: string;
    }>;
    gaps: string[];
    counts: {
        stakeholders: number;
        openDeals: number;
        activities: number;
    };
};
export declare function buildRelationshipMap(snapshot: CanonicalGtmSnapshot, selector: {
    accountId?: string;
    domain?: string;
}): RelationshipMap;
export declare function relationshipMapToMarkdown(map: RelationshipMap): string;
