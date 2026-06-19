import assert from "node:assert/strict";
import test from "node:test";
import {
  categoryKeywords,
  detectDrift,
  extractLogoUrl,
  fetchLogoDataUri,
  findCategoryPage,
  findCategoryPageInSitemap,
  pickCategoryPage,
  registrableDomain,
  type FetchBytes,
  type FetchText,
  type ResolveUrl,
} from "../src/marketSourcing.ts";

test("registrableDomain: eTLD+1, handling multi-label suffixes", () => {
  assert.equal(registrableDomain("www.spiff.com"), "spiff.com");
  assert.equal(registrableDomain("salesforce.com"), "salesforce.com");
  assert.equal(registrableDomain("sub.bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("WWW.SAP.COM"), "sap.com");
});

test("categoryKeywords: significant words only, filler dropped", () => {
  assert.deepEqual(categoryKeywords("incentive compensation software"), ["incentive", "compensation"]);
  assert.deepEqual(categoryKeywords("CRM software"), ["crm"]);
  assert.deepEqual(categoryKeywords("the for and of"), []);
});

test("pickCategoryPage: follows nav to the category page; internal-only; needs a real match", () => {
  const kws = categoryKeywords("incentive compensation software");
  const html = `<nav>
    <a href="/products/erp">ERP</a>
    <a href="https://www.sap.com/products/hcm/incentive-compensation-management.html">Incentive Compensation Management</a>
    <a href="https://twitter.com/sap">Follow</a>
    <a href="/about">About</a>
  </nav>`;
  const pick = pickCategoryPage(html, "https://www.sap.com/", kws);
  assert.ok(pick && pick.includes("incentive-compensation-management"), `got ${pick}`);
  // no matching link → null (no over-targeting of generic homepages)
  assert.equal(pickCategoryPage(`<a href="/products">Products</a><a href="/x">About</a>`, "https://x.com/", kws), null);
  // a cross-domain link never wins (internal links only)
  assert.equal(pickCategoryPage(`<a href="https://o.com/incentive-compensation">Incentive Compensation</a>`, "https://x.com/", kws), null);
});

test("extractLogoUrl: apple-touch-icon → og:image → icon, resolved absolute", () => {
  assert.equal(
    extractLogoUrl(`<link rel="apple-touch-icon" sizes="180x180" href="/icons/touch.png">`, "https://acme.com/"),
    "https://acme.com/icons/touch.png",
  );
  assert.equal(
    extractLogoUrl(`<meta property="og:image" content="https://cdn.acme.com/og.png">`, "https://acme.com/"),
    "https://cdn.acme.com/og.png",
  );
  assert.equal(extractLogoUrl(`<p>no logo here</p>`, "https://acme.com/"), null);
});

test("detectDrift: cross-domain redirect flags drift; same-domain / blocked do not", async () => {
  const toSalesforce: ResolveUrl = async () => ({ finalUrl: "https://www.salesforce.com/products/spiff/", status: 200 });
  assert.equal(await detectDrift("https://spiff.com/", "spiff.com", toSalesforce), "salesforce.com");
  const toSelf: ResolveUrl = async () => ({ finalUrl: "https://www.acme.com/", status: 200 });
  assert.equal(await detectDrift("https://acme.com/", "acme.com", toSelf), null);
  const blocked: ResolveUrl = async () => ({ finalUrl: "https://www.salesforce.com/", status: 403 });
  assert.equal(await detectDrift("https://acme.com/", "acme.com", blocked), null);
});

test("findCategoryPageInSitemap: index → sub-sitemap, scores by path, rejects locale junk", async () => {
  const kws = categoryKeywords("incentive compensation software");
  const fetchText: FetchText = async (url) => {
    if (url.endsWith("/robots.txt")) return "Sitemap: https://www.sap.com/sitemap_index.xml";
    if (url.endsWith("/sitemap_index.xml"))
      return `<sitemapindex>
        <sitemap><loc>https://www.sap.com/sitemap_products.xml</loc></sitemap>
        <sitemap><loc>https://www.sap.com/sitemap_video.xml</loc></sitemap>
      </sitemapindex>`;
    if (url.endsWith("/sitemap_products.xml"))
      return `<urlset>
        <url><loc>https://www.sap.com/products/hcm/incentive-compensation-management.html</loc></url>
        <url><loc>https://www.sap.com/sk/products/incentive-compensation-fund.html</loc></url>
        <url><loc>https://www.sap.com/products/erp.html</loc></url>
      </urlset>`;
    return null;
  };
  const found = await findCategoryPageInSitemap("https://www.sap.com/", kws, fetchText);
  assert.ok(found && found.includes("/products/hcm/incentive-compensation-management"), `got ${found}`);
});

test("findCategoryPage: nav hit short-circuits the sitemap", async () => {
  let sitemapFetched = false;
  const fetchText: FetchText = async () => {
    sitemapFetched = true;
    return null;
  };
  const viaNav = await findCategoryPage(
    `<a href="/solutions/incentive-compensation">Incentive Compensation</a>`,
    "https://acme.com/",
    "incentive compensation software",
    fetchText,
  );
  assert.ok(viaNav && viaNav.includes("/solutions/incentive-compensation"), `got ${viaNav}`);
  assert.equal(sitemapFetched, false, "a nav match must not fetch the sitemap");
});

test("fetchLogoDataUri: page logo first, favicon fallback, images only, size-bounded", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const html = `<link rel="apple-touch-icon" href="/touch.png">`;

  const pageLogo: FetchBytes = async (url) =>
    url.includes("touch.png") ? { contentType: "image/png", bytes: png } : null;
  assert.equal(
    await fetchLogoDataUri("https://acme.com/", html, pageLogo),
    `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
  );

  const faviconOnly: FetchBytes = async (url) =>
    url.includes("s2/favicons") ? { contentType: "image/png", bytes: png } : null;
  assert.ok((await fetchLogoDataUri("https://acme.com/", undefined, faviconOnly))?.startsWith("data:image/png;base64,"));

  const notImage: FetchBytes = async () => ({ contentType: "text/html", bytes: png });
  assert.equal(await fetchLogoDataUri("https://acme.com/", html, notImage), null);

  const tooBig: FetchBytes = async () => ({ contentType: "image/png", bytes: new Uint8Array(60_000) });
  assert.equal(await fetchLogoDataUri("https://acme.com/", html, tooBig), null);
});
