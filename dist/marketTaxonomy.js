import { DEFAULT_MODELS, forcedToolCall, } from "./llm.js";
import { captureMarket, loadCaptureTexts, } from "./market.js";
const DEFAULT_MAX_CLAIMS = 16;
const DEFAULT_PER_VENDOR_CHARS = 6_000;
/** Stable, human-readable id from a string (claim capability or host). */
function slugify(value, maxWords = 6) {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .split("-")
        .filter(Boolean)
        .slice(0, maxWords)
        .join("-");
    return slug || "item";
}
/** Second-level domain as a vendor id seed: https://www.stripe.com/ -> stripe. */
function vendorIdFromUrl(url) {
    let host;
    try {
        host = new URL(url).hostname;
    }
    catch {
        return slugify(url);
    }
    const labels = host.replace(/^www\./, "").split(".");
    const sld = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    return slugify(sld || host);
}
/** Disambiguate repeated ids by suffixing -2, -3, … */
function uniqueId(base, taken) {
    if (!taken.has(base)) {
        taken.add(base);
        return base;
    }
    for (let n = 2;; n += 1) {
        const candidate = `${base}-${n}`;
        if (!taken.has(candidate)) {
            taken.add(candidate);
            return candidate;
        }
    }
}
function provisionalVendors(seeds) {
    const taken = new Set();
    return seeds.map((seed) => {
        const id = uniqueId(vendorIdFromUrl(seed.url), taken);
        const host = (() => {
            try {
                return new URL(seed.url).hostname.replace(/^www\./, "");
            }
            catch {
                return seed.url;
            }
        })();
        return {
            id,
            name: seed.name?.trim() || host,
            urls: { home: seed.url, pricing: null, product: [] },
        };
    });
}
const TAXONOMY_SCHEMA = {
    type: "object",
    required: ["claims"],
    properties: {
        surfaceRule: {
            type: "string",
            description: "One sentence stating how a reader judges LOUD vs QUIET vs ABSENT for this category (e.g. hero/top-nav = LOUD, deeper pages = QUIET, nowhere = ABSENT).",
        },
        claims: {
            type: "array",
            description: "The distinct capability positions vendors in this category compete on. 8-16 of them. Only include claims you can actually see evidence for on the supplied pages.",
            items: {
                type: "object",
                required: ["capability", "icp", "pricingStructure", "definition"],
                properties: {
                    capability: {
                        type: "string",
                        description: "What is being claimed, precise enough to judge loud/quiet/absent. Max ~10 words.",
                    },
                    icp: { type: "string", description: "Which buyer/ICP this claim cell addresses (category vocabulary)." },
                    pricingStructure: {
                        type: "string",
                        description: "Which pricing structure the claim implies (e.g. per-seat, usage-based, flat, free-tier).",
                    },
                    definition: {
                        type: "string",
                        description: "Operational definition a human (or classifier) uses to score any vendor's page LOUD/QUIET/ABSENT on this claim.",
                    },
                    terms: {
                        type: "array",
                        items: { type: "string" },
                        description: "Exact buyer phrasings for this claim, for deterministic mention matching. 2-5 terms.",
                    },
                },
            },
        },
        vendors: {
            type: "array",
            description: "Optional refinements: a clean display name per seed URL, and a pricing-page URL if one is clearly linked.",
            items: {
                type: "object",
                required: ["seedUrl"],
                properties: {
                    seedUrl: { type: "string" },
                    name: { type: "string" },
                    pricingUrl: { type: ["string", "null"] },
                },
            },
        },
    },
};
function buildDossier(vendors, capture, perVendorChars) {
    const { entries, textByHash } = capture;
    const unreadable = [];
    const blocks = [];
    for (const vendor of vendors) {
        const hash = entries.find((e) => e.vendorId === vendor.id && e.captureHash)?.captureHash ?? null;
        const text = hash ? textByHash.get(hash) ?? "" : "";
        if (!text.trim()) {
            unreadable.push(vendor.id);
            continue;
        }
        blocks.push(`### ${vendor.name} (${vendor.urls.home})\n${text.slice(0, perVendorChars)}`);
    }
    return { dossier: blocks.join("\n\n"), unreadable };
}
const INSTRUCTIONS = `You are seeding a competitive "market map" for a category. A market map breaks the category into CLAIMS — the distinct capability positions vendors compete on — so each (vendor x claim) cell can later be scored LOUD / QUIET / ABSENT from that vendor's pages.

Propose the claim taxonomy for this category from the competitor homepages below. Rules:
- Ground every claim in what is actually visible on the supplied pages. Do not invent positions no vendor mentions.
- Each claim is a cell: a precise capability, the ICP it targets, and the pricing structure it implies.
- Write each definition so a reader could judge ANY vendor's page LOUD/QUIET/ABSENT against it.
- Aim for the 8-16 claims that genuinely differentiate vendors. Prefer specific, contested positions over generic table stakes.
- Provide 2-5 verbatim buyer terms per claim for later mention matching.
- Optionally return a cleaned display name and a pricing-page URL per seed vendor when evident.`;
export async function suggestMarketConfig(options) {
    const { category } = options;
    if (options.vendors.length === 0)
        throw new Error("suggestMarketConfig requires at least one seed vendor");
    const maxClaims = options.maxClaims ?? DEFAULT_MAX_CLAIMS;
    const perVendorChars = options.perVendorChars ?? DEFAULT_PER_VENDOR_CHARS;
    const model = options.llm.model ?? DEFAULT_MODELS[options.llm.provider];
    const vendors = provisionalVendors(options.vendors);
    const anchorSeed = options.vendors.find((seed) => seed.anchor);
    const anchorId = anchorSeed ? vendors[options.vendors.indexOf(anchorSeed)]?.id : undefined;
    // Capture the seed homepages so the proposer only sees text we actually
    // fetched (the SSRF guard in captureMarket applies to these user-supplied URLs).
    await captureMarket({ category, vendors, claims: [] }, { dir: options.capturesDir, store: options.store, runLabel: "bootstrap", fetchPage: options.fetchPage, now: options.now });
    const capture = options.store
        ? await options.store.loadCaptureTexts()
        : loadCaptureTexts(category, options.capturesDir);
    const { dossier, unreadable } = buildDossier(vendors, capture, perVendorChars);
    if (!dossier.trim()) {
        throw new Error(`market init --auto: none of the ${vendors.length} seed pages returned readable text — check the URLs are public homepages.`);
    }
    const prompt = `${INSTRUCTIONS}\n\nCategory: ${category}\n\nCompetitor homepages:\n${dossier}`;
    const result = (await forcedToolCall(prompt, "propose_market_taxonomy", TAXONOMY_SCHEMA, model, options.llm));
    const takenClaimIds = new Set();
    const claims = (result.claims ?? [])
        .filter((claim) => claim?.capability && claim?.definition)
        .slice(0, maxClaims)
        .map((claim) => ({
        id: uniqueId(slugify(claim.capability), takenClaimIds),
        capability: claim.capability.trim(),
        icp: (claim.icp ?? "").trim() || "general",
        pricingStructure: (claim.pricingStructure ?? "").trim() || "unspecified",
        definition: claim.definition.trim(),
        ...(claim.terms?.length ? { terms: claim.terms.map((t) => t.trim()).filter(Boolean) } : {}),
    }));
    if (claims.length === 0) {
        throw new Error("market init --auto: the model proposed no usable claims — try again or seed the taxonomy by hand.");
    }
    // Apply optional vendor refinements (display name + pricing URL), matched by seed URL.
    const refinementByUrl = new Map((result.vendors ?? []).map((v) => [v.seedUrl, v]));
    const refinedVendors = vendors.map((vendor) => {
        const refinement = refinementByUrl.get(vendor.urls.home);
        const pricing = refinement?.pricingUrl && /^https?:\/\//i.test(refinement.pricingUrl) ? refinement.pricingUrl : vendor.urls.pricing;
        return {
            ...vendor,
            name: refinement?.name?.trim() || vendor.name,
            urls: { ...vendor.urls, pricing },
        };
    });
    const config = {
        category,
        ...(anchorId ? { anchorVendor: anchorId } : {}),
        vendors: refinedVendors,
        claims,
        surfaceRule: result.surfaceRule?.trim() ||
            "LOUD = hero copy OR top-level-nav named product with a dedicated page; QUIET = present on any indexed page below that; ABSENT = nowhere observed; UNOBSERVABLE = capture empty/failed — never score ABSENT from a failed capture.",
    };
    return { config, unreadableVendorIds: unreadable, model };
}
