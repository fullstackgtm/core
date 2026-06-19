/**
 * Market sourcing — find the *right* page to capture for each vendor, detect
 * acquired/redirected vendors, and extract brand logos. These raise the quality
 * of a cold-start map and are useful to every consumer (CLI, MCP, or a hosted
 * service), with zero coupling to any transport.
 *
 * Design:
 *  - **Pure functions** (`pickCategoryPage`, `extractLogoUrl`, `categoryKeywords`,
 *    `registrableDomain`) operate on already-fetched HTML / strings. The caller
 *    fetches the page with whatever it likes — the hosted service injects a
 *    browser-rendering fetch for JS-walled homepages; the CLI uses the default.
 *  - **Fetching helpers** (`resolveFinalUrl`, `detectDrift`,
 *    `findCategoryPageInSitemap`, `fetchLogoDataUri`) default to the package's
 *    SSRF-guarded `assertPublicUrl` + global `fetch`, but each accepts an
 *    injectable fetcher so they stay testable offline and transport-agnostic.
 *    Sitemaps / redirects / logo bytes are plain resources — they never need a
 *    headless browser, so the default fetch is sufficient even in the hosted layer.
 */
import { assertPublicUrl } from "./market.js";
import { DEFAULT_MODELS, forcedToolCall } from "./llm.js";
const USER_AGENT = "fullstackgtm-market/0 (+https://github.com/fullstackgtm/core)";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    }
    catch {
        return null;
    }
}
// ── Pure helpers ────────────────────────────────────────────────────────────
// A few common multi-label public suffixes so "bbc.co.uk" → "bbc.co.uk", not "co.uk".
const MULTI_LABEL_TLDS = new Set([
    "co.uk", "com.au", "co.nz", "co.jp", "com.br", "co.in", "com.sg", "co.za", "com.mx", "com.cn",
]);
/**
 * Best-effort registrable domain (eTLD+1) for comparing vendor identity across a
 * redirect. Heuristic (no full public-suffix list): last two labels, or three for
 * a known multi-label suffix. Good enough to catch "spiff.com → salesforce.com".
 */
export function registrableDomain(host) {
    const h = String(host || "").toLowerCase().replace(/\.$/, "");
    const labels = h.split(".");
    if (labels.length <= 2)
        return h;
    const lastTwo = labels.slice(-2).join(".");
    return MULTI_LABEL_TLDS.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}
const CATEGORY_STOPWORDS = new Set([
    "software", "platform", "platforms", "tool", "tools", "system", "systems", "management",
    "solution", "solutions", "app", "apps", "service", "services", "suite", "the", "for", "and", "of",
]);
/** Significant category words for matching pages/links (drops generic filler). */
export function categoryKeywords(category) {
    return [
        ...new Set(String(category || "")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((w) => w.length >= 3 && !CATEGORY_STOPWORDS.has(w))),
    ];
}
/**
 * Conglomerate page-selection: when a vendor's homepage isn't about the category,
 * follow its own nav to the category page. Scans same-registrable-domain internal
 * links and returns the one whose anchor text / path best matches the category
 * keywords (anchor text weighted 2×, path 1×; requires ≥2 to avoid false hits).
 * Returns null if no link is a clear match. Pure — operates on the given HTML.
 */
export function pickCategoryPage(html, baseUrl, keywords) {
    if (!html || !keywords.length)
        return null;
    let baseHost;
    try {
        baseHost = registrableDomain(new URL(baseUrl).hostname);
    }
    catch {
        return null;
    }
    const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const seen = new Set();
    let best = null;
    let bestScore = 0;
    let m;
    while ((m = re.exec(html))) {
        let u;
        try {
            u = new URL(m[1], baseUrl);
        }
        catch {
            continue;
        }
        if (u.protocol !== "http:" && u.protocol !== "https:")
            continue;
        if (registrableDomain(u.hostname) !== baseHost)
            continue; // internal links only
        const key = u.origin + u.pathname;
        if (seen.has(key))
            continue;
        seen.add(key);
        const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
        const path = u.pathname.toLowerCase();
        let score = 0;
        for (const kw of keywords) {
            if (text.includes(kw))
                score += 2;
            if (path.includes(kw))
                score += 1;
        }
        if (score > bestScore) {
            bestScore = score;
            best = u.toString();
        }
    }
    return bestScore >= 2 ? best : null;
}
/**
 * Pull a canonical logo URL out of a homepage: apple-touch-icon → og:image →
 * rel=icon, resolved to an absolute URL. Pure — operates on the given HTML.
 */
