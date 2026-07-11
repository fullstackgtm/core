import type { Prospect } from "./connectors/prospectSources.ts";
export type ContactField = "work_email" | "mobile" | "direct_dial";
export type ContactInputShape = "linkedin" | "name_domain" | "email" | "phone" | "company_domain";
export type ContactProviderExecution = "sync" | "poll" | "webhook" | "batch";
export type ContactProviderBilling = "per_attempt" | "per_match" | "per_field" | "subscription" | "unknown";
export type ContactProviderCapability = {
    provider: string;
    operation: string;
    inputShapes: ContactInputShape[];
    outputFields: ContactField[];
    execution: ContactProviderExecution;
    billing: ContactProviderBilling;
    chargesOn: Array<"request" | "match" | "valid" | "accept_all" | "unknown">;
    supportsBalance: boolean;
    supportsIdempotency: boolean;
    maxBatchSize?: number;
};
/** Only implemented adapters belong here; planned providers stay in the strategy document. */
export declare const CONTACT_PROVIDER_CAPABILITIES: Readonly<Record<string, readonly ContactProviderCapability[]>>;
export type ContactWaterfallStep = {
    provider: string;
    fields: ContactField[];
};
export type ContactProviderAdapter = {
    provider: string;
    resolve(prospects: Prospect[], fields: ContactField[]): Promise<Prospect[]>;
};
export type ContactWaterfallAttempt = {
    provider: string;
    fields: ContactField[];
    attempted: number;
    added: Partial<Record<ContactField, number>>;
};
export type ContactWaterfallResult = {
    prospects: Prospect[];
    attempts: ContactWaterfallAttempt[];
};
export declare function validateContactWaterfall(steps: ContactWaterfallStep[]): ContactWaterfallStep[];
/** Run providers in order. Later steps receive only records still missing a requested field. */
export declare function runContactWaterfall(opts: {
    prospects: Prospect[];
    steps: ContactWaterfallStep[];
    adapters: Readonly<Record<string, ContactProviderAdapter>>;
}): Promise<ContactWaterfallResult>;
