/**
 * Source connectors for the `signals` layer — the connection-based intake that
 * generalizes the no-auth ATS adapters (`atsBoards.ts`) and the hand-staged
 * `--from <file.json>` path into one contract: a platform connection in, a list
 * of evidence-bearing staged signal rows out.
 *
 * Design (see docs/spec-connectors-signals-outbound.md):
 *   - Zero runtime deps: global `fetch` only, injectable for tests.
 *   - Read-only: a source never writes a CRM record and never emits a
 *     PatchOperation. `signals fetch` stays read-only re: the CRM.
 *   - Verbatim evidence: every row carries a non-empty `quote`; a row that
 *     cannot ground a why-now is dropped, never faked. The central
 *     `stagedRowToSignal` gate enforces this again.
 *   - Secrets via the credential ladder: API keys come from
 *     `ctx.getApiKey(provider)` (login store -> env -> broker), NEVER from argv.
 *     `ctx.options` carries non-secret knobs only (a file path, a query term).
 *   - Per-source resilience: a connector's own failure yields `[]` (logged by
 *     the caller), it must never sink a multi-source run — the per-provider
 *     try/catch idiom of atsBoards/prospectSources.
 */
import type { SignalBucket, StagedSignalRow } from "../signals.ts";
export type SignalSourceShape = "pull" | "push";
export type SignalSourceAuth = "none" | "api_key" | "oauth";
/** Everything a source connector needs for one `fetch`, supplied by the CLI. */
export type SignalSourceContext = {
    /** Accounts to scope a pull. May be empty (a file/spool source ignores it). */
    watchlist: {
        domain: string;
    }[];
    /** Evidence keywords for job/listing-style sources; may be empty. */
    keywords: string[];
    now: Date;
    /** Injectable fetch for tests; global `fetch` by default. */
    fetchImpl?: typeof fetch;
    /**
     * Credential-ladder lookup. Returns a usable secret for `provider`, or null
     * when nothing is configured (the connector then returns []). Secrets NEVER
     * arrive via argv — only through this.
     */
    getApiKey?: (provider: string) => Promise<string | null>;
    /** Non-secret per-connector knobs from `--connector-opt k=v` (paths, queries). */
    options?: Record<string, string>;
};
export type SignalSourceConnector = {
    id: string;
    /** Default bucket this source feeds (a row may still override it). */
    bucket: SignalBucket;
    shape: SignalSourceShape;
    auth: SignalSourceAuth;
    /**
     * Produce staged rows now. Resilient by contract: the connector's own
     * failures (offline, non-2xx, malformed payload, missing key) resolve to []
     * rather than throwing, so one source's outage never aborts a multi-source
     * `signals fetch`. Validation/evidence-gating of the returned rows happens
     * centrally in `stagedRowToSignal`.
     */
    fetch(ctx: SignalSourceContext): Promise<StagedSignalRow[]>;
};
/**
 * Read staged rows from a local path — the webhook landing-zone reader. The path
 * (from `options.path`/`options.file`) may be:
 *   - a single FILE: a JSON array, or newline-delimited JSON (one row per line);
 *   - a DIRECTORY (the conventional spool): every `*.jsonl` / `*.json` file in
 *     it is read and concatenated (sorted by name), so multiple receivers can
 *     each append their own file (`rb2b.jsonl`, `hubspot.jsonl`) and they all
 *     land in one fetch.
 * No auth. This is how every push platform (RB2B, Trigify, HubSpot webhooks)
 * reaches the CLI: a receiver appends a row to the spool, this reads it on the
 * next `signals fetch`. The CLI defaults the path to the conventional spool dir
 * (`signalsSpoolDir`) when `--connector file` is used with no path; a bare
 * library call with no path is inactive (returns []).
 *
 * Resilient: a missing path / unreadable file yields [] (an empty source, not a
 * crash), and one unreadable file in a spool directory is skipped. A file that
 * IS present but malformed throws — a corrupt spool is a real error to surface,
 * not silent data loss. The central `stagedRowToSignal` gate validates rows.
 */
export declare const fileSource: SignalSourceConnector;
/**
 * Pull recent news per watchlist account and stage funding/company signals. One
 * query per account (`q="<domain>"`, Google News engine); each result becomes a
 * row whose verbatim `quote` is the headline (+ source), so the downstream judge
 * can ground a why-now on a real, linkable article. API key via the credential
 * ladder (provider "serpapi"); no key -> [] (the source is simply inactive).
 *
 * Bucket defaults to `funding`; override per run with `--connector-opt bucket=company`.
 */
export declare const serpapiNewsSource: SignalSourceConnector;
/**
 * Stage `demand` signals from recent HubSpot form submissions — the first real
 * `demand`-bucket producer (a form fill is first-party demand). Reuses the
 * EXISTING HubSpot credential via the ladder (provider "hubspot"); no separate
 * login. Each submission whose email carries a company domain becomes a row
 * whose verbatim `quote` is the form name + submitted email (the evidence a rep
 * can verify). Submissions without a corporate domain (free-mail) are dropped —
 * no account to attach demand to.
 *
 * Phase 1 is a pull over the Forms submissions API; the form-submission webhook
 * (push) lands in Phase 2 via the spool + `file` source.
 */
export declare const hubspotFormsSource: SignalSourceConnector;
/** All registered source connectors (stable order). */
export declare function listSignalSources(): SignalSourceConnector[];
/** Resolve a connector by id, or null when unknown. */
export declare function getSignalSource(id: string): SignalSourceConnector | null;