export function extractLogoUrl(html, baseUrl) {
    if (!html)
        return null;
    const abs = (href) => {
        try {
            return new URL(href, baseUrl).toString();
        }
        catch {
            return null;
        }
    };
    const hrefOf = (tag) => {
        const mm = tag.match(/href=["']([^"']+)["']/i) || tag.match(/content=["']([^"']+)["']/i);
        return mm ? abs(mm[1]) : null;
    };
    let mm = html.match(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*>/i);
    if (mm) {
        const u = hrefOf(mm[0]);
        if (u)
            return u;
    }
    mm = html.match(/<meta[^>]+property=["']og:image["'][^>]*>/i);
    if (mm) {
        const u = hrefOf(mm[0]);
        if (u)
            return u;
    }
    mm = html.match(/<link[^>]+rel=["'](?:shortcut icon|icon)["'][^>]*>/i);
    if (mm) {
        const u = hrefOf(mm[0]);
        if (u)
            return u;
    }
    return null;
}
// ── Default SSRF-guarded fetchers ────────────────────────────────────────────
/** Manual-redirect fetch that re-validates every hop against the SSRF guard. */
async function guardedFetch(url) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        await assertPublicUrl(current);
        const res = await fetch(current, {
            redirect: "manual",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { "User-Agent": USER_AGENT },
        });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
            try {
                await res.body?.cancel();
            }
            catch {
                /* ignore */
            }
            current = new URL(location, current).toString();
            continue;
        }
        return res;
    }
    return null;
}
const defaultFetchText = async (url) => {
    try {
        const res = await guardedFetch(url);
        return res && res.ok ? await res.text() : null;
    }
    catch {
        return null;
    }
};
const defaultFetchBytes = async (url) => {
    try {
        const res = await guardedFetch(url);
        if (!res || !res.ok)
            return null;
        const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { contentType, bytes };
    }
    catch {
        return null;
    }
};
/**
 * Follow redirects (SSRF-guarded, re-validated each hop) and return the final URL
 * + status WITHOUT downloading the body. Used to detect identity drift.
 */
export const resolveFinalUrl = async (rawUrl) => {
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        await assertPublicUrl(current);
        const res = await fetch(current, {
            redirect: "manual",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { "User-Agent": USER_AGENT },
        });
        try {
            await res.body?.cancel();
        }
        catch {
            /* ignore */
        }
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
            current = new URL(location, current).toString();
            continue;
        }
        return { finalUrl: current, status: res.status };
    }
    return { finalUrl: current, status: 0 };
};
// ── Fetching helpers ─────────────────────────────────────────────────────────
/**
 * Detect vendor identity drift: does this URL (or its www/apex sibling) redirect
 * to a DIFFERENT registrable domain? Returns the drifted-to host, else null.
 * Catches acquired/defunct products (e.g. www.spiff.com → salesforce.com) even
 * when the apex itself errors. Only a 2xx/3xx landing on another domain counts —
 * a status code or a throw is NOT drift (real sites block bare requests).
 */
export async function detectDrift(url, srcHost, resolve = resolveFinalUrl) {
    if (!srcHost)
        return null;
    const tries = [url];
    try {
        const u = new URL(url);
        const sibling = u.hostname.startsWith("www.")
            ? url.replace("://www.", "://")
            : url.replace(`://${u.hostname}`, `://www.${u.hostname}`);
        if (sibling !== url)
            tries.push(sibling);
    }
    catch {
        /* ignore */
    }
    for (const t of tries) {
        try {
            const { finalUrl, status } = await resolve(t);
            if (status < 200 || status >= 400)
                continue;
            const finalHost = hostOf(finalUrl);
            if (finalHost && registrableDomain(finalHost) !== registrableDomain(srcHost))
                return finalHost;
        }
        catch {
            /* a throw isn't a drift signal */
        }
    }
    return null;
}
/**
 * Fallback for JS-nav conglomerates whose product links aren't in the rendered
 * homepage: find the category page from the vendor's sitemap. Bounded (≤6 sitemap
 * fetches, ≤20k URLs), same-registrable-domain, plain XML only; media sitemaps
 * skipped, non-English locales de-prioritized, /products/ preferred; requires the
 * path to hit the keywords so locale/blog false-positives are rejected.
 */
