import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialsDir } from "./credentials.js";
const INTENSITY_RANK = {
    loud: 3,
    quiet: 2,
    absent: 1,
    unobservable: 0,
};
// Mirrors stableHash in rules.ts (FNV-1a); duplicated to keep market.ts
// importable without pulling the audit engine.
function fnv1a(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
export function observationId(category, runLabel, vendorId, claimId) {
    return `obs_${fnv1a(`${category}|${runLabel}|${vendorId}|${claimId}`)}`;
}
// ---------------------------------------------------------------------------
// Config
export function parseMarketConfig(raw) {
    const config = JSON.parse(raw);
    if (!config.category)
        throw new Error("market config: missing category");
    if (!Array.isArray(config.vendors) || config.vendors.length === 0) {
        throw new Error("market config: at least one vendor is required");
    }
    if (!Array.isArray(config.claims) || config.claims.length === 0) {
        throw new Error("market config: at least one claim is required");
    }
    for (const [label, items] of [
        ["vendor", config.vendors],
        ["claim", config.claims],
    ]) {
        const seen = new Set();
        for (const item of items) {
            if (!item.id)
                throw new Error(`market config: ${label} missing id`);
            if (seen.has(item.id))
                throw new Error(`market config: duplicate ${label} id "${item.id}"`);
            seen.add(item.id);
        }
    }
    if (config.anchorVendor && !config.vendors.some((v) => v.id === config.anchorVendor)) {
        throw new Error(`market config: anchorVendor "${config.anchorVendor}" is not in vendors`);
    }
    if (config.axes) {
        const claimIds = new Set(config.claims.map((claim) => claim.id));
        const axisIds = new Set();
        for (const axis of config.axes) {
            if (!axis.id)
                throw new Error("market config: axis missing id");
            if (axisIds.has(axis.id))
                throw new Error(`market config: duplicate axis id "${axis.id}"`);
            axisIds.add(axis.id);
            for (const claimId of Object.keys(axis.claimScores ?? {})) {
                if (!claimIds.has(claimId)) {
                    throw new Error(`market config: axis "${axis.id}" scores unknown claim "${claimId}"`);
                }
            }
        }
        if (config.primaryAxes) {
            if (config.primaryAxes.length !== 2 || config.primaryAxes.some((id) => !axisIds.has(id))) {
                throw new Error(`market config: primaryAxes must name two configured axes (got ${JSON.stringify(config.primaryAxes)})`);
            }
        }
    }
    else if (config.primaryAxes) {
        throw new Error("market config: primaryAxes set but no axes configured");
    }
    return config;
}
export function loadMarketConfig(path) {
    return parseMarketConfig(readFileSync(path, "utf8"));
}
export function starterMarketConfig(category) {
    return {
        category,
        anchorVendor: "your-company",
        vendors: [
            {
                id: "your-company",
                name: "Your Company",
                urls: { home: "https://example.com/", pricing: null, product: [] },
                notes: "Replace with the real vendor set (≤10 works well). pricing: null records 'no public pricing page'.",
            },
        ],
        claims: [
            {
                id: "example-claim",
                capability: "Example capability: what is being claimed, stated precisely",
                icp: "who-buys-it",
                pricingStructure: "how-it-is-priced",
                definition: "LOUD if the claim is hero copy or a top-nav named product with a dedicated page; QUIET if it appears only on pages below that; ABSENT if nowhere. Write the definition so a human could judge any vendor's page against it.",
            },
        ],
        surfaceRule: "LOUD = hero copy OR top-level-nav named product with dedicated page; QUIET = present on any indexed page below that; ABSENT = nowhere observed (explicit disavowals score ABSENT with the disavowal quoted in reason); UNOBSERVABLE = capture empty/failed — never score ABSENT from a failed capture.",
    };
}
// ---------------------------------------------------------------------------
// Profile-scoped market home: captures and observations live with credentials
// so --profile isolation covers category intel too.
export function marketHome(category, baseDir) {
    return join(baseDir ?? credentialsDir(), "market", category);
}
// ---------------------------------------------------------------------------
// Capture: fetch vendor pages, strip to readable text, store content-addressed.
// The hash cache is the change detector (unchanged page = same hash = no new
// classification needed), the replay buffer (re-judge a revised taxonomy
// without re-scraping), and the evidence chain (quoted spans stay resolvable).
const STRIP_BLOCKS = /<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1\s*>/gi;
const ENTITIES = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&mdash;": "—",
    "&ndash;": "–",
};
export function extractReadableText(html) {
    const withoutBlocks = html.replace(STRIP_BLOCKS, " ");
    const withBreaks = withoutBlocks.replace(/<(\/p|\/div|\/li|\/h[1-6]|br\s*\/?)>/gi, "\n");
    const withoutTags = withBreaks.replace(/<[^>]+>/g, " ");
    const decoded = withoutTags
        .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? " ")
        .replace(/[ \t]+/g, " ");
    return decoded
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
}
const defaultFetchPage = async (url) => {
    const response = await fetch(url, {
        headers: {
            "User-Agent": "fullstackgtm-market/0 (+https://github.com/fullstackgtm/core)",
            "Accept-Language": "en-US",
        },
        redirect: "follow",
    });
    return { status: response.status, body: await response.text() };
};
export async function captureMarket(config, options = {}) {
    const dir = options.dir ?? join(marketHome(config.category), "captures");
    const runLabel = options.runLabel ?? "run-1";
    const fetchPage = options.fetchPage ?? defaultFetchPage;
    const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
    mkdirSync(dir, { recursive: true });
    const manifestPath = join(dir, "manifest.json");
    const manifest = existsSync(manifestPath)
        ? JSON.parse(readFileSync(manifestPath, "utf8"))
        : [];
    const entries = [];
    for (const vendor of config.vendors) {
        const targets = [
            { kind: "home", url: vendor.urls.home },
        ];
        if (vendor.urls.pricing)
            targets.push({ kind: "pricing", url: vendor.urls.pricing });
        for (const url of vendor.urls.product)
            targets.push({ kind: "product", url });
        for (const target of targets) {
            let status = null;
            let text = "";
            try {
                const page = await fetchPage(target.url);
                status = page.status;
                if (page.status === 200)
                    text = extractReadableText(page.body);
            }
            catch {
                status = null;
            }
            let captureHash = null;
            if (text) {
                captureHash = createHash("sha256").update(text).digest("hex");
                // Content-addressed: an unchanged page dedupes to the same file.
                writeFileSync(join(dir, `${captureHash}.txt`), text);
            }
            const entry = {
                runLabel,
                vendorId: vendor.id,
                kind: target.kind,
                url: target.url,
                fetchedAt,
                httpStatus: status,
                captureHash,
                textChars: text.length,
            };
            manifest.push(entry);
            entries.push(entry);
        }
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { entries, manifestPath };
}
export function createFileObservationStore(category, directory) {
    const dir = directory ?? join(marketHome(category), "observations");
    function fileFor(runLabel) {
        if (!/^[\w.-]+$/.test(runLabel))
            throw new Error(`Invalid run label: ${runLabel}`);
        return join(dir, `${runLabel}.json`);
    }
    function read(runLabel) {
        try {
            return JSON.parse(readFileSync(fileFor(runLabel), "utf8"));
        }
        catch {
            return null;
        }
    }
    function listSets() {
        let names = [];
        try {
            names = readdirSync(dir).filter((name) => name.endsWith(".json"));
        }
        catch {
            return [];
        }
        return names
            .map((name) => read(name.replace(/\.json$/, "")))
            .filter((set) => set !== null)
            .sort((a, b) => a.runAt.localeCompare(b.runAt));
    }
    return {
        async append(set) {
            if (set.category !== category) {
                throw new Error(`Observation set category "${set.category}" does not match store "${category}"`);
            }
            if (read(set.runLabel)) {
                throw new Error(`Run "${set.runLabel}" already exists — observations are append-only; use a new run label`);
            }
            mkdirSync(dir, { recursive: true });
            writeFileSync(fileFor(set.runLabel), `${JSON.stringify(set, null, 2)}\n`);
            return set;
        },
        async get(runLabel) {
            return read(runLabel);
        },
        async list() {
            return listSets().map((set) => ({
                runLabel: set.runLabel,
                runAt: set.runAt,
                observations: set.observations.length,
            }));
        },
        async latest() {
            const sets = listSets();
            return sets.length ? sets[sets.length - 1] : null;
        },
    };
}
/**
 * Validate a proposed observation set against the config before it enters
 * the store: known vendors/claims, full coverage, legal readings, and the
 * verbatim-evidence rule (non-absent readings must quote something).
 * Returns problems; an empty array means accept.
 */
export function validateObservationSet(config, set) {
    const problems = [];
    const vendorIds = new Set(config.vendors.map((v) => v.id));
    const claimIds = new Set(config.claims.map((c) => c.id));
    const seen = new Set();
    for (const obs of set.observations) {
        const cell = `${obs.vendorId} × ${obs.claimId}`;
        if (!vendorIds.has(obs.vendorId))
            problems.push(`unknown vendor "${obs.vendorId}"`);
        if (!claimIds.has(obs.claimId))
            problems.push(`unknown claim "${obs.claimId}"`);
        if (seen.has(cell))
            problems.push(`duplicate observation for ${cell}`);
        seen.add(cell);
        if (!INTENSITY_RANK[obs.intensity] && obs.intensity !== "unobservable") {
            problems.push(`${cell}: invalid intensity "${obs.intensity}"`);
        }
        if ((obs.intensity === "loud" || obs.intensity === "quiet") && obs.evidence.length === 0) {
            problems.push(`${cell}: ${obs.intensity} reading with no quoted evidence`);
        }
    }
    for (const vendor of config.vendors) {
        for (const claim of config.claims) {
            if (!seen.has(`${vendor.id} × ${claim.id}`)) {
                problems.push(`missing observation for ${vendor.id} × ${claim.id}`);
            }
        }
    }
    return problems;
}
// ---------------------------------------------------------------------------
// Evidence span verification — the deterministic gate that makes the
// verbatim-quote rule mechanical instead of a prompt instruction. Because the
// source documents are *stored* (unlike call transcripts, which pass through),
// every quoted span can be checked against the capture it cites before the
// observation is accepted. Comparison is whitespace-normalized only: case and
// wording must match the page exactly.
export function loadCaptureTexts(category, directory) {
    const dir = directory ?? join(marketHome(category), "captures");
    const manifestPath = join(dir, "manifest.json");
    const entries = existsSync(manifestPath)
        ? JSON.parse(readFileSync(manifestPath, "utf8"))
        : [];
    const textByHash = new Map();
    for (const entry of entries) {
        if (entry.captureHash && !textByHash.has(entry.captureHash)) {
            try {
                textByHash.set(entry.captureHash, readFileSync(join(dir, `${entry.captureHash}.txt`), "utf8"));
            }
            catch {
                // Missing capture file: verification of anything citing it will fail loudly.
            }
        }
    }
    return { entries, textByHash };
}
/**
 * Whitespace-only normalization for span matching, plus one extraction
 * artifact: the HTML-to-text step can emit a line break before punctuation
 * that follows an inline tag ("placements\n. Districts"), which no honest
 * quoter would reproduce — so whitespace *before* punctuation is dropped
 * too. Words, casing, and characters must still match the page exactly.
 */
export function normalizeForMatch(value) {
    return value
        .replace(/\s+([.,;:!?])/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
}
export function verifyEvidenceSpans(observations, textByHash) {
    const failures = [];
    for (const obs of observations) {
        for (const evidence of obs.evidence) {
            const quote = evidence.text ?? "";
            const hash = String(evidence.metadata?.captureHash ?? "");
            if (!hash) {
                failures.push({
                    vendorId: obs.vendorId,
                    claimId: obs.claimId,
                    quote,
                    problem: "evidence has no captureHash — spans must cite a stored capture",
                });
                continue;
            }
            const captureText = textByHash.get(hash);
            if (captureText === undefined) {
                failures.push({
                    vendorId: obs.vendorId,
                    claimId: obs.claimId,
                    quote,
                    problem: `capture ${hash.slice(0, 12)} not found — evidence must stay resolvable`,
                });
                continue;
            }
            if (!normalizeForMatch(captureText).includes(normalizeForMatch(quote))) {
                failures.push({
                    vendorId: obs.vendorId,
                    claimId: obs.claimId,
                    quote,
                    problem: `quote not found verbatim in capture ${hash.slice(0, 12)}`,
                });
            }
        }
    }
    return failures;
}
/**
 * Front rule v1: 0 loud → open (if anyone is quiet) or vacant; 1 loud →
 * owned; 2–3 loud → contested; ≥4 loud → saturated. Unobservable cells are
 * excluded — a failed capture never reads as absence.
 */
export function computeFrontStates(config, set) {
    const byCell = new Map();
    for (const obs of set.observations) {
        const key = `${obs.vendorId}|${obs.claimId}`;
        const existing = byCell.get(key);
        if (!existing || INTENSITY_RANK[obs.intensity] > INTENSITY_RANK[existing.intensity]) {
            byCell.set(key, obs);
        }
    }
    return config.claims.map((claim) => {
        const loud = [];
        const quiet = [];
        for (const vendor of config.vendors) {
            const obs = byCell.get(`${vendor.id}|${claim.id}`);
            if (obs?.intensity === "loud")
                loud.push(vendor.id);
            if (obs?.intensity === "quiet")
                quiet.push(vendor.id);
        }
        let state;
        if (loud.length === 0)
            state = quiet.length >= 1 ? "open" : "vacant";
        else if (loud.length === 1)
            state = "owned";
        else if (loud.length <= 3)
            state = "contested";
        else
            state = "saturated";
        return { claimId: claim.id, state, loudVendorIds: loud, quietVendorIds: quiet };
    });
}
/** What changed in the category between two runs — the refresh's whole point. */
export function diffFrontStates(before, after) {
    const prior = new Map(before.map((front) => [front.claimId, front.state]));
    const drift = [];
    for (const front of after) {
        const was = prior.get(front.claimId);
        if (was && was !== front.state)
            drift.push({ claimId: front.claimId, before: was, after: front.state });
    }
    return drift;
}
