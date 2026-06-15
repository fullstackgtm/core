/**
 * Apollo source client for the enrich layer: raw fetch against Apollo's REST
 * enrichment endpoints (people match, organization enrich), bring-your-own
 * key (`login apollo`), no SDK.
 *
 * The one genuinely new HTTP behavior lives here and ONLY here: enrichment
 * APIs rate-limit aggressively, so requests retry on 429 with capped
 * exponential backoff (honoring Retry-After when present). The shared
 * connector contract is deliberately untouched.
 */
const DEFAULT_API_BASE_URL = "https://api.apollo.io";
const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function retryDelayMs(response, attempt) {
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0)
            return Math.min(seconds * 1000, MAX_BACKOFF_MS);
        const at = Date.parse(retryAfter);
        if (Number.isFinite(at))
            return Math.min(Math.max(at - Date.now(), 0), MAX_BACKOFF_MS);
    }
    return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}
export function createApolloClient(options) {
    const baseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
    const fetchImpl = options.fetchImpl ?? fetch;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const sleep = options.sleep ?? defaultSleep;
    async function request(path, init = {}) {
        const apiKey = await options.getApiKey();
        for (let attempt = 0;; attempt += 1) {
            let response;
            try {
                response = await fetchImpl(`${baseUrl}${path}`, {
                    ...init,
                    headers: {
                        "X-Api-Key": apiKey,
                        "Content-Type": "application/json",
                        Accept: "application/json",
                        ...(init.headers ?? {}),
                    },
                });
            }
            catch (error) {
                const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
                throw new Error(`Cannot reach Apollo at ${baseUrl}${cause}. Check network access.`);
            }
            if (response.status === 429 && attempt < maxRetries) {
                await sleep(retryDelayMs(response, attempt));
                continue;
            }
            if (response.status === 404)
                return null;
            if (!response.ok) {
                // Status line only — never interpolate the response body. It can echo
                // the submitted query (contact emails / company domains) or the API key,
                // and these errors are persisted verbatim into scheduled-run records.
                await response.text().catch(() => undefined);
                const exhausted = response.status === 429 ? ` (rate limited; ${maxRetries} retries exhausted)` : "";
                throw new Error(`Apollo API error ${response.status}${exhausted}. Check the API key and request.`);
            }
            const text = await response.text();
            return text ? JSON.parse(text) : null;
        }
    }
    return {
        async enrichOrganization(domain) {
            return request(`/api/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`, {
                method: "GET",
            });
        },
        async matchPerson(email) {
            return request("/api/v1/people/match", {
                method: "POST",
                body: JSON.stringify({ email }),
            });
        },
    };
}
function stringAt(payload, path) {
    let current = payload;
    for (const segment of path) {
        if (!current || typeof current !== "object")
            return undefined;
        current = current[segment];
    }
    return typeof current === "string" && current ? current : undefined;
}
/**
 * Pull keys for an append run: records of the requested types where at least
 * one configured field is blank and the pull key (companies: domain,
 * contacts: email) is present. Deduplicated — two CRM companies sharing a
 * domain produce ONE Apollo call, and the matcher then reports the collision.
 */
export function apolloPullKeysForAppend(snapshot, objectTypes, needsEnrichment) {
    const keys = [];
    const seen = new Set();
    for (const objectType of objectTypes) {
        const records = objectType === "company" ? snapshot.accounts : snapshot.contacts;
        const keyName = objectType === "company" ? "domain" : "email";
        for (const record of records) {
            const value = record[keyName]?.trim();
            if (!value)
                continue;
            if (!needsEnrichment(objectType, record))
                continue;
            const dedupe = `${objectType}|${value.toLowerCase()}`;
            if (seen.has(dedupe))
                continue;
            seen.add(dedupe);
            keys.push({ objectType, key: keyName, value });
        }
    }
    return keys;
}
/** Pull keys for a refresh run: the stale work set mapped back to pull keys. */
export function apolloPullKeysForRefresh(snapshot, workSet) {
    const keys = [];
    const seen = new Set();
    for (const item of workSet) {
        const records = item.objectType === "company" ? snapshot.accounts : snapshot.contacts;
        const record = records.find((entry) => entry.id === item.objectId);
        if (!record)
            continue;
        const keyName = item.objectType === "company" ? "domain" : "email";
        const value = record[keyName]?.trim();
        if (!value)
            continue;
        const dedupe = `${item.objectType}|${value.toLowerCase()}`;
        if (seen.has(dedupe))
            continue;
        seen.add(dedupe);
        keys.push({ objectType: item.objectType, key: keyName, value });
    }
    return keys;
}
/**
 * Execute the pull: one Apollo call per key, normalized into source records.
 * Sequential on purpose (enrichment endpoints rate-limit aggressively); the
 * 429 backoff lives in the client. `onProgress` checkpoints the run-store
 * cursor after every key so an interrupted pull resumes instead of re-paying
 * for completed lookups.
 */
export async function pullApolloRecords(client, keys, options = {}) {
    const records = [];
    const misses = [];
    // Resume: skip keys up to and including the checkpoint. An unknown
    // checkpoint (snapshot changed since the interrupted run) restarts cleanly.
    const resumeIndex = options.resumeAfter
        ? keys.findIndex((key) => key.value === options.resumeAfter)
        : -1;
    for (const key of keys.slice(resumeIndex + 1)) {
        let record;
        if (key.objectType === "company") {
            const payload = await client.enrichOrganization(key.value);
            const organization = payload?.organization;
            if (organization) {
                record = {
                    id: `apollo:org_${stringAt(payload, ["organization", "id"]) ?? key.value}`,
                    objectType: "company",
                    keys: {
                        domain: stringAt(payload, ["organization", "primary_domain"]) ?? key.value,
                        name: stringAt(payload, ["organization", "name"]),
                    },
                    payload: payload,
                };
            }
        }
        else {
            const payload = await client.matchPerson(key.value);
            const person = payload?.person;
            if (person) {
                record = {
                    id: `apollo:person_${stringAt(payload, ["person", "id"]) ?? key.value}`,
                    objectType: "contact",
                    keys: {
                        email: stringAt(payload, ["person", "email"]) ?? key.value,
                        name: stringAt(payload, ["person", "name"]),
                    },
                    payload: payload,
                };
            }
        }
        if (record)
            records.push(record);
        else
            misses.push(key);
        await options.onProgress?.({ lastKeyValue: key.value, record, miss: record ? undefined : key });
    }
    return { records, misses };
}
