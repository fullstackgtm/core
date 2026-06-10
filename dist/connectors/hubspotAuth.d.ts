export declare const DEFAULT_OAUTH_SCOPES: string[];
export declare const DEFAULT_LOOPBACK_PORT = 8763;
export type HubspotTokenSet = {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
};
export declare function validateHubspotToken(token: string, fetchImpl?: typeof fetch): Promise<{
    ok: boolean;
    detail: string;
}>;
export declare function exchangeHubspotCode(options: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    fetchImpl?: typeof fetch;
}): Promise<HubspotTokenSet>;
export declare function refreshHubspotToken(options: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    fetchImpl?: typeof fetch;
}): Promise<HubspotTokenSet>;
export type LoopbackLoginOptions = {
    clientId: string;
    clientSecret: string;
    /** Must match a redirect URL registered on the HubSpot app: http://localhost:<port>/callback */
    port?: number;
    scopes?: string[];
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    /** Receives the authorize URL; default prints it and best-effort opens a browser. */
    openUrl?: (url: string) => void | Promise<void>;
    log?: (message: string) => void;
};
/**
 * RFC 8252 loopback OAuth: serve one request on 127.0.0.1, send the user to
 * the provider consent page, capture the code locally, exchange it directly.
 */
export declare function runHubspotLoopbackLogin(options: LoopbackLoginOptions): Promise<HubspotTokenSet>;
export declare function openInBrowser(url: string): Promise<void>;
