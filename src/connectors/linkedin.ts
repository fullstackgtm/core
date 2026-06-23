/**
 * LinkedIn connector — Phase 1 discovery (read-only).
 *
 * A provider-agnostic surface for pulling prospects out of LinkedIn via a
 * rented execution layer (default: HeyReach; Unipile is a drop-in alternative).
 * Deliberately decoupled from the acquire spine — the `Icp`→filter and
 * `LinkedInProspect`→`Prospect` bridges live in the `enrich acquire --source
 * linkedin` wiring, not here — so this layer can land and be tested on its own.
 *
 * Phase 2 (future) extends `LinkedInProvider` with send actions
 * (connect/message) routed through the plan/apply gate. Spec:
 * docs/linkedin-connector-spec.md. Nothing here ever writes or sends.
 */

export type LinkedInProspect = {
  firstName: string;
  lastName: string;
  fullName?: string;
  headline?: string;
  jobTitle?: string;
  company?: string;
  /** Canonical LinkedIn profile URL — the identity key dedup uses downstream. */
  profileUrl: string;
  location?: string;
  email?: string;
  emailStatus?: string;
  /** The raw provider payload, preserved for debugging and later mapping. */
  raw?: unknown;
};

export type LinkedInSource = {
  /** Provider-native id of a prospect source (HeyReach: a lead-list id). */
  id: string;
  name: string;
  /** Approximate prospect count, when the provider reports it. */
  count?: number;
};

export type FetchProspectsOptions = {
  /** Which source to read (HeyReach lead-list id); provider may have a default. */
  sourceId?: string;
  /** Hard cap on prospects returned; also bounds pagination. */
  max?: number;
};

export type ConnectionStatus = { ok: boolean; detail: string };

/**
 * Provider-agnostic LinkedIn discovery surface (Phase 1). Read-only: it
 * enumerates prospect sources and pulls normalized prospects, never sends.
 */
export interface LinkedInProvider {
  readonly name: string;
  /** Cheap auth/connectivity check; never throws — returns ok:false instead. */
  checkConnection(): Promise<ConnectionStatus>;
  /** Enumerate prospect sources (HeyReach lead lists). */
  listSources(): Promise<LinkedInSource[]>;
  /** Pull prospects from a source, normalized + capped. */
  fetchProspects(options?: FetchProspectsOptions): Promise<LinkedInProspect[]>;
}

// ── HeyReach adapter ────────────────────────────────────────────────────────
// Base + auth verified 2026-06-20: POST endpoints, `X-API-KEY` header, 300
// req/min (429). Confirmed live: /auth/CheckApiKey, /list/GetAll. The
// leads-from-list path has a documented gap in HeyReach's public docs and is
// marked to reconcile at live validation (step 3, needs a real key).

export const HEYREACH_BASE = "https://api.heyreach.io/api/public";
const HEYREACH_MAX_PAGE = 100;

export type HeyReachProviderOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Lead-list id used when fetchProspects is called without an explicit sourceId. */
  defaultListId?: string;
  /** Page size for paginated reads (≤ server max). Lower in tests. */
  pageSize?: number;
};

