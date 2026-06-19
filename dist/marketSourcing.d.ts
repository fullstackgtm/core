/** Fetch a text resource (sitemap, robots.txt); null on any failure. */
export type FetchText = (url: string) => Promise<string | null>;
/** Fetch raw bytes (a logo image); null on any failure. */
export type FetchBytes = (url: string) => Promise<{
    contentType: string;
    bytes: Uint8Array;
} | null>;
/** Resolve a URL's final destination after redirects. */
export type ResolveUrl = (url: string) => Promise<{
    finalUrl: string;
    status: number;
}>;
/**
 * Best-effort registrable domain (eTLD+1) for comparing vendor identity across a
 * redirect. Heuristic (no full public-suffix list): last two labels, or three for
 * a known multi-label suffix. Good enough to catch "spiff.com → salesforce.com".
 */
export declare function registrableDomain(host: string): string;
/** Significant category words for matching pages/links (drops generic filler). */
export declare function categoryKeywords(category: string): string[];
/**
 * Conglomerate page-selection: when a vendor's homepage isn't about the category,
 * follow its own nav to the category page. Scans same-registrable-domain internal
 * links and returns the one whose anchor text / path best matches the category
 * keywords (anchor text weighted 2×, path 1×; requires ≥2 to avoid false hits).
 * Returns null if no link is a clear match. Pure — operates on the given HTML.
 */
export declare function pickCategoryPage(html: string, baseUrl: string, keywords: string[]): string | null;
/**
 * Pull a canonical logo URL out of a homepage: apple-touch-icon → og:image →
 * rel=icon, resolved to an absolute URL. Pure — operates on the given HTML.
 */
export declare function extractLogoUrl(html: string, baseUrl: string): string | null;
/**
 * Follow redirects (SSRF-guarded, re-validated each hop) and return the final URL
 * + status WITHOUT downloading the body. Used to detect identity drift.
 */
export declare const resolveFinalUrl: ResolveUrl;
/**
 * Detect vendor identity drift: does this URL (or its www/apex sibling) redirect
 * to a DIFFERENT registrable domain? Returns the drifted-to host, else null.
 * Catches acquired/defunct products (e.g. www.spiff.com → salesforce.com) even
 * when the apex itself errors. Only a 2xx/3xx landing on another domain counts —
 * a status code or a throw is NOT drift (real sites block bare requests).
 */
export declare function detectDrift(url: string, srcHost: string, resolve?: ResolveUrl): Promise<string | null>;
/**
 * Fallback for JS-nav conglomerates whose product links aren't in the rendered
 * homepage: find the category page from the vendor's sitemap. Bounded (≤6 sitemap
 * fetches, ≤20k URLs), same-registrable-domain, plain XML only; media sitemaps
 * skipped, non-English locales de-prioritized, /products/ preferred; requires the
 * path to hit the keywords so locale/blog false-positives are rejected.
 */
export declare function findCategoryPageInSitemap(rootUrl: string, keywords: string[], fetchText?: FetchText): Promise<string | null>;
/**
 * Find a vendor's category-specific page: scan its (already-fetched) homepage nav,
 * then fall back to the sitemap. Returns the page URL, or null to keep the homepage.
 */
export declare function findCategoryPage(homepageHtml: string, homepageUrl: string, category: string, fetchText?: FetchText): Promise<string | null>;
/**
 * A vendor logo as a self-contained `data:` URI — the form `MarketVendor.logo`
 * renders and the report serves under a strict `img-src data:` CSP. Prefers the
 * page-declared logo (from the given homepage HTML), then a favicon service.
 * Bounded to small raster/SVG (≤50KB).
 */
export declare function fetchLogoDataUri(homepageUrl: string, html?: string, fetchBytes?: FetchBytes): Promise<string | null>;
