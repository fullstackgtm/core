import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { credentialsDir, ensureSecureHomeDir, writeSecureFile } from "./credentials.ts";
import { HUBSPOT_DEFAULT_FIELD_MAPPINGS } from "./mappings.ts";
import type { AcquireBudget } from "./acquireMeter.ts";
import type {
  CanonicalGtmSnapshot,
  CreateRecordPayload,
  GtmEvidence,
  PatchOperation,
  PatchPlan,
} from "./types.ts";

/**
 * The enrich layer: governed append/refresh of third-party data into the CRM.
 *
 * Every enrichment vendor ships fire-and-forget writeback — data lands without
 * a diff, without approval, over whatever a human typed. This layer inverts
 * that: a source (Apollo pull, Clay ingest) feeds a deterministic matcher,
 * the matcher feeds a fill-blanks-only patch plan, and the plan goes through
 * the existing dry-run → approval → apply contract. Every proposed value is
 * traceable to the source payload that produced it (`GtmEvidence` on the
 * plan), and every write carries a `beforeValue` for apply-time
 * compare-and-set.
 *
 * State lives in a profile-scoped, append-only run store
 * (`~/.fullstackgtm/profiles/<profile>/enrich/runs/`) that is checkpoint,
 * staleness ledger, and observability surface in one. The CLI never writes
 * `fsgtm_enriched_at`-style custom properties into the customer's portal.
 *
 * Recurring execution belongs to the horizontal scheduler (docs/schedule.md);
 * enrich owns no cron logic.
 */

// ---------------------------------------------------------------------------
// Config: enrich.config.json

export type EnrichObjectType = "company" | "contact";

export type EnrichSourceKind = "api" | "ingest";

export type EnrichSourceConfig = {
  kind: EnrichSourceKind;
  /** Ingest staging format; csv (column headers) or json (dotted paths). */
  format?: "csv" | "json";
};

export type EnrichAmbiguousPolicy = "skip" | "suggest";

export type EnrichMatchConfig = {
  /** Ordered match keys, evaluated against the snapshot. */
  keys: string[];
  /** Multi-hit behavior; default skip. */
  onAmbiguous?: EnrichAmbiguousPolicy;
};

export type EnrichFieldConfig = {
  /** CRM property: canonical field name, or a default HubSpot property name. */
  crm: string;
  /** sourceId → dotted JSON path (api/json) or column header (ingest csv). */
  from: Record<string, string>;
  /** Opt into `enrich refresh`; fields without it are set once, never revisited. */
  refresh?: boolean;
  /** Staleness window for refresh; falls back to policy.defaultStaleDays. */
  staleDays?: number;
  /** Per-field conflict policy override. MVP: only "never". */
  policy?: "never";
};

export type EnrichPolicyConfig = {
  /** Conflict policy ladder. MVP ships "never" (fill blanks only). */
  overwrite: "never";
  defaultStaleDays?: number;
};

export type EnrichConfig = {
  sources: Record<string, EnrichSourceConfig>;
  match: Partial<Record<EnrichObjectType, EnrichMatchConfig>>;
  fields: Partial<Record<EnrichObjectType, EnrichFieldConfig[]>>;
  policy: EnrichPolicyConfig;
  /** Net-new lead creation (`enrich acquire`). Optional; absent = acquire off. */
  acquire?: AcquireConfig;
};

/** Maps a sourced record to the CRM properties a net-new record is created with. */
export type AcquireCreateMap = {
  /** CRM property name → source payload path (read via sourceValueAt). */
  properties: Record<string, string>;
  /** Source path whose value becomes the dedupe key (e.g. "email"). */
  matchKey: string;
  /** Optional source path to a company name; the connector resolves-or-creates it. */
  associateCompanyFrom?: string;
};

/**
 * Net-new discovery for an API acquire source. `provider` selects the adapter
 * (explorium = prospect search; pipe0 = work-email waterfall). `filters` is the
 * provider-native query; `resolveEmailsWith` chains a second provider to fill
 * real emails (e.g. explorium discovers, pipe0 resolves the work email).
 */
export type AcquireDiscoveryConfig = {
  provider: "explorium" | "pipe0";
  filters?: Record<string, unknown>;
  size?: number;
  resolveEmailsWith?: "pipe0";
};

export type AcquireConfig = {
  /** Windowed budget enforced by the acquire meter; absent = unmetered. */
  budget?: AcquireBudget;
  /** Estimated provider cost (USD) per created record, by source id. */
  costPerRecord?: Record<string, number>;
  /** How to build a net-new record from a sourced row, per object type. */
  create: Partial<Record<EnrichObjectType, AcquireCreateMap>>;
  /** Net-new discovery params for API sources, by source id. */
  discovery?: Record<string, AcquireDiscoveryConfig>;
};

export const ENRICH_CONFIG_FILE_NAME = "enrich.config.json";

export const DEFAULT_STALE_DAYS = 90;

const OBJECT_TYPES: EnrichObjectType[] = ["company", "contact"];

/** Match keys the matcher knows how to read off canonical snapshot records. */
const MATCH_KEYS: Record<EnrichObjectType, string[]> = {
  company: ["domain", "name"],
  contact: ["email", "name"],
};

/** API source ids the MVP can pull from. */
export const SUPPORTED_API_SOURCES = ["apollo", "explorium", "pipe0"];

/**
 * Canonical fields enrich may target, plus the HubSpot property spellings the
 * config may use for them (so `"crm": "numberofemployees"` and
 * `"crm": "employeeCount"` both resolve). Reading the current value for the
 * fill-blanks check happens against the canonical snapshot, so only fields
 * with a canonical home are accepted — strict, with the accepted names in the
 * error.
 */
const CANONICAL_FIELDS: Record<EnrichObjectType, string[]> = {
  company: ["name", "domain", "industry", "employeeCount", "annualRevenue"],
  contact: ["firstName", "lastName", "email", "phone", "title"],
};

