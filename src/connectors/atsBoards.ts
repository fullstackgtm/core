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

const DEFAULT_BASE_URLS: Record<AtsBoardSource, string> = {
  greenhouse: "https://boards-api.greenhouse.io",
  lever: "https://api.lever.co",
  ashby: "https://api.ashbyhq.com",
};

/** JD snippet length — long enough to carry a verbatim keyword window. */
const SNIPPET_LEN = 240;

/**
 * Fetch open roles for one board. Network failures (offline, non-2xx, malformed
 * JSON) yield `[]` rather than throwing, matching the per-source resilience of
 * the prospect sources — a single board's outage must not abort a watchlist run.
 */
export async function fetchAtsJobs(opts: {
  source: AtsBoardSource;
  boardToken: string;
  accountDomain: string;
  keywords?: string[];
  fetchImpl?: FetchImpl;
  apiBaseUrl?: string;
}): Promise<AtsJob[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.apiBaseUrl ?? DEFAULT_BASE_URLS[opts.source]).replace(/\/$/, "");
  const token = opts.boardToken.trim();
  if (!token) return [];
  const keywords = opts.keywords ?? [];
  try {
    if (opts.source === "greenhouse") {
      return await fetchGreenhouse(fetchImpl, base, token, keywords);
    }
    if (opts.source === "lever") {
      return await fetchLever(fetchImpl, base, token, keywords);
    }
    return await fetchAshby(fetchImpl, base, token, keywords);
  } catch {
    // Offline / 5xx / malformed payload: an empty board, never a crash.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Greenhouse — GET /v1/boards/<token>/jobs?content=true

async function fetchGreenhouse(
  fetchImpl: FetchImpl,
  base: string,
  token: string,
  keywords: string[],
): Promise<AtsJob[]> {
  const response = await fetchImpl(`${base}/v1/boards/${encodeURIComponent(token)}/jobs?content=true`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return [];
  const data = (await response.json()) as {
    jobs?: Array<{ id?: number | string; title?: string; absolute_url?: string; content?: string }>;
  };
  const out: AtsJob[] = [];
  for (const job of data.jobs ?? []) {
    const title = strOrEmpty(job.title);
    if (!title) continue;
    const description = decodeHtmlish(strOrEmpty(job.content));
    out.push({
      title,
      jdSnippet: snippetFor(description, keywords),
      url: strOrEmpty(job.absolute_url),
      firstSeenKey: job.id != null ? String(job.id) : title,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lever — GET /v0/postings/<token>?mode=json (returns a bare array)

async function fetchLever(
  fetchImpl: FetchImpl,
  base: string,
  token: string,
  keywords: string[],
): Promise<AtsJob[]> {
  const response = await fetchImpl(`${base}/v0/postings/${encodeURIComponent(token)}?mode=json`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return [];
  const data = (await response.json()) as Array<{
    id?: string;
    text?: string;
    hostedUrl?: string;
    descriptionPlain?: string;
    description?: string;
  }>;
  const out: AtsJob[] = [];
  for (const posting of Array.isArray(data) ? data : []) {
    const title = strOrEmpty(posting.text);
    if (!title) continue;
    const description = strOrEmpty(posting.descriptionPlain) || decodeHtmlish(strOrEmpty(posting.description));
    out.push({
      title,
      jdSnippet: snippetFor(description, keywords),
      url: strOrEmpty(posting.hostedUrl),
      firstSeenKey: strOrEmpty(posting.id) || title,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ashby — POST /posting-api/job-board/<token> with { jobBoardName }

async function fetchAshby(
  fetchImpl: FetchImpl,
  base: string,
  token: string,
  keywords: string[],
): Promise<AtsJob[]> {
  const response = await fetchImpl(`${base}/posting-api/job-board/${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jobBoardName: token, includeCompensation: false }),
  });
  if (!response.ok) return [];
  const data = (await response.json()) as {
    jobs?: Array<{
      id?: string;
      title?: string;
      jobUrl?: string;
      applyUrl?: string;
      descriptionPlain?: string;
      descriptionHtml?: string;
    }>;
  };
  const out: AtsJob[] = [];
  for (const job of data.jobs ?? []) {
    const title = strOrEmpty(job.title);
    if (!title) continue;
    const description = strOrEmpty(job.descriptionPlain) || decodeHtmlish(strOrEmpty(job.descriptionHtml));
    out.push({
      title,
      jdSnippet: snippetFor(description, keywords),
      url: strOrEmpty(job.jobUrl) || strOrEmpty(job.applyUrl),
      firstSeenKey: strOrEmpty(job.id) || title,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snippet selection: a verbatim window around the first matching keyword.

/**
 * Pick a verbatim JD snippet. If a keyword matches the description (case-
 * insensitive), return a window centered on the first match — kept verbatim so
 * the keyword text survives into the signal quote and the evidence gate holds.
 * With no keywords (or no match), fall back to the leading slice. Returns "" for
 * an empty description so the caller can decide whether the role still qualifies.
 */
export function snippetFor(description: string, keywords: string[]): string {
  const text = description.trim();
  if (!text) return "";
  for (const keyword of keywords) {
    const needle = keyword.trim();
    if (!needle) continue;
    const idx = text.toLowerCase().indexOf(needle.toLowerCase());
    if (idx === -1) continue;
    const pad = Math.max(0, Math.floor((SNIPPET_LEN - needle.length) / 2));
    let start = Math.max(0, idx - pad);
    let end = Math.min(text.length, idx + needle.length + pad);
    // Snap to word boundaries so the window doesn't start/end mid-word, but
    // never past the keyword itself (the verbatim span must stay intact).
    while (start > 0 && /\S/.test(text[start - 1]) && start < idx) start += 1;
    while (end < text.length && /\S/.test(text[end]) && end > idx + needle.length) end -= 1;
    return text.slice(start, end).trim();
  }
  return text.slice(0, SNIPPET_LEN).trim();
}

/**
 * Minimal HTML-ish cleanup for board `content`/`description` HTML: drop tags and
 * decode the handful of entities Greenhouse/Ashby emit. Dependency-free; good
 * enough to surface a readable, keyword-matchable snippet (the quote does not
 * need to be byte-perfect HTML, only verbatim text the keyword appears in).
 */
function decodeHtmlish(raw: string): string {
  return raw
    .replace(/<\s*br\s*\/?\s*>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function strOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
