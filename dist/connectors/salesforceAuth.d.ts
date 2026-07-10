/**
 * Salesforce CLI authentication.
 *
 * Salesforce supports the device-authorization grant natively, which is the
 * ideal CLI shape: no localhost server, no client secret — just a code the
 * user confirms on any device. Requires a Connected App with device flow
 * enabled; only its consumer key (client id) is needed.
 */
/**
 * Normalize and validate a Salesforce credential-bearing origin.
 *
 * Salesforce API hosts are either the standard login/sandbox hosts or a
 * Salesforce-owned instance/My Domain below salesforce.com.  Deliberately
 * return an origin (not the input URL) so callers cannot accidentally retain
 * paths, queries, credentials, or fragments from configuration.
 */
export declare function validateSalesforceOrigin(value: string, label?: string): string;
export type SalesforceTokenSet = {
    accessToken: string;
    refreshToken?: string;
    instanceUrl: string;
    /** Conservative local expiry; Salesforce session length is org-defined. */
    expiresAt: number;
};
export type SalesforceDeviceAuthorization = {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    intervalSeconds: number;
};
export declare function startSalesforceDeviceLogin(options: {
    clientId: string;
    loginUrl?: string;
    fetchImpl?: typeof fetch;
}): Promise<SalesforceDeviceAuthorization>;
export declare function pollSalesforceDeviceLogin(options: {
    clientId: string;
    deviceCode: string;
    intervalSeconds: number;
    loginUrl?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): Promise<SalesforceTokenSet>;
export declare function refreshSalesforceToken(options: {
    clientId: string;
    refreshToken: string;
    loginUrl?: string;
    fetchImpl?: typeof fetch;
}): Promise<SalesforceTokenSet>;
export declare function validateSalesforceToken(accessToken: string, instanceUrl: string, fetchImpl?: typeof fetch): Promise<{
    ok: boolean;
    detail: string;
}>;
