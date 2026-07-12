import { getCredential } from "../credentials.ts";
import { ProviderHttpError } from "../providerError.ts";
import type { Prospect } from "./prospectSources.ts";

export const CLAY_PUBLIC_API_BASE = "https://api.clay.com/public/v0";

export type ClayKeyValidation = {
  ok: boolean;
  detail: string;
  workspaceId?: string;
};

export type ClaySearchSourceType = "people" | "companies";

export type ClayPeopleSearchPage = {
  prospects: Prospect[];
  hasMore: boolean;
};

export type ClayCompany = {
  name?: string;
  domain?: string;
  linkedin?: string;
  description?: string;
  industry?: string;
  size?: string;
  location?: string;
  fundingAmountRange?: string;
};

export type ClayCompanySearchPage = { companies: ClayCompany[]; hasMore: boolean };

function clayHeaders(apiKey: string): Record<string, string> {
  return { "clay-api-key": apiKey, Accept: "application/json", "Content-Type": "application/json" };
}

/** Create a forward-only Clay search iterator. This call does not fetch a page. */
export async function createClaySearch(opts: {
  apiKey: string;
  sourceType: ClaySearchSourceType;
  filters: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.apiBaseUrl ?? CLAY_PUBLIC_API_BASE).replace(/\/$/, "");
  const response = await fetchImpl(`${base}/search/filters-mode`, {
    method: "POST",
    headers: clayHeaders(opts.apiKey),
    body: JSON.stringify({ source_type: opts.sourceType, filters: opts.filters }),
  });
  if (!response.ok) throw new ProviderHttpError("Clay", "create search", response.status);
  const body = await response.json() as { search_id?: unknown; searchId?: unknown };
  const searchId = body.search_id ?? body.searchId;
  if (typeof searchId !== "string" || !searchId) throw new Error("Clay create search returned no search_id.");
  return searchId;
}

/** Consume the next people page from a Clay search iterator. */
export async function runClayPeopleSearchPage(opts: {
  apiKey: string;
  searchId: string;
  limit?: number;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}): Promise<ClayPeopleSearchPage> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.apiBaseUrl ?? CLAY_PUBLIC_API_BASE).replace(/\/$/, "");
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  const response = await fetchImpl(`${base}/search/filters-mode/${encodeURIComponent(opts.searchId)}/run`, {
    method: "POST",
    headers: clayHeaders(opts.apiKey),
    body: JSON.stringify({ limit }),
  });
  if (!response.ok) throw new ProviderHttpError("Clay", "run people search", response.status);
  const body = await response.json() as { data?: unknown; has_more?: unknown; hasMore?: unknown };
  if (!Array.isArray(body.data)) throw new Error("Clay people search returned an invalid data array.");
  const hasMore = body.has_more ?? body.hasMore;
  if (typeof hasMore !== "boolean") throw new Error("Clay people search returned no has_more flag.");
  return { prospects: body.data.map(normalizeClayPerson), hasMore };
}

/** Consume the next company page from a Clay search iterator. */
export async function runClayCompanySearchPage(opts: {
  apiKey: string; searchId: string; limit?: number; fetchImpl?: typeof fetch; apiBaseUrl?: string;
}): Promise<ClayCompanySearchPage> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.apiBaseUrl ?? CLAY_PUBLIC_API_BASE).replace(/\/$/, "");
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  const response = await fetchImpl(`${base}/search/filters-mode/${encodeURIComponent(opts.searchId)}/run`, {
    method: "POST", headers: clayHeaders(opts.apiKey), body: JSON.stringify({ limit }),
  });
  if (!response.ok) throw new ProviderHttpError("Clay", "run company search", response.status);
  const body = await response.json() as { data?: unknown; has_more?: unknown; hasMore?: unknown };
  if (!Array.isArray(body.data)) throw new Error("Clay company search returned an invalid data array.");
  const hasMore = body.has_more ?? body.hasMore;
  if (typeof hasMore !== "boolean") throw new Error("Clay company search returned no has_more flag.");
  return { companies: body.data.map(normalizeClayCompany), hasMore };
}

export function normalizeClayCompany(value: unknown): ClayCompany {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    name: stringValue(row.name), domain: bareDomain(stringValue(row.domain)),
    linkedin: normalizeLinkedin(stringValue(row.linkedin_url)), description: stringValue(row.description),
    industry: stringValue(row.industry), size: stringValue(row.size), location: stringValue(row.location),
    fundingAmountRange: stringValue(row.total_funding_amount_range_usd),
  };
}

/** Account-first investment discovery: find thesis-shaped companies, then
 * resolve founders/operators only inside those accounts. */