const PROVIDER_FIELD_ALIASES: Record<EnrichObjectType, Record<string, string>> = {
  company: invertMapping(HUBSPOT_DEFAULT_FIELD_MAPPINGS.accounts),
  contact: invertMapping(HUBSPOT_DEFAULT_FIELD_MAPPINGS.contacts),
};

function invertMapping(mapping: Record<string, string>): Record<string, string> {
  const inverted: Record<string, string> = {};
  for (const [canonical, provider] of Object.entries(mapping)) inverted[provider] = canonical;
  return inverted;
}

/** Resolve a config `crm` field name to the canonical snapshot field. */
export function resolveCrmField(objectType: EnrichObjectType, name: string): string {
  if (CANONICAL_FIELDS[objectType].includes(name)) return name;
  const canonical = PROVIDER_FIELD_ALIASES[objectType][name];
  if (canonical && CANONICAL_FIELDS[objectType].includes(canonical)) return canonical;
  throw new Error(
    `enrich config: unknown ${objectType} field "${name}". Accepted canonical fields: ` +
      `${CANONICAL_FIELDS[objectType].join(", ")} (HubSpot property spellings like ` +
      `${Object.keys(PROVIDER_FIELD_ALIASES[objectType]).join(", ")} also resolve).`,
  );
}

function fail(message: string): never {
  throw new Error(`enrich config: ${message}`);
}

/**
 * Strict, up-front validation (the 0.18 lesson: a config crash mid-run is
 * worse than a refused config). Every problem names the offending entry and
 * the accepted values.
 */
export function parseEnrichConfig(raw: string): EnrichConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("expected a JSON object with sources, match, fields, and policy");
  }
  const config = parsed as Partial<EnrichConfig>;

  // sources
  if (!config.sources || typeof config.sources !== "object" || Array.isArray(config.sources)) {
    fail('missing "sources" — declare at least one, e.g. { "apollo": { "kind": "api" } }');
  }
  const sourceIds = Object.keys(config.sources);
  if (sourceIds.length === 0) fail('"sources" is empty — declare at least one source');
  for (const [id, source] of Object.entries(config.sources)) {
    if (!source || typeof source !== "object") fail(`source "${id}" must be an object`);
    if (source.kind !== "api" && source.kind !== "ingest") {
      fail(`source "${id}": kind must be "api" or "ingest" (got ${JSON.stringify(source.kind)})`);
    }
    if (source.kind === "api" && !SUPPORTED_API_SOURCES.includes(id)) {
      fail(
        `api source "${id}" is not supported yet — MVP pulls from: ${SUPPORTED_API_SOURCES.join(", ")}. ` +
          'Push-style sources stage data via `enrich ingest` with kind "ingest".',
      );
    }
    if (source.format !== undefined && source.format !== "csv" && source.format !== "json") {
      fail(`source "${id}": format must be "csv" or "json" (got ${JSON.stringify(source.format)})`);
    }
  }

  // policy
  if (!config.policy || typeof config.policy !== "object") {
    fail('missing "policy" — e.g. { "overwrite": "never", "defaultStaleDays": 90 }');
  }
  const overwrite = (config.policy as EnrichPolicyConfig).overwrite;
  if (overwrite === ("system-only" as string) || overwrite === ("always" as string)) {
    fail(
      `policy.overwrite "${overwrite}" is not yet implemented (phase 2 of the conflict ladder — ` +
        'it needs per-field property history). MVP supports only "never" (fill blanks).',
    );
  }
  if (overwrite !== "never") {
    fail(`policy.overwrite must be "never" (got ${JSON.stringify(overwrite)})`);
  }
  const defaultStaleDays = config.policy.defaultStaleDays;
  if (defaultStaleDays !== undefined && (!Number.isFinite(defaultStaleDays) || defaultStaleDays <= 0)) {
    fail(`policy.defaultStaleDays must be a positive number (got ${JSON.stringify(defaultStaleDays)})`);
  }

  // match
  if (!config.match || typeof config.match !== "object" || Array.isArray(config.match)) {
    fail('missing "match" — e.g. { "company": { "keys": ["domain", "name"] } }');
  }
  for (const [objectType, match] of Object.entries(config.match)) {
    if (!OBJECT_TYPES.includes(objectType as EnrichObjectType)) {
      fail(`match has unknown object type "${objectType}" (use: ${OBJECT_TYPES.join(", ")})`);
    }
    if (!match || !Array.isArray(match.keys) || match.keys.length === 0) {
      fail(`match.${objectType}: "keys" must be a non-empty ordered array`);
    }
    for (const key of match.keys) {
      const known = MATCH_KEYS[objectType as EnrichObjectType];
      if (!known.includes(key)) {
        fail(`match.${objectType}: unknown key "${key}" (supported: ${known.join(", ")})`);
      }
    }
    if (match.onAmbiguous !== undefined && match.onAmbiguous !== "skip" && match.onAmbiguous !== "suggest") {
      fail(`match.${objectType}: onAmbiguous must be "skip" or "suggest" (got ${JSON.stringify(match.onAmbiguous)})`);
    }
  }

  // fields
  if (!config.fields || typeof config.fields !== "object" || Array.isArray(config.fields)) {
    fail('missing "fields" — map CRM properties to source paths per object type');
  }
  let anyField = false;
  for (const [objectType, fields] of Object.entries(config.fields)) {
    if (!OBJECT_TYPES.includes(objectType as EnrichObjectType)) {
      fail(`fields has unknown object type "${objectType}" (use: ${OBJECT_TYPES.join(", ")})`);
    }
    if (!Array.isArray(fields)) fail(`fields.${objectType} must be an array`);
    if (!config.match[objectType as EnrichObjectType]) {
      fail(`fields.${objectType} is configured but match.${objectType} is missing — the matcher needs ordered keys`);
    }
    const seen = new Set<string>();
    for (const field of fields) {
      anyField = true;
      if (!field || typeof field.crm !== "string" || field.crm.length === 0) {
        fail(`fields.${objectType}: every entry needs a "crm" property name`);
      }
      const canonical = resolveCrmField(objectType as EnrichObjectType, field.crm);
      if (seen.has(canonical)) fail(`fields.${objectType}: duplicate mapping for "${field.crm}"`);
      seen.add(canonical);
      if (!field.from || typeof field.from !== "object" || Object.keys(field.from).length === 0) {
        fail(`fields.${objectType}.${field.crm}: "from" must map at least one source to a path`);
      }
      for (const [sourceId, path] of Object.entries(field.from)) {
        if (!config.sources[sourceId]) {
          fail(
            `fields.${objectType}.${field.crm}: "from" references undeclared source "${sourceId}" ` +
              `(declared: ${sourceIds.join(", ")})`,
          );
        }
        if (typeof path !== "string" || path.length === 0) {
          fail(`fields.${objectType}.${field.crm}: path for source "${sourceId}" must be a non-empty string`);
        }
      }
      if (field.staleDays !== undefined && (!Number.isFinite(field.staleDays) || field.staleDays <= 0)) {
        fail(`fields.${objectType}.${field.crm}: staleDays must be a positive number`);
      }
      if (field.refresh !== undefined && typeof field.refresh !== "boolean") {
        fail(`fields.${objectType}.${field.crm}: refresh must be true or false`);
      }
      if (field.policy !== undefined && field.policy !== "never") {
        fail(
          `fields.${objectType}.${field.crm}: per-field policy "${String(field.policy)}" is not yet ` +
            'implemented (phase 2 of the conflict ladder). MVP supports only "never".',
        );
      }
    }
  }
  // `fields` drives append/refresh. An acquire-only config (net-new lead
  // creation, no blank-filling) legitimately maps no fields — accept it when
  // an acquire.create mapping is present.
  const hasAcquireCreate = Boolean(
    config.acquire?.create && Object.keys(config.acquire.create).length > 0,
  );
  if (!anyField && !hasAcquireCreate) {
    fail('"fields" maps nothing — add at least one field entry (or an "acquire.create" mapping)');
  }

  return config as EnrichConfig;
}