export function createHeyReachProvider(options: HeyReachProviderOptions): LinkedInProvider {
  const apiKey = options.apiKey;
  if (!apiKey) {
    throw new Error("HeyReach API key is required (`login heyreach` or HEYREACH_API_KEY).");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? HEYREACH_BASE).replace(/\/$/, "");
  const pageSize = Math.max(1, Math.min(options.pageSize ?? HEYREACH_MAX_PAGE, HEYREACH_MAX_PAGE));

  async function call(path: string, method: "GET" | "POST", body?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        // Secret travels in the header, never the URL (no leak via logs/history).
        headers: {
          "X-API-KEY": apiKey,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error(`Cannot reach HeyReach at ${baseUrl}${path}. Check network access.`);
    }
    if (response.status === 429) {
      const retry = response.headers.get("Retry-After");
      throw new Error(
        `HeyReach rate limit (429)${retry ? `; retry after ${retry}s` : ""}. The cap is 300 requests/min.`,
      );
    }
    if (!response.ok) {
      await response.text().catch(() => undefined);
      throw new Error(`HeyReach API error ${response.status} on ${path}. Check the API key and request.`);
    }
    if (response.status === 204) return undefined;
    return response.json().catch(() => undefined);
  }

  return {
    name: "heyreach",

    async checkConnection() {
      try {
        await call("/auth/CheckApiKey", "GET");
        return { ok: true, detail: "HeyReach API key valid." };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },

    async listSources() {
      const data = await call("/list/GetAll", "POST", { offset: 0, limit: HEYREACH_MAX_PAGE });
      return toArray(data).map((item: any) => ({
        id: String(item?.id ?? item?.listId ?? ""),
        name: String(item?.name ?? item?.title ?? "(unnamed list)"),
        count:
          typeof item?.totalItemsCount === "number"
            ? item.totalItemsCount
            : typeof item?.count === "number"
              ? item.count
              : undefined,
      }));
    },

    async fetchProspects(opts = {}) {
      const listId = opts.sourceId ?? options.defaultListId;
      if (!listId) {
        throw new Error(
          "HeyReach fetchProspects needs a sourceId (lead-list id) or a configured defaultListId — list them with listSources().",
        );
      }
      const max = opts.max ?? Number.POSITIVE_INFINITY;
      const out: LinkedInProspect[] = [];
      let offset = 0;
      while (out.length < max) {
        const data = await call("/list/GetLeadsFromList", "POST", { listId, offset, limit: pageSize });
        const items = toArray(data);
        if (items.length === 0) break;
        for (const item of items) {
          out.push(normalizeHeyReachLead(item));
          if (out.length >= max) break;
        }
        if (items.length < pageSize) break;
        offset += items.length;
      }
      return out;
    },
  };
}

/** First value that is a non-empty string, else undefined (treats "" as absent). */
function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** HeyReach wraps list payloads as `{ items: [...] }` on some routes, bare arrays on others. */
function toArray(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

/** Map a HeyReach lead (nested `profile` or flat) into the normalized shape. */
export function normalizeHeyReachLead(raw: any): LinkedInProspect {
  const p = (raw && typeof raw === "object" && raw.profile) || raw || {};
  const first = p.firstName ?? raw?.firstName ?? "";
  const last = p.lastName ?? raw?.lastName ?? "";
  const full = (p.fullName ?? raw?.fullName ?? `${first} ${last}`.trim()) || undefined;
  return {
    firstName: String(first ?? ""),
    lastName: String(last ?? ""),
    fullName: full,
    headline: p.headline ?? raw?.headline ?? undefined,
    jobTitle: p.position ?? p.jobTitle ?? raw?.position ?? undefined,
    company: p.companyName ?? p.company ?? raw?.companyName ?? undefined,
    profileUrl: String(p.profileUrl ?? p.linkedInUrl ?? raw?.profileUrl ?? raw?.linkedin_url ?? ""),
    location: p.location ?? raw?.location ?? undefined,
    // HeyReach exposes the raw `emailAddress` plus its own enrichment outputs
    // (`enrichedEmailAddress`, `customEmailAddress`) — verified against the live
    // /list/GetLeadsFromList schema 2026-06-20. Unresolved emails come back as
    // "", so pick the first NON-EMPTY value (?? would keep the empty string).
    email: firstNonEmpty(p.emailAddress, p.enrichedEmailAddress, p.customEmailAddress, p.email, raw?.emailAddress),
    emailStatus: p.emailStatus ?? raw?.emailStatus ?? undefined,
    raw,
  };
}

// ── Fake provider (tests / dry-run with no key, no network) ─────────────────

export const FAKE_LINKEDIN_PROSPECTS: LinkedInProspect[] = [
  {
    firstName: "Dana",
    lastName: "Okafor",
    fullName: "Dana Okafor",
    headline: "VP RevOps",
    jobTitle: "VP Revenue Operations",
    company: "Northwind Logistics",
    profileUrl: "https://www.linkedin.com/in/dana-okafor",
    location: "Chicago, IL",
    email: "dana@northwind.example",
    emailStatus: "verified",
  },
  {
    firstName: "Priya",
    lastName: "Raman",
    fullName: "Priya Raman",
    headline: "Head of Sales Ops",
    jobTitle: "Head of Sales Operations",
    company: "Cobalt Health",
    profileUrl: "https://www.linkedin.com/in/priya-raman",
    location: "Austin, TX",
  },
  {
    firstName: "Marco",
    lastName: "Bianchi",
    fullName: "Marco Bianchi",
    headline: "RevOps Manager",
    jobTitle: "Revenue Operations Manager",
    company: "Ferro Systems",
    profileUrl: "https://www.linkedin.com/in/marco-bianchi",
    location: "Remote",
    email: "marco@ferro.example",
    emailStatus: "guessed",
  },
];

export type FakeLinkedInOptions = {
  prospects?: LinkedInProspect[];
  sources?: LinkedInSource[];
  connection?: ConnectionStatus;
};

export function createFakeLinkedInProvider(opts: FakeLinkedInOptions = {}): LinkedInProvider {
  const prospects = opts.prospects ?? FAKE_LINKEDIN_PROSPECTS;
  const sources = opts.sources ?? [{ id: "list_demo", name: "Demo ICP list", count: prospects.length }];
  return {
    name: "fake",
    async checkConnection() {
      return opts.connection ?? { ok: true, detail: "fake LinkedIn provider" };
    },
    async listSources() {
      return sources.map((s) => ({ ...s }));
    },
    async fetchProspects(options = {}) {
      const capped = options.max != null ? prospects.slice(0, options.max) : prospects;
      return capped.map((p) => ({ ...p }));
    },
  };
}