export async function discoverClayInvestmentProspects(opts: {
  apiKey: string;
  companyFilters: Record<string, unknown>;
  titleKeywords: string[];
  companyLimit: number;
  prospectLimit: number;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}): Promise<{ prospects: Prospect[]; companiesScanned: number; companiesMatched: ClayCompany[] }> {
  const companySearchId = await createClaySearch({
    apiKey: opts.apiKey, sourceType: "companies", filters: opts.companyFilters,
    fetchImpl: opts.fetchImpl, apiBaseUrl: opts.apiBaseUrl,
  });
  const companyPage = await runClayCompanySearchPage({
    apiKey: opts.apiKey, searchId: companySearchId, limit: opts.companyLimit,
    fetchImpl: opts.fetchImpl, apiBaseUrl: opts.apiBaseUrl,
  });
  const prospects: Prospect[] = [];
  const identifiers = companyPage.companies.map((company) => company.domain ?? company.linkedin).filter((value): value is string => Boolean(value));
  if (identifiers.length > 0) {
    const peopleSearchId = await createClaySearch({
      apiKey: opts.apiKey, sourceType: "people",
      filters: { company_identifier: identifiers, job_title_keywords: opts.titleKeywords },
      fetchImpl: opts.fetchImpl, apiBaseUrl: opts.apiBaseUrl,
    });
    const peoplePage = await runClayPeopleSearchPage({
      apiKey: opts.apiKey, searchId: peopleSearchId,
      limit: opts.prospectLimit,
      fetchImpl: opts.fetchImpl, apiBaseUrl: opts.apiBaseUrl,
    });
    // company_identifier may match a past experience. Investment discovery is
    // explicitly account-first, so retain only people currently at an account.
    const currentDomains = new Set(companyPage.companies.map((company) => company.domain).filter(Boolean));
    prospects.push(...peoplePage.prospects.filter((person) => person.companyDomain && currentDomains.has(person.companyDomain)));
  }
  return { prospects, companiesScanned: companyPage.companies.length, companiesMatched: companyPage.companies };
}

export function normalizeClayPerson(value: unknown): Prospect {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const location = row.structured_location && typeof row.structured_location === "object"
    ? row.structured_location as Record<string, unknown>
    : {};
  const fullName = stringValue(row.name);
  return {
    firstName: stringValue(row.first_name),
    lastName: stringValue(row.last_name),
    fullName,
    jobTitle: stringValue(row.latest_experience_title),
    companyName: stringValue(row.latest_experience_company),
    companyDomain: bareDomain(stringValue(row.domain)),
    linkedin: normalizeLinkedin(stringValue(row.url)),
    headline: undefined,
    sourceId: normalizeLinkedin(stringValue(row.url)) ?? fullName,
    location: {
      city: stringValue(location.city),
      state: stringValue(location.state),
      region: stringValue(location.region),
      country: stringValue(location.country),
      countryCode: stringValue(location.country_iso),
    },
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bareDomain(value: string | undefined): string | undefined {
  return value?.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase() || undefined;
}

function normalizeLinkedin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.startsWith("http") ? value : `https://${value.replace(/^\/+/, "")}`;
  return normalized.replace(/\/$/, "");
}

/** Validate a Clay Public API key without creating a search or spending enrichment credits. */
export async function validateClayApiKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  apiBaseUrl = CLAY_PUBLIC_API_BASE,
): Promise<ClayKeyValidation> {
  let response: Response;
  try {
    response = await fetchImpl(`${apiBaseUrl.replace(/\/$/, "")}/me`, {
      headers: { "clay-api-key": apiKey, Accept: "application/json" },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `Cannot reach the Clay Public API: ${detail}` };
  }
  if (!response.ok) return { ok: false, detail: `Clay rejected the key: HTTP ${response.status}` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, detail: "Clay accepted the request but returned an invalid JSON response." };
  }
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const workspace = record.workspace && typeof record.workspace === "object"
    ? record.workspace as Record<string, unknown>
    : undefined;
  const rawWorkspaceId = record.workspace_id ?? record.workspaceId ?? workspace?.id;
  const workspaceId = typeof rawWorkspaceId === "string" || typeof rawWorkspaceId === "number"
    ? String(rawWorkspaceId)
    : undefined;
  return {
    ok: true,
    detail: workspaceId ? `Key accepted by Clay workspace ${workspaceId}.` : "Key accepted by the Clay Public API.",
    workspaceId,
  };
}

/** Resolve Clay credentials using the standard env -> profile-scoped store ladder. */
export function clayApiKey(env: Record<string, string | undefined> = process.env): string {
  const key = env.CLAY_API_KEY ?? getCredential("clay")?.accessToken;
  if (key) return key;
  throw new Error(
    'No Clay credentials. Run `clay api-keys create --name "fullstackgtm"`, then pipe the key to ' +
      '`fullstackgtm login clay`, or set CLAY_API_KEY.',
  );
}
