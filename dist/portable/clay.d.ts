import type { Prospect } from "../connectors/prospectSources.ts";
export type ClayCompany = {
    name?: string;
    domain?: string;
    linkedin?: string;
    description?: string;
    industry?: string;
    size?: string;
    location?: string;
    fundingAmountRange?: string;
};
export declare function normalizeClayCompany(value: unknown): ClayCompany;
export declare function normalizeClayPerson(value: unknown): Prospect;
