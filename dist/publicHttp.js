import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
export const DEFAULT_PUBLIC_HTTP_MAX_BYTES = 5_000_000;
function ipv4IsPrivate(ip) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
        return true;
    const [a, b, c] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113) || a >= 224;
}
function embeddedIpv4IsPrivate(high, low) {
    const hi = Number.parseInt(high, 16);
    const lo = Number.parseInt(low, 16);
    if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi > 0xffff || lo > 0xffff)
        return true;
    return ipv4IsPrivate(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
}
export function ipIsPrivate(ip) {
    const family = isIP(ip);
    if (family === 4)
        return ipv4IsPrivate(ip);
    if (family !== 6)
        return true;
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1")
        return true;
    const embedded = lower.match(/^::(?:ffff:)?([0-9a-f]+):([0-9a-f]+)$/);
    if (embedded)
        return embeddedIpv4IsPrivate(embedded[1], embedded[2]);
    const embeddedDotted = lower.match(/^::(?:ffff:)?(.+\..+)$/);
    if (embeddedDotted)
        return ipv4IsPrivate(embeddedDotted[1]);
    const nat64 = lower.match(/^64:ff9b::([0-9a-f]+):([0-9a-f]+)$/);
    if (nat64)
        return embeddedIpv4IsPrivate(nat64[1], nat64[2]);
    const sixToFour = lower.match(/^2002:([0-9a-f]+):([0-9a-f]+):/);
    if (sixToFour)
        return embeddedIpv4IsPrivate(sixToFour[1], sixToFour[2]);
    return /^(?:fc|fd)/.test(lower) || /^(?:fe8|fe9|fea|feb)/.test(lower) ||
        lower.startsWith("ff") || lower.startsWith("100:") ||
        lower.startsWith("2001:db8:") || lower.startsWith("2001:0:") ||
        lower.startsWith("2001:10:") || lower.startsWith("3fff:") ||
        lower.startsWith("64:ff9b:1:");
}
const systemLookup = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({ address, family }));
/** Resolve once and reject the entire hostname if any answer is non-public. */
export async function resolvePublicAddresses(hostname, lookup = systemLookup) {
    const literal = hostname.replace(/^\[|\]$/g, "");
    const family = isIP(literal);
    const addresses = family ? [{ address: literal, family }] : await lookup(literal);
    if (addresses.length === 0)
        throw new Error(`public HTTP: ${literal} did not resolve to an address.`);
    for (const { address } of addresses) {
        if (ipIsPrivate(address))
            throw new Error(`public HTTP refuses ${literal} — it resolves to private/internal address ${address} (SSRF guard).`);
    }
    return addresses;
}
export async function assertPublicUrl(rawUrl, lookup = systemLookup) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        throw new Error(`market capture: "${rawUrl}" is not a valid URL.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`market capture refuses ${url.protocol} URLs (only http/https): ${rawUrl}`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && ipIsPrivate(host)) {
        throw new Error(`market capture refuses private/loopback address ${host} (SSRF guard).`);
    }
    const addresses = await resolvePublicAddresses(host, lookup);
    // Keep the resolved set available to the request path without changing the public API.
    Object.defineProperty(url, "__publicAddresses", { value: addresses });
    return url;
}
const requestHop = (url, addresses, headers, timeoutMs, maxBytes) => new Promise((resolve, reject) => {
    let cursor = 0;
    const options = {
        protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
        path: `${url.pathname}${url.search}`, method: "GET", headers,
        // Node 20+ enables family autoselection by default and calls custom lookup
        // functions with `{ all: true }`. This transport already resolved and
        // validated every address, then pins one exact address per socket attempt;
        // disable the second selection layer so the callback keeps the classic
        // single-address contract and can never fall back to system DNS.
        autoSelectFamily: false,
        lookup: (_hostname, options, callback) => {
            const requestedFamily = typeof options === "number" ? options : options?.family;
            const eligible = requestedFamily ? addresses.filter((a) => a.family === requestedFamily) : addresses;
            const selected = eligible[cursor++ % eligible.length];
            if (!selected)
                return callback(new Error("public HTTP: no validated address matches the requested family"), "", 0);
            callback(null, selected.address, selected.family);
        },
    };
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(options, (res) => {
        if (maxBytes === 0) {
            resolve({ status: res.statusCode ?? 0, headers: new Headers(res.headers), body: new Uint8Array() });
            res.destroy();
            return;
        }
        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                req.destroy(new Error(`public HTTP response exceeds ${maxBytes} bytes`));
                return;
            }
            chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: new Headers(res.headers), body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`public HTTP request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
});
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
/** Public-only GET with DNS pinning, bounded bodies, and per-hop redirect validation. */
export async function publicHttpGet(rawUrl, options = {}) {
    let current = rawUrl;
    let headers = { ...(options.headers ?? {}) };
    const maxRedirects = options.maxRedirects ?? 5;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        const url = await assertPublicUrl(current, options.lookup);
        const addresses = url.__publicAddresses;
        const result = await (options.requestHop ?? requestHop)(url, addresses, headers, options.timeoutMs ?? 15_000, options.maxBytes ?? DEFAULT_PUBLIC_HTTP_MAX_BYTES);
        const location = result.headers.get("location");
        if (result.status >= 300 && result.status < 400 && location) {
            const next = new URL(location, url);
            if (next.origin !== url.origin) {
                headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !SENSITIVE_HEADERS.has(key.toLowerCase())));
            }
            current = next.toString();
            continue;
        }
        return { ...result, finalUrl: current };
    }
    throw new Error(`public HTTP: too many redirects (>${maxRedirects}) for ${rawUrl}`);
}