/**
 * Built-in zero-config presets for well-known sources, so the common Mode-A
 * loop — "feed a Clay export, get the dedup/routing verdict" — needs no
 * hand-authored config. These are **match-only** (empty `fields`): the value is
 * the matched / unmatched / ambiguous routing and collision detection, not field
 * writes. Drop an `enrich.config.json` next to your run to map fields for actual
 * field enrichment; an explicit config always wins over a preset. Constructed
 * directly (not via `parseEnrichConfig`) so the match-only shape is allowed.
 */
export const BUILTIN_ENRICH_PRESETS: Record<string, EnrichConfig> = {
  clay: {
    sources: { clay: { kind: "ingest", format: "csv" } },
    policy: { overwrite: "never", defaultStaleDays: 90 },
    match: {
      company: { keys: ["domain"], onAmbiguous: "skip" },
      contact: { keys: ["email"], onAmbiguous: "skip" },
    },
    fields: {},
  },
};

export function builtinEnrichPreset(source: string | undefined): EnrichConfig | undefined {
  return source ? BUILTIN_ENRICH_PRESETS[source] : undefined;
}

/**
 * Zero-config `enrich acquire` preset so every client gets targeted, deduped,
 * metered lead-fill out of the box — no hand-authored enrich.config.json. The
 * ICP (icp.json) supplies the targeting; this supplies sensible plumbing. The
 * create mapping writes the prospect's LinkedIn URL into hs_linkedin_url, so
 * each created contact strengthens future dedup. An explicit config always wins.
 */
export function builtinAcquirePreset(source: string | undefined): EnrichConfig | undefined {
  const provider = source ?? "pipe0";
  if (provider !== "pipe0" && provider !== "explorium") return undefined;
  return {
    sources: { [provider]: { kind: "api" } },
    match: { contact: { keys: ["email"], onAmbiguous: "skip" } },
    fields: {},
    policy: { overwrite: "never" },
    acquire: {
      budget: { records: { perDay: 50, perMonth: 500 }, spend: { perDay: 25, perMonth: 250 } },
      costPerRecord: { pipe0: 0.1, explorium: 0.4 },
      discovery: { [provider]: { provider, size: 25 } },
      create: {
        contact: {
          matchKey: "email",
          properties: {
            email: "email",
            firstname: "firstName",
            lastname: "lastName",
            jobtitle: "jobTitle",
            company: "companyName",
            hs_linkedin_url: "linkedin",
          },
        },
      },
    },
  };
}

export function loadEnrichConfig(path: string): EnrichConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `No enrich config at ${path}. Create ${ENRICH_CONFIG_FILE_NAME} (sources/match/fields/policy — ` +
        "see docs/enrich.md) or pass --config <path>.",
    );
  }
  return parseEnrichConfig(raw);
}

// ---------------------------------------------------------------------------
// CSV: minimal dependency-free RFC-4180-ish parser (quoted fields, embedded
// commas/newlines, "" escapes, CRLF). Header row maps columns to names.

export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      sawAny = true;
      continue;
    }
    if (char === ",") {
      pushField();
      sawAny = true;
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      // Skip empty lines (including the trailing newline).
      if (field.length > 0 || row.length > 0) pushRow();
      continue;
    }
    field += char;
    sawAny = true;
  }
  if (inQuotes) throw new Error("CSV parse error: unterminated quoted field");
  if (field.length > 0 || row.length > 0) pushRow();
  if (!sawAny || rows.length === 0) return [];

  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) record[header] = cells[index] ?? "";
    });
    return record;
  });
}

// ---------------------------------------------------------------------------
// Source records

export type EnrichSourceRecord = {
  /** e.g. "apollo:org_abc", "clay:row-3". Lands on stamps as sourceRecordId. */
  id: string;
  objectType: EnrichObjectType;
  /** Match-key values (key name → raw value), extracted by the source adapter. */
  keys: Record<string, string | undefined>;
  /** Raw source payload; field paths and evidence excerpts read from it. */
  payload: Record<string, unknown>;
};

