import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialsDir } from "./credentials.ts";
import type { GtmEvidence } from "./types.ts";

/**
 * The Market Map: a live model of the competitive category a company sells
 * into. Vendors publish claims constantly (pricing pages, feature pages,
 * hero copy); each (vendor × claim) cell gets a messaging-intensity reading,
 * and each claim row gets a derived front state. Observations are
 * append-only — history is the product; "what changed since last run" is a
 * first-class question.
 *
 * Division of labor mirrors call intelligence: intensity readings are
 * *proposals* (LLM or human, always with verbatim quoted evidence), while
 * everything downstream — front states, drift, the report — is deterministic
 * over the stored observations. Same stored observations, same map.
 *
 * The claim taxonomy and vendor registry live in a reviewable config file
 * (git-friendly, analyst-edited); captures and observations live under the
 * profile home so one client's category intel never bleeds into another's.
 */

export type ClaimIntensity = "loud" | "quiet" | "absent" | "unobservable";

export type ObservationConfidence = "high" | "medium" | "low";

export type FrontState = "open" | "contested" | "owned" | "saturated" | "vacant";

export type MarketClaim = {
  id: string;
  /** The capability being claimed, precise enough to judge loud/quiet/absent. */
  capability: string;
  /** Which ICP the claim cell addresses (category-specific vocabulary). */
  icp: string;
  /** Which pricing structure the claim cell implies (category-specific). */
  pricingStructure: string;
  /** Operational definition: how a reader judges LOUD vs QUIET vs ABSENT. */
  definition: string;
};

export type MarketVendor = {
  id: string;
  name: string;
  urls: {
    home: string;
    /** null is itself an observation: no public pricing surface. */
    pricing: string | null;
    product: string[];
  };
  notes?: string;
};

export type MarketAxis = {
  id: string;
  label: string;
  negativePole: string;
  positivePole: string;
  /** How a human scores a claim on this axis — the axis IS this rubric. */
  rubric: string;
  /** e.g. "validated", "proposal", "proposal (PC2-validated)". Reviewer-facing. */
  status?: string;
  /** claimId → score in [-1, 1]; null = the axis does not apply to this claim. */
  claimScores: Record<string, number | null>;
};

export type MarketConfig = {
  category: string;
  anchorVendor?: string;
  vendors: MarketVendor[];
  claims: MarketClaim[];
  /** The LOUD/QUIET/ABSENT/UNOBSERVABLE judging rule, stated for reviewers. */
  surfaceRule?: string;
  /** Strategic axes as claim-scoring rubrics — config, not code. */
  axes?: MarketAxis[];
  /** [xAxisId, yAxisId] for the report's strategic map. */
  primaryAxes?: [string, string];
};

export type MarketObservation = {
  /** stableHash(category, runLabel, vendorId, claimId) — deterministic. */
  id: string;
  vendorId: string;
  claimId: string;
  observedAt: string;
  intensity: ClaimIntensity;
  confidence: ObservationConfidence;
  /** Reviewer-facing: why the reading is what it is. */
  reason: string;
  /**
   * Verbatim quoted spans grounding any non-absent reading
   * (sourceSystem "web", metadata.url + metadata.captureHash).
   */
  evidence: GtmEvidence[];
};

export type ObservationSet = {
  id: string;
  category: string;
  runLabel: string;
  runAt: string;
  /** What produced the readings: "manual" or "llm:<provider>:<model>". */
  extractor: string;
  observations: MarketObservation[];
};

export type CaptureEntry = {
  runLabel: string;
  vendorId: string;
  kind: "home" | "pricing" | "product";
  url: string;
  fetchedAt: string;
  httpStatus: number | null;
  /** sha256 of the extracted text; null when the fetch failed or was empty. */
  captureHash: string | null;
  textChars: number;
};

const INTENSITY_RANK: Record<ClaimIntensity, number> = {
  loud: 3,
  quiet: 2,
  absent: 1,
  unobservable: 0,
};

// Mirrors stableHash in rules.ts (FNV-1a); duplicated to keep market.ts
// importable without pulling the audit engine.
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function observationId(category: string, runLabel: string, vendorId: string, claimId: string): string {
  return `obs_${fnv1a(`${category}|${runLabel}|${vendorId}|${claimId}`)}`;
}

// ---------------------------------------------------------------------------
// Config

