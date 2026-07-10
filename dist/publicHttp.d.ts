export declare const DEFAULT_PUBLIC_HTTP_MAX_BYTES = 5000000;
export type PublicAddress = {
    address: string;
    family: number;
};
export type PublicLookup = (hostname: string) => Promise<PublicAddress[]>;
export declare function ipIsPrivate(ip: string): boolean;
/** Resolve once and reject the entire hostname if any answer is non-public. */
export declare function resolvePublicAddresses(hostname: string, lookup?: PublicLookup): Promise<PublicAddress[]>;
export declare function assertPublicUrl(rawUrl: string, lookup?: PublicLookup): Promise<URL>;
export type PublicHttpResult = {
    status: number;
    headers: Headers;
    body: Uint8Array;
    finalUrl: string;
};
type HopResult = Omit<PublicHttpResult, "finalUrl">;
export type PublicRequestHop = (url: URL, addresses: PublicAddress[], headers: Record<string, string>, timeoutMs: number, maxBytes: number) => Promise<HopResult>;
/** Public-only GET with DNS pinning, bounded bodies, and per-hop redirect validation. */
export declare function publicHttpGet(rawUrl: string, options?: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    lookup?: PublicLookup;
    requestHop?: PublicRequestHop;
}): Promise<PublicHttpResult>;
export {};
