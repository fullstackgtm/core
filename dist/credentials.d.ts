/**
 * Local CLI credential store: ~/.fullstackgtm/credentials.json (0600), or
 * $FSGTM_HOME/credentials.json when set. Environment tokens always win over
 * stored credentials so CI and agent sandboxes never touch the filesystem.
 *
 * Profiles let one operator hold credentials for several organizations at
 * once (a consultant working across client CRMs). The default profile keeps
 * the historical layout; a named profile scopes the entire home — credentials
 * AND stored plans — under `profiles/<name>/`, so a patch plan proposed
 * against one client's CRM can never be applied through another client's
 * credentials.
 */
export declare const DEFAULT_PROFILE = "default";
export declare function validateProfileName(name: string): string;
/** Select the profile for this process; wins over $FULLSTACKGTM_PROFILE. */
export declare function setActiveProfile(name: string): void;
export declare function activeProfile(): string;
/** Base home directory, shared by every profile. */
export declare function baseHomeDir(): string;
/**
 * Profiles that exist on disk (have a directory), always including the
 * default profile. Existence does not imply stored credentials.
 */
export declare function listProfiles(): string[];
export type StoredCredential = {
    kind: "private_app" | "oauth" | "broker" | "api_key";
    accessToken: string;
    refreshToken?: string;
    /** Epoch ms when the access token expires (oauth only). */
    expiresAt?: number;
    /** Client credentials kept for refresh when the user brings their own app. */
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
    /** Hosted FullStackGTM deployment the broker token belongs to. */
    baseUrl?: string;
    /** Salesforce instance URL the access token belongs to. */
    instanceUrl?: string;
    /** Salesforce login host used for device flow refresh. */
    loginUrl?: string;
    createdAt: string;
    updatedAt: string;
};
export declare function credentialsDir(): string;
export declare function credentialsPath(): string;
/**
 * Create the fullstackgtm home directory and force it to 0700 even if it
 * already existed at looser permissions (mkdirSync's `mode` is ignored for
 * existing directories, and is subject to umask for new ones). All writers of
 * sensitive data under the home — credentials and plan files — go through
 * this so directory permissions are actually enforced, not merely requested.
 */
export declare function ensureSecureHomeDir(): string;
/** Write a 0600 file under the home, enforcing the mode even on rewrite. */
export declare function writeSecureFile(path: string, contents: string): void;
export declare function getCredential(provider: string): StoredCredential | null;
export declare function storeCredential(provider: string, credential: StoredCredential): void;
export declare function deleteCredential(provider: string): boolean;
export type HubspotConnection = {
    accessToken: string;
    /** Org-level field mapping overrides, supplied by broker deployments. */
    fieldMappings?: unknown;
};
/**
 * Resolve HubSpot access from stored credentials. Direct logins win over the
 * broker so an operator can always override the team default:
 * 1. stored hubspot login (private app token, or OAuth with silent refresh)
 * 2. stored broker pairing — exchanges the CLI token for a short-lived
 *    provider token minted by the hosted deployment from the org's stored
 *    sync credentials (and inherits the org's field mappings)
 */
export declare function resolveHubspotConnection(options?: {
    fetchImpl?: typeof fetch;
}): Promise<HubspotConnection | null>;
export type SalesforceStoredConnection = {
    accessToken: string;
    instanceUrl: string;
    /** Org-level field mapping overrides, supplied by broker deployments. */
    fieldMappings?: unknown;
};
/**
 * Resolve Salesforce access from stored credentials, same ladder shape as
 * HubSpot: direct login (with silent device-flow refresh) wins over broker.
 */
export declare function resolveSalesforceConnection(options?: {
    fetchImpl?: typeof fetch;
}): Promise<SalesforceStoredConnection | null>;
/**
 * Resolve a usable HubSpot access token (direct login or broker). Returns
 * null when nothing is stored (callers fall back to instructions).
 */
export declare function resolveHubspotAccessToken(options?: {
    fetchImpl?: typeof fetch;
}): Promise<string | null>;
