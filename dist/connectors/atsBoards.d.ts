/**
 * ATS job-board adapters for the `signals` layer — the free, no-auth example of
 * "watch an account for hiring motion." Each public board JSON endpoint turns a
 * company's board token into a list of open roles; the signals layer maps each
 * role to a `job` signal whose `quote` is the role title plus a JD snippet that
 * VERBATIM contains a configured keyword (so the downstream judge/drafter can
 * gate a why-now on something a human can verify).
 *
 * Mirrors the `prospectSources.ts` raw-fetch idiom exactly: zero runtime deps
 * (global fetch only, injectable for tests), a base-url override per provider,
 * and a per-request `try { } catch { continue }` so one provider's outage never
 * sinks a multi-source fetch. No SDK, no key.
 *
 * Governance: read-only. These adapters fetch public board JSON and return open
 * roles. They write nothing — the signals layer (and only with `--save`) is the
 * one that persists, and it never touches the CRM.
 */
export type AtsBoardSource = "greenhouse" | "lever" | "ashby";
/** One open role, normalized across the three providers. */
export type AtsJob = {
    /** Role title, verbatim from the board. */
    title: string;
    /**
     * A short JD snippet. When `keywords` are supplied, this is a window around
     * the first matching keyword (kept verbatim so the keyword survives into the
     * evidence quote); otherwise it is the leading slice of the description.
     */
    jdSnippet: string;
    /** Canonical posting URL (the signal's sourceUrl). */
    url: string;
    /**
     * Stable per-role identity within a board (provider id when present, else the
     * title). Used by the reposted-role heuristic to tell "same role, gone, back"
     * from "two roles that happen to share a title".
     */
    firstSeenKey: string;
};
type FetchImpl = typeof fetch;
/**
 * Fetch open roles for one board. Network failures (offline, non-2xx, malformed
 * JSON) yield `[]` rather than throwing, matching the per-source resilience of
 * the prospect sources — a single board's outage must not abort a watchlist run.
 */
export declare function fetchAtsJobs(opts: {
    source: AtsBoardSource;
    boardToken: string;
    accountDomain: string;
    keywords?: string[];
    fetchImpl?: FetchImpl;
    apiBaseUrl?: string;
}): Promise<AtsJob[]>;
/**
 * Pick a verbatim JD snippet. If a keyword matches the description (case-
 * insensitive), return a window centered on the first match — kept verbatim so
 * the keyword text survives into the signal quote and the evidence gate holds.
 * With no keywords (or no match), fall back to the leading slice. Returns "" for
 * an empty description so the caller can decide whether the role still qualifies.
 */
export declare function snippetFor(description: string, keywords: string[]): string;
export {};