export function parseMarketConfig(raw: string): MarketConfig {
  const config = JSON.parse(raw) as MarketConfig;
  if (!config.category) throw new Error("market config: missing category");
  if (!Array.isArray(config.vendors) || config.vendors.length === 0) {
    throw new Error("market config: at least one vendor is required");
  }
  if (!Array.isArray(config.claims) || config.claims.length === 0) {
    throw new Error("market config: at least one claim is required");
  }
  for (const [label, items] of [
    ["vendor", config.vendors],
    ["claim", config.claims],
  ] as const) {
    const seen = new Set<string>();
    for (const item of items) {
      if (!item.id) throw new Error(`market config: ${label} missing id`);
      if (seen.has(item.id)) throw new Error(`market config: duplicate ${label} id "${item.id}"`);
      seen.add(item.id);
    }
  }
  if (config.anchorVendor && !config.vendors.some((v) => v.id === config.anchorVendor)) {
    throw new Error(`market config: anchorVendor "${config.anchorVendor}" is not in vendors`);
  }
  if (config.axes) {
    const claimIds = new Set(config.claims.map((claim) => claim.id));
    const axisIds = new Set<string>();
    for (const axis of config.axes) {
      if (!axis.id) throw new Error("market config: axis missing id");
      if (axisIds.has(axis.id)) throw new Error(`market config: duplicate axis id "${axis.id}"`);
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
  } else if (config.primaryAxes) {
    throw new Error("market config: primaryAxes set but no axes configured");
  }
  return config;
}

export function loadMarketConfig(path: string): MarketConfig {
  return parseMarketConfig(readFileSync(path, "utf8"));
}

export function starterMarketConfig(category: string): MarketConfig {
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
        definition:
          "LOUD if the claim is hero copy or a top-nav named product with a dedicated page; QUIET if it appears only on pages below that; ABSENT if nowhere. Write the definition so a human could judge any vendor's page against it.",
      },
    ],
    surfaceRule:
      "LOUD = hero copy OR top-level-nav named product with dedicated page; QUIET = present on any indexed page below that; ABSENT = nowhere observed (explicit disavowals score ABSENT with the disavowal quoted in reason); UNOBSERVABLE = capture empty/failed — never score ABSENT from a failed capture.",
  };
}

// ---------------------------------------------------------------------------
// Profile-scoped market home: captures and observations live with credentials
// so --profile isolation covers category intel too.

export function marketHome(category: string, baseDir?: string): string {
  return join(baseDir ?? credentialsDir(), "market", category);
}

// ---------------------------------------------------------------------------
// Capture: fetch vendor pages, strip to readable text, store content-addressed.
// The hash cache is the change detector (unchanged page = same hash = no new
// classification needed), the replay buffer (re-judge a revised taxonomy
// without re-scraping), and the evidence chain (quoted spans stay resolvable).

const STRIP_BLOCKS = /<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1\s*>/gi;
const ENTITIES: Record<string, string> = {
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

export function extractReadableText(html: string): string {
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

export type FetchPage = (url: string) => Promise<{ status: number; body: string }>;

const defaultFetchPage: FetchPage = async (url) => {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "fullstackgtm-market/0 (+https://github.com/fullstackgtm/core)",
      "Accept-Language": "en-US",
    },
    redirect: "follow",
  });
  return { status: response.status, body: await response.text() };
};

export type CaptureOptions = {
  /** Directory for captures; defaults to <marketHome>/captures. */
  dir?: string;
  runLabel?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchPage?: FetchPage;
  now?: () => Date;
};

export type CaptureResult = {
  entries: CaptureEntry[];
  manifestPath: string;
};