export async function findCategoryPageInSitemap(rootUrl, keywords, fetchText = defaultFetchText) {
    let root;
    try {
        root = new URL(rootUrl);
    }
    catch {
        return null;
    }
    if (!keywords.length)
        return null;
    const rootDom = registrableDomain(root.hostname);
    const sameDomain = (u) => registrableDomain(hostOf(u) || "") === rootDom;
    const pathScore = (u) => {
        let path;
        try {
            path = new URL(u).pathname.toLowerCase();
        }
        catch {
            return 0;
        }
        let s = 0;
        for (const kw of keywords)
            if (path.includes(kw))
                s += 1;
        if (s > 0) {
            if (/\/(product|solution)s?\//.test(path))
                s += 0.5; // prefer product pages
            const loc = path.match(/^\/([a-z]{2})(?:-[a-z]{2})?\//); // de-prioritize non-English locales
            if (loc && !["en", "us"].includes(loc[1]))
                s -= 0.6;
        }
        return s;
    };
    const candidates = new Set([`${root.origin}/sitemap.xml`, `${root.origin}/sitemap_index.xml`]);
    const robots = await fetchText(`${root.origin}/robots.txt`);
    if (robots) {
        for (const mm of robots.slice(0, 100_000).matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
            try {
                candidates.add(new URL(mm[1].trim(), root.origin).toString());
            }
            catch {
                /* skip */
            }
        }
    }
    const queue = [...candidates];
    const seen = new Set();
    let best = null;
    let bestScore = 0;
    let fetched = 0;
    let scanned = 0;
    while (queue.length && fetched < 6 && scanned < 20_000) {
        const sm = queue.shift();
        if (seen.has(sm) || !sameDomain(sm))
            continue;
        seen.add(sm);
        if (sm.endsWith(".gz"))
            continue; // skip compressed sitemaps
        const xml = await fetchText(sm);
        if (!xml)
            continue;
        fetched++;
        const body = xml.slice(0, 5_000_000);
        const locs = [...body.matchAll(/<loc>\s*([^<\s]+?)\s*<\/loc>/gi)].map((mm) => mm[1].replace(/&amp;/g, "&"));
        if (/<sitemapindex/i.test(body)) {
            const ranked = locs
                .filter(sameDomain)
                .filter((l) => !/(pdf|video|image|img|news|siteimprove)/i.test(l))
                .map((l) => [pathScore(l) + (/product|solution/i.test(l) ? 1 : 0), l])
                .sort((a, b) => b[0] - a[0]);
            for (const [, l] of ranked.slice(0, 5))
                queue.push(l);
        }
        else {
            for (const l of locs) {
                scanned++;
                if (!sameDomain(l))
                    continue;
                const s = pathScore(l);
                if (s > bestScore) {
                    bestScore = s;
                    best = l;
                }
            }
        }
    }
    return bestScore >= Math.min(2, keywords.length) ? best : null;
}
/**
 * Find a vendor's category-specific page: scan its (already-fetched) homepage nav,
 * then fall back to the sitemap. Returns the page URL, or null to keep the homepage.
 */
export async function findCategoryPage(homepageHtml, homepageUrl, category, fetchText = defaultFetchText) {
    const keywords = categoryKeywords(category);
    if (!keywords.length)
        return null;
    const nav = pickCategoryPage(homepageHtml, homepageUrl, keywords);
    if (nav)
        return nav;
    return findCategoryPageInSitemap(homepageUrl, keywords, fetchText);
}
/**
 * A vendor logo as a self-contained `data:` URI — the form `MarketVendor.logo`
 * renders and the report serves under a strict `img-src data:` CSP. Prefers the
 * page-declared logo (from the given homepage HTML), then a favicon service.
 * Bounded to small raster/SVG (≤50KB).
 */
export async function fetchLogoDataUri(homepageUrl, html, fetchBytes = defaultFetchBytes) {
    const host = hostOf(homepageUrl);
    if (!host)
        return null;
    const candidates = [];
    if (html) {
        const fromPage = extractLogoUrl(html, homepageUrl);
        if (fromPage)
            candidates.push(fromPage);
    }
    candidates.push(`https://www.google.com/s2/favicons?domain=${host}&sz=64`);
    for (const url of candidates) {
        const got = await fetchBytes(url);
        if (!got)
            continue;
        if (!got.contentType.startsWith("image/"))
            continue;
        if (got.bytes.length === 0 || got.bytes.length > 50_000)
            continue;
        return `data:${got.contentType};base64,${Buffer.from(got.bytes).toString("base64")}`;
    }
    return null;
}
const DISCOVERY_SCHEMA = {
    type: "object",
    required: ["competitors"],
    properties: {
        competitors: {
            type: "array",
            description: "Real vendors competing in this category today, each with its canonical https homepage URL.",
            items: {
                type: "object",
                required: ["name", "url"],
                properties: {
                    name: { type: "string" },
                    url: { type: "string", description: "Canonical homepage, https://domain, no tracking path." },
                    productUrl: {
                        type: "string",
                        description: "URL of the page on THIS vendor's site most specific to the category. For a multi-product company (e.g. SAP, Oracle) this is the product/solution page for this category, NOT the corporate homepage. For a focused single-product vendor, repeat the homepage.",
                    },
                },
            },
        },
    },
};
/**
 * Propose the real vendor set for a category via the LLM — so a cold-start map
 * needs only a category, not a hand-built vendor list. Returns canonical homepages
 * plus a category-specific `productUrl` per vendor; excludes the anchor + any
 * supplied hosts, de-dupes by registrable domain, and instructs the model to skip
 * acquired/defunct brands. BYOK via the package's `forcedToolCall`.
 */
export async function discoverCompetitors(category, options) {
    const model = options.llm.model ?? DEFAULT_MODELS[options.llm.provider];
    const anchorHost = options.anchorUrl ? hostOf(options.anchorUrl) : null;
    const anchorNote = anchorHost
        ? `The user's own company is ${anchorHost} — list its direct competitors and do NOT include ${anchorHost} itself.`
        : "";
    const prompt = `List the most significant vendors competing in the category "${category}" today.
${anchorNote}
Rules:
- Real companies only, each with its canonical https homepage URL (domain root, no tracking path).
- 7-9 vendors: a mix of established leaders and notable challengers.
- EXCLUDE vendors that have been acquired and folded into another brand, or are defunct — i.e. anything whose own site now redirects to a different company. (Name the current independent players instead.)
- For each, also give productUrl: the page most specific to "${category}". For a big multi-product company, that's its product/solution page for THIS category, not the corporate homepage.
- No duplicates.`;
    const result = (await forcedToolCall(prompt, "discover_competitors", DISCOVERY_SCHEMA, model, options.llm));
    const excluded = new Set((options.exclude ?? []).map(hostOf).filter((h) => Boolean(h)));
    if (anchorHost)
        excluded.add(anchorHost);
    const seenDomain = new Set();
    const out = [];
    for (const c of result?.competitors ?? []) {
        let u;
        try {
            u = new URL(String(c.url));
        }
        catch {
            continue;
        }
        if (u.protocol !== "http:" && u.protocol !== "https:")
            continue;
        const host = u.hostname.replace(/^www\./, "");
        if (excluded.has(host))
            continue;
        const dom = registrableDomain(host);
        if (seenDomain.has(dom))
            continue;
        seenDomain.add(dom);
        let productUrl = u.toString();
        if (c.productUrl) {
            try {
                const p = new URL(String(c.productUrl));
                if (p.protocol === "http:" || p.protocol === "https:")
                    productUrl = p.toString();
            }
            catch {
                /* keep homepage */
            }
        }
        out.push({ name: c.name || host, url: u.toString(), productUrl });
    }
    return out;
}
