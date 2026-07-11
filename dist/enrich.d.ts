import type { AcquireBudget } from "./acquireMeter.ts";
import type { ProgressEmitter } from "./progress.ts";
import type { AssignmentContext, AssignmentPolicy } from "./assign.ts";
import { type ContactWaterfallStep } from "./contactProviders.ts";
import type { CanonicalGtmSnapshot, PatchPlan } from "./types.ts";
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
    /**
     * Optional source path to the company domain. With it (or a derivable email
     * domain) the connector resolves the account by domain and stamps the domain
     * on it — so the lead's account is signal-watchable, not just a text field.
     */
    associateCompanyDomainFrom?: string;
};
/**
 * Net-new discovery for an API acquire source. `provider` selects the adapter
 * (explorium = prospect search; pipe0 = work-email waterfall). `filters` is the
 * provider-native query; `resolveEmailsWith` chains a second provider to fill
 * real emails (e.g. explorium discovers, pipe0 resolves the work email).
 */
export type AcquireDiscoveryConfig = {
    provider: "explorium" | "pipe0" | "clay" | "linkedin" | "heyreach";
    /** Clay search collection. Phase 1 supports people; companies follows separately. */
    sourceType?: "people" | "companies";
    filters?: Record<string, unknown>;
    size?: number;
    /** Maximum raw provider candidates scanned per run while seeking fresh leads. */
    scanLimit?: number;
    /** Ordered fill-only contact providers. Later steps receive only unresolved fields. */
    contactWaterfall?: ContactWaterfallStep[];
    /** @deprecated Use contactWaterfall. Retained for existing configurations. */
    resolveEmailsWith?: "pipe0";
    /** LinkedIn sources only: the provider-native list id to read (HeyReach lead-list id). */
    listId?: string;
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
    /**
     * Ownership rule stamped onto every created lead so it is never born
     * ownerless. Absent = no auto-assignment (the CLI may still default to the
     * portal's sole active owner). Shared with `reassign --assign-unowned`.
     */
    assign?: AssignmentPolicy;
};
export declare const ENRICH_CONFIG_FILE_NAME = "enrich.config.json";
export declare const DEFAULT_STALE_DAYS = 90;
/** API source ids the MVP can pull from. */
export declare const SUPPORTED_API_SOURCES: string[];
/** Resolve a config `crm` field name to the canonical snapshot field. */
export declare function resolveCrmField(objectType: EnrichObjectType, name: string): string;
/**
 * Strict, up-front validation (the 0.18 lesson: a config crash mid-run is
 * worse than a refused config). Every problem names the offending entry and
 * the accepted values.
 */
export declare function parseEnrichConfig(raw: string): EnrichConfig;
/**
 * Built-in zero-config presets for well-known sources, so the common Mode-A
 * loop — "feed a Clay export, get the dedup/routing verdict" — needs no
 * hand-authored config. These are **match-only** (empty `fields`): the value is
 * the matched / unmatched / ambiguous routing and collision detection, not field
 * writes. Drop an `enrich.config.json` next to your run to map fields for actual
 * field enrichment; an explicit config always wins over a preset. Constructed
 * directly (not via `parseEnrichConfig`) so the match-only shape is allowed.
 */
export declare const BUILTIN_ENRICH_PRESETS: Record<string, EnrichConfig>;
export declare function builtinEnrichPreset(source: string | undefined): EnrichConfig | undefined;
/**
 * Zero-config `enrich acquire` preset so every client gets targeted, deduped,
 * metered lead-fill out of the box — no hand-authored enrich.config.json. The
 * ICP (icp.json) supplies the targeting; this supplies sensible plumbing. The
 * create mapping writes the prospect's LinkedIn URL into hs_linkedin_url, so
 * each created contact strengthens future dedup. An explicit config always wins.
 */
export declare function builtinAcquirePreset(source: string | undefined): EnrichConfig | undefined;
export declare function loadEnrichConfig(path: string): EnrichConfig;
export declare function parseCsv(text: string): Array<Record<string, string>>;
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
export declare function sourceValueAt(payload: Record<string, unknown>, path: string): unknown;
/** Case-insensitive header lookup for ingest rows ("Email" matches key "email"). */
export declare function ingestKeyValue(row: Record<string, unknown>, key: string): string | undefined;
export type MatchOutcome = {
    status: "matched";
    recordId: string;
    matchedKey: string;
} | {
    status: "unmatched";
} | {
    status: "ambiguous";
    key: string;
    candidateIds: string[];
};
export declare function matchSourceRecord(snapshot: CanonicalGtmSnapshot, objectType: EnrichObjectType, keys: string[], sourceKeys: Record<string, string | undefined>): MatchOutcome;
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
/**
 * Match source records against the snapshot and emit a patch plan under the
 * conflict policy. Append fills blanks only; refresh proposes updates for
 * stale stamped fields whose source value actually changed (beforeValue =
 * current CRM value → apply-time compare-and-set rejects drifted records).
 */
