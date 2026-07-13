import type { Prospect } from "./prospectSources.ts";
import { type ClayCompany } from "../portable/clay.ts";
export { normalizeClayCompany, normalizeClayPerson, type ClayCompany } from "../portable/clay.ts";
export declare const CLAY_PUBLIC_API_BASE = "https://api.clay.com/public/v0";
export type ClayKeyValidation = {
    ok: boolean;
    detail: string;
    workspaceId?: string;
};
export type ClaySearchSourceType = "people" | "companies";
export type ClayPeopleSearchPage = {
    prospects: Prospect[];
    hasMore: boolean;
};
export type ClayCompanySearchPage = {
    companies: ClayCompany[];
    hasMore: boolean;
};
/** Create a forward-only Clay search iterator. This call does not fetch a page. */
export declare function createClaySearch(opts: {
    apiKey: string;
    sourceType: ClaySearchSourceType;
    filters: Record<string, unknown>;
    fetchImpl?: typeof fetch;
    apiBaseUrl?: string;
}): Promise<string>;
/** Consume the next people page from a Clay search iterator. */
export declare function runClayPeopleSearchPage(opts: {
    apiKey: string;
    searchId: string;
    limit?: number;
    fetchImpl?: typeof fetch;
    apiBaseUrl?: string;
}): Promise<ClayPeopleSearchPage>;
/** Consume the next company page from a Clay search iterator. */
export declare function runClayCompanySearchPage(opts: {
    apiKey: string;
    searchId: string;
    limit?: number;
    fetchImpl?: typeof fetch;
    apiBaseUrl?: string;
}): Promise<ClayCompanySearchPage>;
/** Account-first investment discovery: find thesis-shaped companies, then
 * resolve founders/operators only inside those accounts. */
export declare function discoverClayInvestmentProspects(opts: {
    apiKey: string;
    companyFilters: Record<string, unknown>;
    titleKeywords: string[];
    companyLimit: number;
    prospectLimit: number;
    fetchImpl?: typeof fetch;
    apiBaseUrl?: string;
}): Promise<{
    prospects: Prospect[];
    companiesScanned: number;
    companiesMatched: ClayCompany[];
}>;
/** Validate a Clay Public API key without creating a search or spending enrichment credits. */
export declare function validateClayApiKey(apiKey: string, fetchImpl?: typeof fetch, apiBaseUrl?: string): Promise<ClayKeyValidation>;
/** Resolve Clay credentials using the standard env -> profile-scoped store ladder. */
export declare function clayApiKey(env?: Record<string, string | undefined>): string;