export async function captureMarket(config: MarketConfig, options: CaptureOptions = {}): Promise<CaptureResult> {
  const dir = options.dir ?? join(marketHome(config.category), "captures");
  const runLabel = options.runLabel ?? "run-1";
  const fetchPage = options.fetchPage ?? defaultFetchPage;
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  mkdirSync(dir, { recursive: true });

  const manifestPath = join(dir, "manifest.json");
  const manifest: CaptureEntry[] = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as CaptureEntry[])
    : [];

  const entries: CaptureEntry[] = [];
  for (const vendor of config.vendors) {
    const targets: Array<{ kind: CaptureEntry["kind"]; url: string }> = [
      { kind: "home", url: vendor.urls.home },
    ];
    if (vendor.urls.pricing) targets.push({ kind: "pricing", url: vendor.urls.pricing });
    for (const url of vendor.urls.product) targets.push({ kind: "product", url });

    for (const target of targets) {
      let status: number | null = null;
      let text = "";
      try {
        const page = await fetchPage(target.url);
        status = page.status;
        if (page.status === 200) text = extractReadableText(page.body);
      } catch {
        status = null;
      }
      let captureHash: string | null = null;
      if (text) {
        captureHash = createHash("sha256").update(text).digest("hex");
        // Content-addressed: an unchanged page dedupes to the same file.
        writeFileSync(join(dir, `${captureHash}.txt`), text);
      }
      const entry: CaptureEntry = {
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

// ---------------------------------------------------------------------------
// Observation store: append-only sets, one JSON file per run. Like the plan
// store, this file layout and the hosted backend are two implementations of
// the same contract.

export interface ObservationStore {
  append(set: ObservationSet): Promise<ObservationSet>;
  get(runLabel: string): Promise<ObservationSet | null>;
  list(): Promise<Array<{ runLabel: string; runAt: string; observations: number }>>;
  latest(): Promise<ObservationSet | null>;
}

export function createFileObservationStore(category: string, directory?: string): ObservationStore {
  const dir = directory ?? join(marketHome(category), "observations");

  function fileFor(runLabel: string) {
    if (!/^[\w.-]+$/.test(runLabel)) throw new Error(`Invalid run label: ${runLabel}`);
    return join(dir, `${runLabel}.json`);
  }

  function read(runLabel: string): ObservationSet | null {
    try {
      return JSON.parse(readFileSync(fileFor(runLabel), "utf8")) as ObservationSet;
    } catch {
      return null;
    }
  }

  function listSets(): ObservationSet[] {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .map((name) => read(name.replace(/\.json$/, "")))
      .filter((set): set is ObservationSet => set !== null)
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
export function validateObservationSet(config: MarketConfig, set: ObservationSet): string[] {
  const problems: string[] = [];
  const vendorIds = new Set(config.vendors.map((v) => v.id));
  const claimIds = new Set(config.claims.map((c) => c.id));
  const seen = new Set<string>();
  for (const obs of set.observations) {
    const cell = `${obs.vendorId} × ${obs.claimId}`;
    if (!vendorIds.has(obs.vendorId)) problems.push(`unknown vendor "${obs.vendorId}"`);
    if (!claimIds.has(obs.claimId)) problems.push(`unknown claim "${obs.claimId}"`);
    if (seen.has(cell)) problems.push(`duplicate observation for ${cell}`);
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

export function loadCaptureTexts(
  category: string,
  directory?: string,
): { entries: CaptureEntry[]; textByHash: Map<string, string> } {
  const dir = directory ?? join(marketHome(category), "captures");
  const manifestPath = join(dir, "manifest.json");
  const entries: CaptureEntry[] = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as CaptureEntry[])
    : [];
  const textByHash = new Map<string, string>();
  for (const entry of entries) {
    if (entry.captureHash && !textByHash.has(entry.captureHash)) {
      try {
        textByHash.set(entry.captureHash, readFileSync(join(dir, `${entry.captureHash}.txt`), "utf8"));
      } catch {
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
export function normalizeForMatch(value: string): string {
  return value
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export type SpanVerificationFailure = {
  vendorId: string;
  claimId: string;
  quote: string;
  problem: string;
};

export function verifyEvidenceSpans(
  observations: MarketObservation[],
  textByHash: Map<string, string>,
): SpanVerificationFailure[] {
  const failures: SpanVerificationFailure[] = [];
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

// ---------------------------------------------------------------------------
// Front states — deterministic, recomputed every time, never stored.

export type ClaimFront = {
  claimId: string;
  state: FrontState;
  loudVendorIds: string[];
  quietVendorIds: string[];
};

/**
 * Front rule v1: 0 loud → open (if anyone is quiet) or vacant; 1 loud →
 * owned; 2–3 loud → contested; ≥4 loud → saturated. Unobservable cells are
 * excluded — a failed capture never reads as absence.
 */
export function computeFrontStates(config: MarketConfig, set: ObservationSet): ClaimFront[] {
  const byCell = new Map<string, MarketObservation>();
  for (const obs of set.observations) {
    const key = `${obs.vendorId}|${obs.claimId}`;
    const existing = byCell.get(key);
    if (!existing || INTENSITY_RANK[obs.intensity] > INTENSITY_RANK[existing.intensity]) {
      byCell.set(key, obs);
    }
  }
  return config.claims.map((claim) => {
    const loud: string[] = [];
    const quiet: string[] = [];
    for (const vendor of config.vendors) {
      const obs = byCell.get(`${vendor.id}|${claim.id}`);
      if (obs?.intensity === "loud") loud.push(vendor.id);
      if (obs?.intensity === "quiet") quiet.push(vendor.id);
    }
    let state: FrontState;
    if (loud.length === 0) state = quiet.length >= 1 ? "open" : "vacant";
    else if (loud.length === 1) state = "owned";
    else if (loud.length <= 3) state = "contested";
    else state = "saturated";
    return { claimId: claim.id, state, loudVendorIds: loud, quietVendorIds: quiet };
  });
}

export type FrontDrift = {
  claimId: string;
  before: FrontState;
  after: FrontState;
};

/** What changed in the category between two runs — the refresh's whole point. */
export function diffFrontStates(before: ClaimFront[], after: ClaimFront[]): FrontDrift[] {
  const prior = new Map(before.map((front) => [front.claimId, front.state]));
  const drift: FrontDrift[] = [];
  for (const front of after) {
    const was = prior.get(front.claimId);
    if (was && was !== front.state) drift.push({ claimId: front.claimId, before: was, after: front.state });
  }
  return drift;
}