export declare function buildEnrichPlan(options: BuildEnrichPlanOptions): EnrichPlanResult;
export type AcquireCounts = {
    fetched: number;
    matched: number;
    ambiguous: number;
    unmatched: number;
    /** create_record ops emitted. */
    created: number;
    /** unmatched rows that would have been created but for the meter ceiling. */
    withheldByMeter: number;
    /** created ops that got an owner stamped (a subset of `created`). */
    assigned: number;
    /** created ops left ownerless (no policy, or policy could not place them). */
    unassigned: number;
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
    /**
     * Shared progress vocabulary (src/progress.ts): `items` over the candidate
     * rows as they are routed, plus a `meter` reading of creates vs the meter
     * ceiling. Presentation-only — never changes what the plan proposes.
     */
    progress?: ProgressEmitter;
};
/**
 * Lift a prospect/source payload into the routing attributes a territory rule
 * reads. Tolerant of provider spellings (explorium vs pipe0); absent attributes
 * stay undefined, so a rule that routes on them simply won't match (falling to
 * the policy fallback) instead of mis-routing.
 */
export declare function acquireAssignmentContext(payload: Record<string, unknown>, companyName: string | undefined, accountOwnerByName: ReadonlyMap<string, string>): AssignmentContext;
/**
 * Match each sourced record against the snapshot and route it: matched =
 * already in the CRM (skip), ambiguous = a possible duplicate exists (skip —
 * resolve-first never creates over ambiguity), unmatched = a net-new lead.
 * Unmatched rows with a dedupe key and at least one mapped property become
 * `create_record` operations, capped at `maxRecords` (the meter's headroom).
 * Always a dry-run plan; nothing is written until apply.
 */
export declare function buildAcquirePlan(options: BuildAcquirePlanOptions): AcquirePlanResult;
/** Latest stamp per (objectType, objectId, field) across a source's runs. */
export declare function latestStamps(runs: EnrichRun[], source: string): Map<string, EnrichStamp>;
export declare function staleDaysFor(config: EnrichConfig, objectType: EnrichObjectType, field: string): number;
/**
 * Stale (record, field) cells: stamped by this source, refresh-eligible in
 * the config, and older than the staleness window (per-field staleDays →
 * policy.defaultStaleDays → 90; --stale-days overrides all).
 */
export declare function selectStaleWork(config: EnrichConfig, runs: EnrichRun[], source: string, options?: {
    now?: () => Date;
    staleDaysOverride?: number;
}): EnrichWorkItem[];
export type EnrichRunMode = EnrichMode | "ingest" | "acquire";
/**
 * Provider continuation state for an acquisition query. The fingerprint binds
 * a cursor/offset to the ICP + provider filters that produced it, preventing a
 * changed query from accidentally resuming in the middle of the old audience.
 */
export type AcquireDiscoveryCheckpoint = {
    queryFingerprint: string;
    /** Opaque provider cursor (Pipe0 and other cursor-based sources). */
    cursor?: string | null;
    /** Zero-based provider offset (LinkedIn/HeyReach and other offset sources). */
    offset?: number | null;
    /** True only when the provider has positively reported no next page. */
    exhausted: boolean;
};
/**
 * Truthful acquisition funnel for one run. Each field counts candidates, not
 * provider requests, making duplicate saturation and resolution loss visible
 * instead of reporting every run as zero.
 */
export type AcquireRunFunnel = {
    /** Raw candidates returned across all discovery pages scanned this run. */
    discovered: number;
    /** Candidates that met the configured ICP threshold. */
    qualified: number;
    /** Qualified candidates removed by the CRM pre-email dedupe. */
    skippedCrm: number;
    /** Qualified candidates removed by the cross-run seen ledger. */
    skippedSeen: number;
    /** Fresh candidates carrying the configured resolve-first key. */
    resolved: number;
    /** Governed create operations emitted into the saved/dry-run plan. */
    proposed: number;
    /** Otherwise-proposable candidates held back by the acquire meter. */
    withheldByMeter: number;
};
export type AcquireRunTelemetry = {
    funnel: AcquireRunFunnel;
    discovery: AcquireDiscoveryCheckpoint;
};
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
    /** Acquisition-only funnel + provider continuation state (absent on legacy runs). */
    acquireTelemetry?: AcquireRunTelemetry;
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
export declare function enrichRunId(source: string, runLabel: string): string;
export declare function enrichRunsDir(baseDir?: string): string;
export interface EnrichRunStore {
    /** Append a new run; refuses an existing label (runs are append-only). */
    append(run: EnrichRun): Promise<EnrichRun>;
    /** Update an in-progress run (cursor checkpoint, finalization) in place. */
    update(run: EnrichRun): Promise<EnrichRun>;
    get(runLabel: string): Promise<EnrichRun | null>;
    list(): Promise<EnrichRun[]>;
    latest(filter?: {
        source?: string;
        mode?: EnrichRunMode;
    }): Promise<EnrichRun | null>;
}
export declare function createFileEnrichRunStore(directory?: string): EnrichRunStore;
/**
 * Infer the object type of staged rows from the configured match keys: the
 * type whose key columns actually appear on the rows. Exactly one hit wins;
 * zero or two is an error asking for --objects.
 */
export declare function inferIngestObjectType(config: EnrichConfig, source: string, rows: Array<Record<string, unknown>>): EnrichObjectType;
/** Turn staged ingest rows into source records for the matcher. */
export declare function stagedSourceRecords(config: EnrichConfig, source: string, run: EnrichRun): EnrichSourceRecord[];