/** Read a value from a payload: exact key first (CSV headers), then dotted path. */
export function sourceValueAt(payload: Record<string, unknown>, path: string): unknown {
  if (path in payload) return payload[path];
  let current: unknown = payload;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Case-insensitive header lookup for ingest rows ("Email" matches key "email"). */
export function ingestKeyValue(row: Record<string, unknown>, key: string): string | undefined {
  for (const [header, value] of Object.entries(row)) {
    if (header.trim().toLowerCase() === key.toLowerCase()) {
      const text = valueToString(value);
      return text || undefined;
    }
  }
  const dotted = sourceValueAt(row, key);
  const text = valueToString(dotted);
  return text || undefined;
}

function valueToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * CSV/formula-injection neutralization for string values destined for a CRM
 * write. Third-party export rows (Clay CSV, webhook JSON) can contain cells
 * like `=cmd|'/c calc'!A1` or `@SUM(...)`; written verbatim to a CRM field they
 * lie dormant until someone exports the CRM to CSV and opens it in a spreadsheet,
 * where the leading `= + - @` (or a leading tab/CR) makes the client execute it.
 * We prefix a single apostrophe — the spreadsheet-standard escape that renders
 * the cell as literal text. Numeric values bypass this (they're written as
 * numbers, not strings), so signed numbers keep full fidelity; a phone number
 * supplied as a string and starting with `+` gains a leading `'`, which the
 * human sees in the approved diff. Applied only at the write path, never to
 * match keys.
 */
function neutralizeFormulaInjection(value: string): string {
  if (value && /^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

/** valueToString for a value that will be written to a CRM field. */
function writeSafeString(value: unknown): string {
  return neutralizeFormulaInjection(valueToString(value));
}

// ---------------------------------------------------------------------------
// Matching: ordered keys, unique-hit-wins, zero-hits-next-key,
// multi-hit → onAmbiguous. Ambiguity is surfaced, never resolved by coin flip.

export type MatchOutcome =
  | { status: "matched"; recordId: string; matchedKey: string }
  | { status: "unmatched" }
  | { status: "ambiguous"; key: string; candidateIds: string[] };

function normalizeKeyValue(key: string, value: unknown): string {
  const text = valueToString(value).toLowerCase();
  if (!text) return "";
  if (key === "domain") {
    return text
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "");
  }
  return text.replace(/\s+/g, " ");
}

function crmKeyValue(
  objectType: EnrichObjectType,
  record: { name?: string; domain?: string; email?: string; firstName?: string; lastName?: string },
  key: string,
): string {
  if (objectType === "company") {
    if (key === "domain") return normalizeKeyValue("domain", record.domain);
    if (key === "name") return normalizeKeyValue("name", record.name);
    return "";
  }
  if (key === "email") return normalizeKeyValue("email", record.email);
  if (key === "name") {
    return normalizeKeyValue("name", `${record.firstName ?? ""} ${record.lastName ?? ""}`.trim());
  }
  return "";
}

export function matchSourceRecord(
  snapshot: CanonicalGtmSnapshot,
  objectType: EnrichObjectType,
  keys: string[],
  sourceKeys: Record<string, string | undefined>,
): MatchOutcome {
  const records: Array<Record<string, unknown> & { id: string }> =
    objectType === "company" ? snapshot.accounts : snapshot.contacts;
  for (const key of keys) {
    const wanted = normalizeKeyValue(key, sourceKeys[key]);
    if (!wanted) continue;
    const hits = records.filter(
      (record) => crmKeyValue(objectType, record as never, key) === wanted,
    );
    if (hits.length === 1) return { status: "matched", recordId: hits[0].id, matchedKey: key };
    if (hits.length > 1) {
      return { status: "ambiguous", key, candidateIds: hits.map((hit) => hit.id) };
    }
    // Zero hits: fall through to the next key.
  }
  return { status: "unmatched" };
}

// ---------------------------------------------------------------------------
// Plan building

// Mirrors stableHash in rules.ts (FNV-1a); duplicated to keep enrich.ts
// importable without pulling the audit engine (the market.ts precedent).
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export type EnrichMode = "append" | "refresh";

export type EnrichCounts = {
  fetched: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  opsEmitted: number;
};

export type EnrichStamp = {
  objectType: EnrichObjectType;
  objectId: string;
  /** Canonical field name. */
  field: string;
  enrichedAt: string;
  sourceRecordId: string;
  /** Source value at stamp time (refresh change-detection observability). */
  value?: unknown;
};

export type EnrichAmbiguity = {
  sourceRecordId: string;
  key: string;
  candidateIds: string[];
};

export type EnrichWorkItem = {
  objectType: EnrichObjectType;
  objectId: string;
  /** Canonical field name. */
  field: string;
};

export type BuildEnrichPlanOptions = {
  config: EnrichConfig;
  source: string;
  mode: EnrichMode;
  snapshot: CanonicalGtmSnapshot;
  records: EnrichSourceRecord[];
  /**
   * Refresh only: the stale (record, field) work set computed from run-store
   * stamps. Refresh proposes writes ONLY for work-set cells — fields the
   * ledger proves enrich itself stamped — so policy "never" still never
   * overwrites a value enrich did not put there.
   */
  workSet?: EnrichWorkItem[];
  now?: () => Date;
  runLabel: string;
};

export type EnrichPlanResult = {
  plan: PatchPlan;
  counts: EnrichCounts;
  stamps: EnrichStamp[];
  ambiguities: EnrichAmbiguity[];
  unmatchedSourceIds: string[];
};

const PLACEHOLDER_RECORD_SELECTION = "requires_human_record_selection";

function canonicalObjectType(objectType: EnrichObjectType): "account" | "contact" {
  return objectType === "company" ? "account" : "contact";
}

function crmFieldValue(
  snapshot: CanonicalGtmSnapshot,
  objectType: EnrichObjectType,
  objectId: string,
  field: string,
): unknown {
  const records = objectType === "company" ? snapshot.accounts : snapshot.contacts;
  const record = records.find((entry) => entry.id === objectId);
  return record ? (record as unknown as Record<string, unknown>)[field] : undefined;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** Values compare as trimmed strings; numbers compare numerically. */
function sameValue(a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  if (typeof a === "number" || typeof b === "number") {
    return Number(a) === Number(b);
  }
  return valueToString(a) === valueToString(b);
}

function describeSourceRecord(record: EnrichSourceRecord): string {
  const name = record.keys.name ?? record.keys.domain ?? record.keys.email ?? record.id;
  return String(name);
}

function evidenceFor(
  source: string,
  sourceKind: EnrichSourceKind,
  format: "csv" | "json" | undefined,
  record: EnrichSourceRecord,
  matchedKey: string | undefined,
  capturedAt: string,
): GtmEvidence {
  const excerpt = JSON.stringify(record.payload);
  return {
    id: `ev_enr_${fnv1a(`${source}:${record.id}`)}`,
    sourceSystem: sourceKind === "api" ? "web" : format === "csv" ? "csv" : "manual",
    sourceObjectType: record.objectType,
    sourceObjectId: record.id,
    title: `${source} payload for ${describeSourceRecord(record)}`,
    text: excerpt.length > 1200 ? `${excerpt.slice(0, 1200)}…` : excerpt,
    capturedAt,
    metadata: { source, sourceRecordId: record.id, matchedKey: matchedKey ?? null },
  };
}

/**
 * Match source records against the snapshot and emit a patch plan under the
 * conflict policy. Append fills blanks only; refresh proposes updates for
 * stale stamped fields whose source value actually changed (beforeValue =
 * current CRM value → apply-time compare-and-set rejects drifted records).
 */
export function buildEnrichPlan(options: BuildEnrichPlanOptions): EnrichPlanResult {
  const { config, source, mode, snapshot, records, runLabel } = options;
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  const sourceConfig = config.sources[source];
  if (!sourceConfig) throw new Error(`enrich: source "${source}" is not declared in the config`);

  const workSet = options.workSet ?? [];
  const workKeys = new Set(workSet.map((item) => `${item.objectType}|${item.objectId}|${item.field}`));

  const operations: PatchOperation[] = [];
  const evidence: GtmEvidence[] = [];
  const stamps: EnrichStamp[] = [];
  const ambiguities: EnrichAmbiguity[] = [];
  const unmatchedSourceIds: string[] = [];
  const counts: EnrichCounts = { fetched: records.length, matched: 0, unmatched: 0, ambiguous: 0, opsEmitted: 0 };

  for (const record of records) {
    const match = config.match[record.objectType];
    const fields = (config.fields[record.objectType] ?? []).filter(
      (field) => field.from[source] !== undefined,
    );
    // Run the matcher whenever the object type has match keys; field mappings
    // only gate whether we EMIT field ops. With no fields (a match-only config,
    // e.g. the built-in Clay preset) this still reports the matched / ambiguous
    // / unmatched routing verdict and records collisions — the Mode-A hygiene
    // gate — it just proposes zero field writes.
    if (!match) {
      counts.unmatched += 1;
      unmatchedSourceIds.push(record.id);
      continue;
    }
    const outcome = matchSourceRecord(snapshot, record.objectType, match.keys, record.keys);

    if (outcome.status === "unmatched") {
      counts.unmatched += 1;
      unmatchedSourceIds.push(record.id);
      continue;
    }

    if (outcome.status === "ambiguous") {
      counts.ambiguous += 1;
      ambiguities.push({ sourceRecordId: record.id, key: outcome.key, candidateIds: outcome.candidateIds });
      if ((match.onAmbiguous ?? "skip") === "skip") continue;
      // onAmbiguous: suggest — emit placeholder operations (one per candidate
      // per field) so the existing suggest → plans approve --values-from /
      // --value chain resolves the record selection. Apply refuses to write
      // requires_human_* placeholders without an explicit value.
      const recordEvidence = evidenceFor(source, sourceConfig.kind, sourceConfig.format, record, undefined, nowIso);
      let emittedForRecord = false;
      for (const field of fields) {
        const sourceValue = sourceValueAt(record.payload, field.from[source]);
        if (isEmptyValue(sourceValue)) continue;
        const canonicalField = resolveCrmField(record.objectType, field.crm);
        for (const candidateId of outcome.candidateIds) {
          const currentValue = crmFieldValue(snapshot, record.objectType, candidateId, canonicalField);
          if (!isEmptyValue(currentValue)) continue; // policy never: blanks only
          emittedForRecord = true;
          operations.push({
            id: `op_enr_${fnv1a(`${source}:${record.objectType}:${candidateId}:${canonicalField}`)}`,
            objectType: canonicalObjectType(record.objectType),
            objectId: candidateId,
            operation: "set_field",
            field: canonicalField,
            beforeValue: currentValue ?? null,
            afterValue: PLACEHOLDER_RECORD_SELECTION,
            reason:
              `${source} record "${describeSourceRecord(record)}" matched ${outcome.candidateIds.length} CRM ` +
              `records on ${outcome.key} (${outcome.candidateIds.join(", ")}). If ${candidateId} is the right ` +
              `record, approve with --value <opId>=${JSON.stringify(valueToString(sourceValue))}.`,
            sourceRuleOrPolicy: `enrich:${source}:${canonicalField}`,
            riskLevel: "medium",
            approvalRequired: true,
            rollback: "Clear the field (the before value was empty) if the selection was wrong.",
            evidenceIds: [recordEvidence.id],
          });
          counts.opsEmitted += 1;
        }
      }
      if (emittedForRecord) evidence.push(recordEvidence);
      continue;
    }

    // Matched.
    counts.matched += 1;
    const recordEvidence = evidenceFor(
      source,
      sourceConfig.kind,
      sourceConfig.format,
      record,
      outcome.matchedKey,
      nowIso,
    );
    let emittedForRecord = false;

    for (const field of fields) {
      const canonicalField = resolveCrmField(record.objectType, field.crm);
      const sourceValue = sourceValueAt(record.payload, field.from[source]);
      const currentValue = crmFieldValue(snapshot, record.objectType, outcome.recordId, canonicalField);
      const cellKey = `${record.objectType}|${outcome.recordId}|${canonicalField}`;

      if (mode === "refresh") {
        // Refresh touches ONLY stamped, stale cells from the work set.
        if (!workKeys.has(cellKey)) continue;
        // Re-stamp every checked cell (changed or not): the staleness clock
        // resets because the source was actually consulted.
        stamps.push({
          objectType: record.objectType,
          objectId: outcome.recordId,
          field: canonicalField,
          enrichedAt: nowIso,
          sourceRecordId: record.id,
          value: sourceValue,
        });
        if (isEmptyValue(sourceValue)) continue; // source went blank: never propose clearing
        if (sameValue(sourceValue, currentValue)) continue; // unchanged: no op
        emittedForRecord = true;
        operations.push({
          id: `op_enr_${fnv1a(`${source}:${record.objectType}:${outcome.recordId}:${canonicalField}`)}`,
          objectType: canonicalObjectType(record.objectType),
          objectId: outcome.recordId,
          operation: "set_field",
          field: canonicalField,
          beforeValue: currentValue ?? null,
          afterValue: typeof sourceValue === "number" ? sourceValue : writeSafeString(sourceValue),
          reason:
            `${source} ${record.objectType} "${describeSourceRecord(record)}" (matched by ` +
            `${outcome.matchedKey}) reports a changed value for ${canonicalField}.`,
          sourceRuleOrPolicy: `enrich:${source}:${canonicalField}`,
          riskLevel: isEmptyValue(currentValue) ? "low" : "medium",
          approvalRequired: true,
          rollback: "Restore the before value if the refreshed value is wrong.",
          evidenceIds: [recordEvidence.id],
        });
        counts.opsEmitted += 1;
        continue;
      }

      // Append: fill blanks only (policy "never").
      if (isEmptyValue(sourceValue)) continue;
      if (!isEmptyValue(currentValue)) continue;
      emittedForRecord = true;
      const afterValue = typeof sourceValue === "number" ? sourceValue : writeSafeString(sourceValue);
      operations.push({
        id: `op_enr_${fnv1a(`${source}:${record.objectType}:${outcome.recordId}:${canonicalField}`)}`,
        objectType: canonicalObjectType(record.objectType),
        objectId: outcome.recordId,
        operation: "set_field",
        field: canonicalField,
        beforeValue: currentValue ?? null,
        afterValue,
        reason:
          `${source} ${record.objectType} "${describeSourceRecord(record)}" (matched by ` +
          `${outcome.matchedKey}) fills the blank ${canonicalField}.`,
        sourceRuleOrPolicy: `enrich:${source}:${canonicalField}`,
        riskLevel: "low",
        approvalRequired: true,
        rollback: "Clear the field (the before value was empty) if the enrichment is wrong.",
        evidenceIds: [recordEvidence.id],
      });
      counts.opsEmitted += 1;
      stamps.push({
        objectType: record.objectType,
        objectId: outcome.recordId,
        field: canonicalField,
        enrichedAt: nowIso,
        sourceRecordId: record.id,
        value: afterValue,
      });
    }
    if (emittedForRecord) evidence.push(recordEvidence);
  }

  const plan: PatchPlan = {
    id: `patch_plan_enr_${fnv1a(`${source}:${mode}:${runLabel}:${nowIso}`)}`,
    title: `Enrichment ${mode} — ${source}`,
    createdAt: nowIso,
    status: operations.length > 0 ? "needs_approval" : "draft",
    dryRun: true,
    summary:
      `${counts.opsEmitted} proposed operation(s) from ${source} ${mode} (${counts.fetched} source ` +
      `record(s): ${counts.matched} matched, ${counts.unmatched} unmatched, ${counts.ambiguous} ambiguous). ` +
      `Conflict policy: ${config.policy.overwrite}.`,
    findings: [],
    evidence,
    operations,
  };

  return { plan, counts, stamps, ambiguities, unmatchedSourceIds };
}

// ---------------------------------------------------------------------------
// Acquire: turn sourced-but-unmatched prospects into net-new lead creates.

export type AcquireCounts = {
  fetched: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  /** create_record ops emitted. */
  created: number;
  /** unmatched rows that would have been created but for the meter ceiling. */
  withheldByMeter: number;
};

export type AcquirePlanResult = {
  plan: PatchPlan;
  counts: AcquireCounts;
  estCostUsd: number;
};

export type BuildAcquirePlanOptions = {
  config: EnrichConfig;
  source: string;
  snapshot: CanonicalGtmSnapshot;
  records: EnrichSourceRecord[];
  runLabel: string;
  /** Meter ceiling: max create ops to emit. null/undefined = unlimited. */
  maxRecords?: number | null;
  now?: () => Date;
};

/**
 * Match each sourced record against the snapshot and route it: matched =
 * already in the CRM (skip), ambiguous = a possible duplicate exists (skip —
 * resolve-first never creates over ambiguity), unmatched = a net-new lead.
 * Unmatched rows with a dedupe key and at least one mapped property become
 * `create_record` operations, capped at `maxRecords` (the meter's headroom).
 * Always a dry-run plan; nothing is written until apply.
 */
export function buildAcquirePlan(options: BuildAcquirePlanOptions): AcquirePlanResult {
  const { config, source, snapshot, records, runLabel } = options;
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  const sourceConfig = config.sources[source];
  if (!sourceConfig) throw new Error(`enrich: source "${source}" is not declared in the config`);
  const acquire = config.acquire;
  if (!acquire) throw new Error('enrich acquire: config has no "acquire" section');

  const cap = options.maxRecords ?? null;
  const costPerRecord = acquire.costPerRecord?.[source] ?? 0;

  const operations: PatchOperation[] = [];
  const evidence: GtmEvidence[] = [];
  const counts: AcquireCounts = {
    fetched: records.length,
    matched: 0,
    ambiguous: 0,
    unmatched: 0,
    created: 0,
    withheldByMeter: 0,
  };
  let estCostUsd = 0;

  for (const record of records) {
    const createMap = acquire.create[record.objectType];
    const match = config.match[record.objectType];
    // No create mapping or no match config for this type — can neither create
    // nor dedupe it safely; count as unmatched and skip.
    if (!createMap || !match) {
      counts.unmatched += 1;
      continue;
    }
    const outcome = matchSourceRecord(snapshot, record.objectType, match.keys, record.keys);
    if (outcome.status === "matched") {
      counts.matched += 1;
      continue;
    }
    if (outcome.status === "ambiguous") {
      // Resolve-first: a possible duplicate exists — never create over it.
      counts.ambiguous += 1;
      continue;
    }

    counts.unmatched += 1;
    const matchValue = String(record.keys[createMap.matchKey] ?? "").trim();
    if (!matchValue) continue; // no dedupe key → refuse to create (can't resolve-first)

    if (cap !== null && counts.created >= cap) {
      counts.withheldByMeter += 1;
      continue;
    }

    const properties: Record<string, string> = {};
    for (const [crmProp, path] of Object.entries(createMap.properties)) {
      const value = sourceValueAt(record.payload, path);
      if (!isEmptyValue(value)) properties[crmProp] = String(value);
    }
    if (Object.keys(properties).length === 0) continue; // nothing to write

    let associateCompanyName: string | undefined;
    if (createMap.associateCompanyFrom) {
      const companyValue = sourceValueAt(record.payload, createMap.associateCompanyFrom);
      if (!isEmptyValue(companyValue)) associateCompanyName = String(companyValue);
    }

    const recordEvidence = evidenceFor(
      source,
      sourceConfig.kind,
      sourceConfig.format,
      record,
      undefined,
      nowIso,
    );
    evidence.push(recordEvidence);

    const payload: CreateRecordPayload = {
      properties,
      matchKey: createMap.matchKey,
      matchValue,
      source,
      estCostUsd: costPerRecord,
      associateCompanyName,
    };
    operations.push({
      id: `op_acq_${fnv1a(`${source}:${record.objectType}:${matchValue}`)}`,
      objectType: canonicalObjectType(record.objectType),
      objectId: `create:${matchValue}`,
      operation: "create_record",
      beforeValue: null,
      afterValue: payload,
      reason:
        `${source} sourced net-new ${record.objectType} "${describeSourceRecord(record)}" ` +
        `(${createMap.matchKey}=${matchValue}); no CRM match — create as a lead.`,
      sourceRuleOrPolicy: `acquire:${source}`,
      riskLevel: "medium",
      approvalRequired: true,
      rollback: "Archive the created record (it was net-new).",
      evidenceIds: [recordEvidence.id],
    });
    counts.created += 1;
    estCostUsd += costPerRecord;
  }

  const plan: PatchPlan = {
    id: `patch_plan_acq_${fnv1a(`${source}:${runLabel}:${nowIso}`)}`,
    title: `Acquire leads — ${source}`,
    createdAt: nowIso,
    status: operations.length > 0 ? "needs_approval" : "draft",
    dryRun: true,
    summary:
      `${counts.created} net-new lead(s) proposed from ${source} (${counts.fetched} sourced: ` +
      `${counts.matched} already in CRM, ${counts.ambiguous} ambiguous skipped, ${counts.unmatched} unmatched` +
      `${counts.withheldByMeter > 0 ? `, ${counts.withheldByMeter} withheld by meter` : ""}). ` +
      `Est. cost $${estCostUsd.toFixed(2)}.`,
    findings: [],
    evidence,
    operations,
  };
  return { plan, counts, estCostUsd };
}

// ---------------------------------------------------------------------------
// Staleness: compute the refresh work set from run-store stamps.

/** Latest stamp per (objectType, objectId, field) across a source's runs. */
export function latestStamps(runs: EnrichRun[], source: string): Map<string, EnrichStamp> {
  const latest = new Map<string, EnrichStamp>();
  for (const run of runs) {
    if (run.source !== source) continue;
    for (const stamp of run.stamps) {
      const key = `${stamp.objectType}|${stamp.objectId}|${stamp.field}`;
      const existing = latest.get(key);
      if (!existing || existing.enrichedAt < stamp.enrichedAt) latest.set(key, stamp);
    }
  }
  return latest;
}

export function staleDaysFor(config: EnrichConfig, objectType: EnrichObjectType, field: string): number {
  const entry = (config.fields[objectType] ?? []).find(
    (candidate) => resolveCrmField(objectType, candidate.crm) === field,
  );
  return entry?.staleDays ?? config.policy.defaultStaleDays ?? DEFAULT_STALE_DAYS;
}

/**
 * Stale (record, field) cells: stamped by this source, refresh-eligible in
 * the config, and older than the staleness window (per-field staleDays →
 * policy.defaultStaleDays → 90; --stale-days overrides all).
 */
export function selectStaleWork(
  config: EnrichConfig,
  runs: EnrichRun[],
  source: string,
  options: { now?: () => Date; staleDaysOverride?: number } = {},
): EnrichWorkItem[] {
  const now = (options.now ?? (() => new Date()))().getTime();
  const work: EnrichWorkItem[] = [];
  for (const stamp of latestStamps(runs, source).values()) {
    const entry = (config.fields[stamp.objectType] ?? []).find(
      (candidate) =>
        resolveCrmField(stamp.objectType, candidate.crm) === stamp.field &&
        candidate.from[source] !== undefined,
    );
    if (!entry?.refresh) continue;
    const windowDays =
      options.staleDaysOverride ?? entry.staleDays ?? config.policy.defaultStaleDays ?? DEFAULT_STALE_DAYS;
    const ageDays = (now - Date.parse(stamp.enrichedAt)) / 86_400_000;
    if (ageDays > windowDays) {
      work.push({ objectType: stamp.objectType, objectId: stamp.objectId, field: stamp.field });
    }
  }
  return work;
}

// ---------------------------------------------------------------------------
// Run store: append-only JSON files under the profile home, one per run label.
// Checkpoint (cursor), staleness ledger (stamps), and observability surface
// (enrich status) in one structure — mirrors the market observations store.

export type EnrichRunMode = EnrichMode | "ingest";

export type EnrichRun = {
  id: string;
  runLabel: string;
  source: string;
  mode: EnrichRunMode;
  startedAt: string;
  /** null while in progress — `status` surfaces it as an interrupted run. */
  completedAt: string | null;
  /** Resume point for an interrupted pull (last processed pull key). */
  cursor: string | null;
  counts: EnrichCounts;
  planIds: string[];
  stamps: EnrichStamp[];
  /** Staged source rows (ingest mode only), consumed by append/refresh. */
  staged?: Array<Record<string, unknown>>;
  /** Object type of the staged rows (ingest mode only). */
  stagedObjectType?: EnrichObjectType;
  /**
   * Source records pulled so far (api pulls with --save). Together with
   * `cursor` this makes the checkpoint complete: a resumed run replays the
   * already-paid-for payloads instead of re-fetching them.
   */
  pulled?: EnrichSourceRecord[];
  /** Pull keys the source returned no data for (api pulls with --save). */
  missedKeys?: string[];
  /** Match collisions recorded for review (candidate ids included). */
  ambiguities?: EnrichAmbiguity[];
};

export function enrichRunId(source: string, runLabel: string): string {
  return `enr_${fnv1a(`${source}|${runLabel}`)}`;
}

export function enrichRunsDir(baseDir?: string): string {
  return join(baseDir ?? credentialsDir(), "enrich", "runs");
}

export interface EnrichRunStore {
  /** Append a new run; refuses an existing label (runs are append-only). */
  append(run: EnrichRun): Promise<EnrichRun>;
  /** Update an in-progress run (cursor checkpoint, finalization) in place. */
  update(run: EnrichRun): Promise<EnrichRun>;
  get(runLabel: string): Promise<EnrichRun | null>;
  list(): Promise<EnrichRun[]>;
  latest(filter?: { source?: string; mode?: EnrichRunMode }): Promise<EnrichRun | null>;
}

export function createFileEnrichRunStore(directory?: string): EnrichRunStore {
  const dir = directory ?? enrichRunsDir();

  function fileFor(runLabel: string) {
    if (!/^[\w.-]+$/.test(runLabel)) throw new Error(`Invalid run label: ${runLabel}`);
    return join(dir, `${runLabel}.json`);
  }

  function read(runLabel: string): EnrichRun | null {
    try {
      return JSON.parse(readFileSync(fileFor(runLabel), "utf8")) as EnrichRun;
    } catch {
      return null;
    }
  }

  function write(run: EnrichRun): EnrichRun {
    // Run files carry CRM record ids and source values; keep them owner-only
    // like plan files (and lock the home down even before any login).
    if (!directory) ensureSecureHomeDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeSecureFile(fileFor(run.runLabel), `${JSON.stringify(run, null, 2)}\n`);
    return run;
  }

  function listRuns(): EnrichRun[] {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .map((name) => read(name.slice(0, -".json".length)))
      .filter((run): run is EnrichRun => run !== null)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  return {
    async append(run) {
      if (read(run.runLabel)) {
        throw new Error(
          `Run "${run.runLabel}" already exists — enrich runs are append-only; use a new run label`,
        );
      }
      return write(run);
    },
    async update(run) {
      const existing = read(run.runLabel);
      if (!existing) throw new Error(`No enrich run "${run.runLabel}" to update`);
      if (existing.id !== run.id) {
        throw new Error(`Run "${run.runLabel}" belongs to a different run id (${existing.id})`);
      }
      return write(run);
    },
    async get(runLabel) {
      return read(runLabel);
    },
    async list() {
      return listRuns();
    },
    async latest(filter = {}) {
      const runs = listRuns().filter(
        (run) =>
          (filter.source === undefined || run.source === filter.source) &&
          (filter.mode === undefined || run.mode === filter.mode),
      );
      return runs.length ? runs[runs.length - 1] : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Ingest staging helpers

/**
 * Infer the object type of staged rows from the configured match keys: the
 * type whose key columns actually appear on the rows. Exactly one hit wins;
 * zero or two is an error asking for --objects.
 */
export function inferIngestObjectType(
  config: EnrichConfig,
  source: string,
  rows: Array<Record<string, unknown>>,
): EnrichObjectType {
  const sample = rows[0] ?? {};
  const hits = OBJECT_TYPES.filter((objectType) => {
    const match = config.match[objectType];
    const fields = (config.fields[objectType] ?? []).some((field) => field.from[source] !== undefined);
    if (!match || !fields) return false;
    return match.keys.some((key) => ingestKeyValue(sample, key) !== undefined);
  });
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) {
    throw new Error(
      `enrich ingest: cannot tell whether these rows are companies or contacts — no configured match key ` +
        `column found. Pass --objects companies|contacts, or add the key column to the export.`,
    );
  }
  throw new Error(
    `enrich ingest: rows carry match keys for ${hits.join(" and ")} — pass --objects companies|contacts to disambiguate.`,
  );
}

/** Turn staged ingest rows into source records for the matcher. */
export function stagedSourceRecords(
  config: EnrichConfig,
  source: string,
  run: EnrichRun,
): EnrichSourceRecord[] {
  const objectType = run.stagedObjectType;
  const rows = run.staged ?? [];
  if (!objectType || rows.length === 0) {
    throw new Error(
      `enrich: run "${run.runLabel}" has no staged data — stage a Clay export first: ` +
        `fullstackgtm enrich ingest <file.csv|payload.json> --source ${source}`,
    );
  }
  const match = config.match[objectType];
  if (!match) throw new Error(`enrich: no match config for ${objectType}`);
  return rows.map((row, index) => {
    const keys: Record<string, string | undefined> = {};
    for (const key of match.keys) keys[key] = ingestKeyValue(row, key);
    return {
      id: `${source}:${run.runLabel}:row-${index + 1}`,
      objectType,
      keys,
      payload: row,
    };
  });
}
