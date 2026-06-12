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
