import { HUBSPOT_DEFAULT_FIELD_MAPPINGS, mappedField, mappedFields, readMappedValue, } from "../mappings.js";
import { SNAPSHOT_PULL_STAGES } from "../progress.js";
const DEFAULT_API_BASE_URL = "https://api.hubapi.com";
const OBJECT_PATHS = {
    account: "companies",
    contact: "contacts",
    deal: "deals",
};
const MAPPING_OBJECT_TYPES = {
    account: "accounts",
    contact: "contacts",
    deal: "deals",
};
// SnapshotProgress object types → the shared SNAPSHOT_PULL_STAGES names, so
// the CLI checklist and the app StageTimeline read the same stage labels.
const PULL_STAGE_BY_TYPE = {
    user: "owners",
    account: "accounts",
    contact: "contacts",
    deal: "deals",
};
/**
 * Reference connector for HubSpot.
 *
 * Unlike sync pipelines that drop records they cannot fully resolve, the
 * connector returns every record it can read — including ownerless or
 * amountless deals — so audit rules can surface the gaps instead of hiding
 * them.
 */
export function createHubspotConnector(options) {
    const baseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
    const fetchImpl = options.fetchImpl ?? fetch;
    const maxRetries = options.maxRetries ?? 5;
    const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const mappings = options.fieldMappings;
    // create:<Name> dedup within one connector lifetime (one apply run): the
    // search API is eventually consistent, so a just-created company is
    // invisible to search — this map is the authoritative same-run record.
    const createdCompaniesByName = new Map();
    // Same-run dedup for `create_record` contact creates, keyed by lowercased
    // match value (email): HubSpot search is eventually consistent, so a contact
    // created earlier in this apply run is invisible to a later search.
    const createdContactsByMatch = new Map();
    // Same-run dedup for `create_record` deal creates, keyed by
    // matchKey:matchValue (e.g. stripe_invoice_id:in_123) — same
    // eventual-consistency rationale as the contact cache.
    const createdDealsByMatch = new Map();
    // One /crm/v3/pipelines/deals read per connector lifetime (one apply run):
    // pipeline/stage metadata doesn't change mid-run, and deal creates resolve
    // the closed-won stage from it per operation.
    let dealPipelinesCache;
    // Custom deal dedupe properties ensured (or confirmed missing) this run.
    const ensuredDealProperties = new Map();
    // Per-page snapshot-pull progress: the legacy onProgress callback plus the
    // shared emitter (stage on the first page of each object type, items per
    // page). Both are presentation-only — callers already swallow errors.
    let lastPullStage;
    const pullProgress = (objectType, fetched) => {
        options.onProgress?.({ objectType, fetched });
        const emitter = options.progress;
        if (!emitter)
            return;
        const stage = PULL_STAGE_BY_TYPE[objectType];
        if (stage !== lastPullStage) {
            lastPullStage = stage;
            emitter.stage(stage, SNAPSHOT_PULL_STAGES.indexOf(stage), SNAPSHOT_PULL_STAGES.length);
        }
        emitter.items(fetched);
    };
    async function request(path, init = {}) {
        let response;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            const token = await options.getAccessToken();
            try {
                response = await fetchImpl(`${baseUrl}${path}`, {
                    ...init,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                        ...(init.headers ?? {}),
                    },
                });
            }
            catch (error) {
                const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
                throw new Error(`Cannot reach HubSpot at ${baseUrl}${cause}. Check network access.`);
            }
            const retryable = response.status === 429 || response.status >= 500;
            if (!retryable || attempt === maxRetries)
                break;
            await response.text().catch(() => undefined);
            const retryAfter = response.headers.get("Retry-After");
            const seconds = retryAfter === null ? NaN : Number(retryAfter);
            const dateDelay = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) - Date.now() : NaN;
            const delayMs = Math.min(30_000, Math.max(0, Number.isFinite(seconds) ? seconds * 1_000 : Number.isFinite(dateDelay) ? dateDelay : 1_000 * 2 ** attempt));
            const reason = response.status === 429 ? "rate limited" : `temporarily unavailable (${response.status})`;
            options.progress?.note(`HubSpot ${reason}; retrying in ${Math.ceil(delayMs / 1_000)}s (${attempt + 1}/${maxRetries})`);
            await sleep(delayMs);
        }
        if (!response || !response.ok) {
            // Status line only — HubSpot 4xx bodies echo submitted property values
            // (contact emails, company domains) and the request payload, and these
            // errors are persisted into scheduled-run records. Never interpolate it.
            await response?.text().catch(() => undefined);
            if (response?.status === 429) {
                throw new Error(`HubSpot rate limit (429) persisted after ${maxRetries} retries. Wait for the portal limit to reset, then retry; no CRM writes were made.`);
            }
            throw new Error(`HubSpot API error ${response?.status ?? "unknown"}. Check the token scopes and request.`);
        }
        // DELETE and some association writes return 204 with an empty body.
        const text = await response.text();
        return text ? JSON.parse(text) : null;
    }
    /**
     * Map every deal stage id → its actual closed/won semantics, read from the
     * pipeline definitions. Custom pipelines use opaque stage ids (e.g.
     * "1234567"), so deriving closed/won by substring-matching the stage value
     * against "closedwon"/"closedlost" mis-reads every custom-pipeline deal as
     * open. The pipeline's own stage metadata is authoritative: `isClosed` marks
     * a closed stage and `probability` 1.0 = won, 0.0 = lost. Best-effort — if
     * the read is unavailable (e.g. missing scope) callers fall back to the
     * substring heuristic so a partial-scope token still produces a snapshot.
     */
    async function fetchDealStageClose() {
        const map = new Map();
        try {
            const data = await request("/crm/v3/pipelines/deals");
            for (const pipeline of data?.results ?? []) {
                for (const stage of pipeline?.stages ?? []) {
                    if (!stage?.id)
                        continue;
                    const meta = stage.metadata ?? {};
                    const isClosed = String(meta.isClosed).toLowerCase() === "true";
                    const isWon = isClosed && Number(meta.probability) === 1;
                    map.set(String(stage.id), { isClosed, isWon });
                }
            }
        }
        catch {
            // Pipeline metadata unavailable — leave the map empty; the caller falls
            // back to the substring heuristic.
        }
        return map;
    }
    async function list(path, onPage) {
        const results = [];
        let after;
        const seen = new Set();
        do {
            // Guard against a provider returning a repeating cursor (would loop
            // forever): stop if the same `after` is handed back twice.
            if (after) {
                if (seen.has(after))
                    break;
                seen.add(after);
            }
            const separator = path.includes("?") ? "&" : "?";
            const data = await request(`${path}${after ? `${separator}after=${encodeURIComponent(after)}` : ""}`);
            results.push(...(data.results ?? []));
            try {
                onPage?.(results.length);
            }
            catch {
                // progress is presentation-only; never let it fail a pull
            }
            after = data.paging?.next?.after;
        } while (after);
        return results;
    }
    async function assembleSnapshot(fetchObjects) {
        const owners = await list("/crm/v3/owners?limit=100", (fetched) => pullProgress("user", fetched));
        const users = owners
            .filter((owner) => owner.id)
            .map((owner) => ({
            id: String(owner.id),
            provider: "hubspot",
            crmId: String(owner.id),
            identities: [{ provider: "hubspot", externalId: String(owner.id) }],
            name: [owner.firstName, owner.lastName].filter(Boolean).join(" ") ||
                stringOrFallback(owner.email, `Owner ${owner.id}`),
            email: stringOrUndefined(owner.email),
            active: owner.archived !== true,
        }));
        // Read-only record-source fields power duplicate-finding attribution
        // ("all five created by integration X") — see RecordProvenance.
        const PROVENANCE_PROPERTIES = "hs_object_source,hs_object_source_label,hs_object_source_id";
        const companyProperties = `${mappedFields(mappings, "accounts", HUBSPOT_DEFAULT_FIELD_MAPPINGS.accounts).join(",")},${PROVENANCE_PROPERTIES}`;
        const companies = await fetchObjects("companies", companyProperties, false);
        const accounts = companies
            .filter((company) => company.id)
            .map((company) => {
            const props = company.properties ?? {};
            return {
                id: String(company.id),
                provider: "hubspot",
                crmId: String(company.id),
                identities: [{ provider: "hubspot", externalId: String(company.id) }],
                name: stringOrFallback(readMapped(props, "accounts", "name", "name"), "Unknown Company"),
                domain: stringOrUndefined(readMapped(props, "accounts", "domain", "domain")),
                parentAccountId: stringOrUndefined(readMapped(props, "accounts", "parentAccountId", "hs_parent_company_id")),
                industry: stringOrUndefined(readMapped(props, "accounts", "industry", "industry")),
                employeeCount: numberOrUndefined(readMapped(props, "accounts", "employeeCount", "numberofemployees")),
                annualRevenue: numberOrUndefined(readMapped(props, "accounts", "annualRevenue", "annualrevenue")),
                ownerId: stringOrUndefined(readMapped(props, "accounts", "ownerId", "hubspot_owner_id")),
                provenance: provenanceFrom(props),
                lastSyncAt: stringOrUndefined(company.updatedAt),
                raw: company,
            };
        });
        const contactProperties = `${mappedFields(mappings, "contacts", HUBSPOT_DEFAULT_FIELD_MAPPINGS.contacts).join(",")},${PROVENANCE_PROPERTIES}`;
        const hubspotContacts = await fetchObjects("contacts", contactProperties, true);
        const contacts = hubspotContacts
            .filter((contact) => contact.id)
            .map((contact) => {
            const props = contact.properties ?? {};
            const companyId = contact.associations?.companies?.results?.[0]?.id;
            return {
                id: String(contact.id),
                provider: "hubspot",
                crmId: String(contact.id),
                identities: [{ provider: "hubspot", externalId: String(contact.id) }],
                accountId: companyId ? String(companyId) : undefined,
                firstName: stringOrUndefined(readMapped(props, "contacts", "firstName", "firstname")),
                lastName: stringOrUndefined(readMapped(props, "contacts", "lastName", "lastname")),
                email: stringOrUndefined(readMapped(props, "contacts", "email", "email")),
                phone: stringOrUndefined(readMapped(props, "contacts", "phone", "phone")),
                title: stringOrUndefined(readMapped(props, "contacts", "title", "jobtitle")),
                linkedin: stringOrUndefined(readMapped(props, "contacts", "linkedin", "hs_linkedin_url")),
                ownerId: stringOrUndefined(readMapped(props, "contacts", "ownerId", "hubspot_owner_id")),
                provenance: provenanceFrom(props),
                lastSyncAt: stringOrUndefined(contact.updatedAt),
                raw: contact,
            };
        });
        const dealProperties = `${mappedFields(mappings, "deals", HUBSPOT_DEFAULT_FIELD_MAPPINGS.deals).join(",")},${PROVENANCE_PROPERTIES}`;
        const stageClose = await fetchDealStageClose();
        const hubspotDeals = await fetchObjects("deals", dealProperties, true);
        const deals = hubspotDeals
            .filter((deal) => deal.id)
            .map((deal) => {
            const props = deal.properties ?? {};
            const companyId = deal.associations?.companies?.results?.[0]?.id;
            const stage = stringOrUndefined(readMapped(props, "deals", "stage", "dealstage"));
            const normalizedStage = (stage ?? "").toLowerCase();
            // Prefer the pipeline stage's actual closed/won metadata; fall back to
            // the substring heuristic only when the stage isn't in the pipeline map
            // (pipelines unreadable, or a deal on a deleted stage).
            const stageMeta = stage ? stageClose.get(stage) : undefined;
            const isWon = stageMeta ? stageMeta.isWon : normalizedStage.includes("closedwon");
            const isClosed = stageMeta
                ? stageMeta.isClosed
                : isWon || normalizedStage.includes("closedlost");
            const forecastCategory = isWon ? "closed_won" : isClosed ? "closed_lost" : "pipeline";
            const lastActivityAt = stringOrUndefined(readMapped(props, "deals", "lastActivityAt", "hs_last_sales_activity_timestamp"));
            return {
                id: String(deal.id),
                provider: "hubspot",
                crmId: String(deal.id),
                identities: [{ provider: "hubspot", externalId: String(deal.id) }],
                accountId: companyId ? String(companyId) : undefined,
                ownerId: stringOrUndefined(readMapped(props, "deals", "ownerId", "hubspot_owner_id")),
                provenance: provenanceFrom(props),
                name: stringOrFallback(readMapped(props, "deals", "name", "dealname"), "Untitled Deal"),
                amount: numberOrUndefined(readMapped(props, "deals", "amount", "amount")),
                stage,
                closeDate: stringOrUndefined(readMapped(props, "deals", "closeDate", "closedate"))?.split("T")[0],
                dealType: stringOrUndefined(readMapped(props, "deals", "dealType", "dealtype")),
                // hs_deal_stage_probability is already a 0..1 fraction in HubSpot,
                // so it maps straight to the canonical 0..1 unit (no /100, unlike
                // Salesforce's 0..100 Probability field).
                probability: numberOrUndefined(readMapped(props, "deals", "probability", "hs_deal_stage_probability")),
                forecastCategory,
                isClosed,
                isWon,
                // hs_last_sales_activity_timestamp is an ISO timestamp; keep the
                // date portion when it looks like one, otherwise pass through (e.g.
                // an epoch-millis string).
                lastActivityAt: lastActivityAt?.includes("T")
                    ? lastActivityAt.split("T")[0]
                    : lastActivityAt,
                lastSyncAt: stringOrUndefined(deal.updatedAt),
                raw: deal,
            };
        });
        // Deliver any throttled trailing items heartbeat before the pull returns.
        options.progress?.flush();
        return {
            generatedAt: new Date().toISOString(),
            provider: "hubspot",
            users,
            accounts,
            contacts,
            deals,
            // Engagement reads need additional scopes; activity staleness falls back
            // to record sync timestamps until engagements are supported.
            activities: [],
        };
    }
    async function fetchSnapshot() {
        const canonicalType = { companies: "account", contacts: "contact", deals: "deal" };
        return assembleSnapshot((objectType, properties, withAssociations) => list(`/crm/v3/objects/${objectType}?limit=100&properties=${properties}${withAssociations ? "&associations=companies" : ""}`, (fetched) => pullProgress(canonicalType[objectType], fetched)));
    }
    const MODIFIED_DATE_PROPERTIES = {
        companies: "hs_lastmodifieddate",
        contacts: "lastmodifieddate",
        deals: "hs_lastmodifieddate",
    };
    async function searchList(objectType, properties, sinceMs) {
        const results = [];
        let after;
        // HubSpot's search API hard-caps at 10,000 results (100 pages of 100) and
        // 400s past it. Stop at the boundary rather than throwing mid-sync; an
        // incremental window this large should fall back to a full snapshot.
        const MAX_PAGES = 100;
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const data = await request(`/crm/v3/objects/${objectType}/search`, {
                method: "POST",
                body: JSON.stringify({
                    filterGroups: [
                        {
                            filters: [
                                {
                                    propertyName: MODIFIED_DATE_PROPERTIES[objectType],
                                    operator: "GTE",
                                    value: String(sinceMs),
                                },
                            ],
                        },
                    ],
                    properties: properties.split(","),
                    limit: 100,
                    ...(after ? { after } : {}),
                }),
            });
            results.push(...(data.results ?? []));
            const next = data.paging?.next?.after;
            if (!next || next === after)
                break;
            after = next;
        }
        return results;
    }
    /**
     * Records modified since `sinceIso`, via the CRM search API. HubSpot search
     * results carry no associations, so contact/deal accountIds are absent in
     * change feeds — consumers merging deltas must preserve associations from
     * the last full snapshot.
     */
    async function fetchChanges(sinceIso) {
        const sinceMs = Date.parse(sinceIso);
        if (!Number.isFinite(sinceMs))
            throw new Error(`Invalid since timestamp: ${sinceIso}`);
        return assembleSnapshot((objectType, properties) => searchList(objectType, properties, sinceMs));
    }
    // HubSpot-defined association type ids from a task engagement to its parent.
    const TASK_ASSOCIATION_TYPE_IDS = {
        contact: 204,
        account: 192,
        deal: 216,
    };
    function humanizeField(field) {
        return field
            .replace(/_task$/, "")
            .replace(/[_-]+/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase())
            .trim();
    }
    async function setField(operation) {
        const objectPath = OBJECT_PATHS[operation.objectType];
        const mappingType = MAPPING_OBJECT_TYPES[operation.objectType];
        if (!objectPath || !mappingType || !operation.field) {
            return {
                operationId: operation.id,
                status: "skipped",
                detail: "Field writes are only supported for accounts, contacts, and deals with an explicit field.",
            };
        }
        const defaults = HUBSPOT_DEFAULT_FIELD_MAPPINGS[mappingType] ?? {};
        const property = mappedField(mappings, mappingType, operation.field, defaults[operation.field] ?? operation.field);
        const value = operation.operation === "clear_field" ? "" : String(operation.afterValue ?? "");
        const response = await request(`/crm/v3/objects/${objectPath}/${encodeURIComponent(operation.objectId)}`, { method: "PATCH", body: JSON.stringify({ properties: { [property]: value } }) });
        return {
            operationId: operation.id,
            status: "applied",
            detail: `Set ${property} on ${objectPath}/${operation.objectId}.`,
            providerData: { id: response?.id, property },
        };
    }
    async function linkRecord(operation) {
        if (operation.objectType === "account" && operation.field === "parentAccountId") {
            const parentId = String(operation.afterValue ?? "");
            if (!parentId)
                return { operationId: operation.id, status: "skipped", detail: "A parent link needs a target company id." };
            // HubSpot-defined association type 14 is child → parent company. The
            // inverse relationship is maintained by HubSpot; no second write needed.
            await request(`/crm/v4/objects/companies/${encodeURIComponent(operation.objectId)}/associations/companies/${encodeURIComponent(parentId)}`, {
                method: "PUT",
                body: JSON.stringify([{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 14 }]),
            });
            return {
                operationId: operation.id,
                status: "applied",
                detail: `Linked companies/${operation.objectId} to parent company ${parentId}.`,
                providerData: { parentAccountId: parentId, associationTypeId: 14 },
            };
        }
        // Associate a deal or contact with a company (the only link the built-in
        // rules emit — missing-deal-account). afterValue is the target company id.
        const fromPath = OBJECT_PATHS[operation.objectType];
        if ((operation.objectType !== "deal" && operation.objectType !== "contact") || !fromPath) {
            return {
                operationId: operation.id,
                status: "skipped",
                detail: "link_record is supported for account parent links and for deals or contacts linked to a company.",
            };
        }
        let companyId = String(operation.afterValue ?? "");
        if (!companyId) {
            return { operationId: operation.id, status: "skipped", detail: "link_record needs a target company id." };
        }
        // `create:<Name>` is resolve-first: link to an existing company when one
        // unambiguously matches, refuse on ambiguity, create only on a confirmed
        // miss — and never create the same name twice within one apply run
        // (HubSpot's search API is eventually consistent, so a just-created
        // record is invisible to search for several seconds).
        let createdCompanyName = null;
        let resolvedExisting = false;
        if (companyId.startsWith("create:")) {
            const name = companyId.slice("create:".length).trim();
            if (!name) {
                return { operationId: operation.id, status: "skipped", detail: "create: needs a company name (create:<Name>)." };
            }
            const nameKey = name.toLowerCase();
            const alreadyCreated = createdCompaniesByName.get(nameKey);
            if (alreadyCreated) {
                companyId = alreadyCreated;
                resolvedExisting = true;
            }
            else {
                const matches = await searchCompaniesByName(name);
                if (matches.length > 1) {
                    return {
                        operationId: operation.id,
                        status: "skipped",
                        detail: `create:${name} is ambiguous — ${matches.length} companies already named "${name}" (ids ${matches.join(", ")}). Link an explicit company id instead.`,
                    };
                }
                if (matches.length === 1) {
                    companyId = matches[0];
                    resolvedExisting = true;
                    createdCompaniesByName.set(nameKey, companyId);
                }
                else {
                    let created;
                    try {
                        created = await request(`/crm/v3/objects/companies`, {
                            method: "POST",
                            body: JSON.stringify({
                                properties: { name, hs_object_source_detail_2: `fullstackgtm create: (${operation.id})` },
                            }),
                        });
                    }
                    catch {
                        // Some portals reject writes to source-detail properties — the
                        // provenance stamp is best-effort, the create is not.
                        created = await request(`/crm/v3/objects/companies`, {
                            method: "POST",
                            body: JSON.stringify({ properties: { name } }),
                        });
                    }
                    companyId = String(created.id);
                    createdCompanyName = name;
                    createdCompaniesByName.set(nameKey, companyId);
                }
            }
        }
        await request(`/crm/v4/objects/${fromPath}/${encodeURIComponent(operation.objectId)}/associations/default/companies/${encodeURIComponent(companyId)}`, { method: "PUT" });
        return {
            operationId: operation.id,
            status: "applied",
            detail: createdCompanyName
                ? `Created company "${createdCompanyName}" (${companyId}) and linked ${fromPath}/${operation.objectId} to it.`
                : resolvedExisting
                    ? `Linked ${fromPath}/${operation.objectId} to existing company ${companyId} (resolved by name, nothing created).`
                    : `Linked ${fromPath}/${operation.objectId} to company ${companyId}.`,
            providerData: { companyId, ...(createdCompanyName ? { createdCompany: true } : {}) },
        };
    }
    /** Exact-value company lookup (by `name` or `domain`) for resolve-first creates. */
    async function searchCompaniesBy(property, value) {
        const data = await request(`/crm/v3/objects/companies/search`, {
            method: "POST",
            body: JSON.stringify({
                filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }],
                properties: [property],
                limit: 3,
            }),
        });
        return (data?.results ?? []).map((row) => String(row.id));
    }
    const searchCompaniesByName = (name) => searchCompaniesBy("name", name);
    /** Stamp `domain` on a company only when it has none (fill-blank, never clobber). */
    async function fillCompanyDomainIfEmpty(companyId, domain) {
        try {
            const data = await request(`/crm/v3/objects/companies/${encodeURIComponent(companyId)}?properties=domain`);
            const current = data?.properties?.domain;
            if (typeof current === "string" && current.trim())
                return; // already has one — leave it
            await request(`/crm/v3/objects/companies/${encodeURIComponent(companyId)}`, {
                method: "PATCH",
                body: JSON.stringify({ properties: { domain } }),
            });
        }
        catch {
            // Best-effort: a failed domain fill must not sink the contact create.
        }
    }
    /** Exact-value contact lookup (by any searchable property) for resolve-first creates. */
    async function searchContactsBy(property, value) {
        const data = await request(`/crm/v3/objects/contacts/search`, {
            method: "POST",
            body: JSON.stringify({
                filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }],
                properties: [property],
                limit: 3,
            }),
        });
        return (data?.results ?? []).map((row) => String(row.id));
    }
    /**
     * Resolve a company to a real account record, creating it on a confirmed miss.
     * Matches by DOMAIN first (the accurate key) and falls back to exact name;
     * creates with the domain stamped, and fills the domain on a name-matched
     * account that lacks one — so the account is signal-watchable. Returns null on
     * ambiguity (≥2 matches) so the caller skips the association rather than
     * guessing. Same-run safe via createdCompaniesByName.
     */
    async function resolveOrCreateCompany(name, domain, opId) {
        const cacheKey = domain ? `d:${domain.toLowerCase()}` : `n:${name.toLowerCase()}`;
        const already = createdCompaniesByName.get(cacheKey);
        if (already)
            return already;
        // 1. Domain-first match (accurate; an account matched here already has it).
        if (domain) {
            const byDomain = await searchCompaniesBy("domain", domain);
            if (byDomain.length > 1)
                return null;
            if (byDomain.length === 1) {
                createdCompaniesByName.set(cacheKey, byDomain[0]);
                return byDomain[0];
            }
        }
        // 2. Exact-name match; stamp the domain if the account has none.
        const byName = await searchCompaniesByName(name);
        if (byName.length > 1)
            return null;
        if (byName.length === 1) {
            if (domain)
                await fillCompanyDomainIfEmpty(byName[0], domain);
            createdCompaniesByName.set(cacheKey, byName[0]);
            return byName[0];
        }
        // 3. Create with name + domain (provenance is best-effort).
        const props = { name, ...(domain ? { domain } : {}) };
        let created;
        try {
            created = await request(`/crm/v3/objects/companies`, {
                method: "POST",
                body: JSON.stringify({ properties: { ...props, hs_object_source_detail_2: `fullstackgtm acquire (${opId})` } }),
            });
        }
        catch {
            created = await request(`/crm/v3/objects/companies`, {
                method: "POST",
                body: JSON.stringify({ properties: props }),
            });
        }
        const id = String(created.id);
        createdCompaniesByName.set(cacheKey, id);
        return id;
    }
    /** Exact-value deal lookup (by any searchable property) for resolve-first creates. */
    async function searchDealsBy(property, value) {
        const data = await request(`/crm/v3/objects/deals/search`, {
            method: "POST",
            body: JSON.stringify({
                filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }],
                properties: [property],
                limit: 3,
            }),
        });
        return (data?.results ?? []).map((row) => String(row.id));
    }
    /**
     * Make sure the deal dedupe property (e.g. "stripe_invoice_id") exists so
     * both the resolve-first search and the stamped value are real. Best-effort
     * create on a confirmed miss; returns false when the property can neither
     * be read nor created — the caller must SKIP then (creating a deal without
     * its dedupe key would make every replay a duplicate).
     */
    async function ensureDealProperty(name) {
        const cached = ensuredDealProperties.get(name);
        if (cached !== undefined)
            return cached;
        let ok;
        try {
            await request(`/crm/v3/properties/deals/${encodeURIComponent(name)}`);
            ok = true;
        }
        catch {
            // Missing (404) or unreadable — try to create it; a failure here means
            // we cannot guarantee the dedupe key, so report false.
            try {
                await request(`/crm/v3/properties/deals`, {
                    method: "POST",
                    body: JSON.stringify({
                        name,
                        label: name,
                        type: "string",
                        fieldType: "text",
                        groupName: "dealinformation",
                        hasUniqueValue: false,
                    }),
                });
                ok = true;
            }
            catch {
                ok = false;
            }
        }
        ensuredDealProperties.set(name, ok);
        return ok;
    }
    /**
     * Resolve the target pipeline and its closed-won stage from the portal's
     * own pipeline metadata (one read per run). The pipeline is picked by id or
     * case-insensitive label (`hint`), else the default (lowest displayOrder);
     * the closed-won stage is the one whose metadata says isClosed with
     * probability 1 — NEVER a substring guess against stage names. Returns null
     * when either is unresolvable so the caller skips instead of guessing.
     */
    async function resolveClosedWonStage(hint) {
        if (!dealPipelinesCache) {
            dealPipelinesCache = request("/crm/v3/pipelines/deals").then((data) => (data?.results ?? []));
            // A failed read must not poison the cache for the rest of the run.
            dealPipelinesCache = dealPipelinesCache.catch(() => []);
        }
        const pipelines = await dealPipelinesCache;
        if (pipelines.length === 0)
            return null;
        let pipeline;
        if (hint) {
            const wanted = hint.trim().toLowerCase();
            pipeline = pipelines.find((candidate) => String(candidate?.id ?? "").toLowerCase() === wanted ||
                String(candidate?.label ?? "").trim().toLowerCase() === wanted);
            if (!pipeline)
                return null; // an explicit hint that matches nothing is an error, not "use default"
        }
        else {
            pipeline = [...pipelines].sort((a, b) => Number(a?.displayOrder ?? 0) - Number(b?.displayOrder ?? 0))[0];
        }
        if (!pipeline?.id)
            return null;
        const stage = (pipeline.stages ?? []).find((candidate) => {
            const meta = candidate?.metadata ?? {};
            return (candidate?.id &&
                String(meta.isClosed).toLowerCase() === "true" &&
                Number(meta.probability) === 1);
        });
        if (!stage)
            return null;
        return { pipelineId: String(pipeline.id), stageId: String(stage.id) };
    }
    /**
     * Deal branch of create_record (backfill: one closed-won deal per paid
     * invoice). Resolve-first on the custom dedupe property (ensured to exist
     * first), stage resolved from pipeline metadata, company association
     * best-effort — same contract as the contact branch.
     */
    async function createDealRecord(operation, payload, matchValue) {
        const matchKey = String(payload.matchKey ?? "").trim();
        if (!matchKey) {
            return { operationId: operation.id, status: "skipped", detail: "create_record for deals needs a matchKey (the dedupe property, e.g. stripe_invoice_id)." };
        }
        const dedupeKey = `${matchKey}:${matchValue.toLowerCase()}`;
        const alreadyCreated = createdDealsByMatch.get(dedupeKey);
        if (alreadyCreated) {
            return { operationId: operation.id, status: "skipped", detail: `Deal ${matchKey}=${matchValue} already created earlier in this run; not duplicating.`, providerData: { id: alreadyCreated, existing: true } };
        }
        // The dedupe property is usually CUSTOM — ensure it exists before the
        // search; searching a property HubSpot doesn't have 400s, and creating a
        // deal without the key stamped would defeat every future resolve-first.
        const propertyOk = await ensureDealProperty(matchKey);
        if (!propertyOk) {
            return { operationId: operation.id, status: "skipped", detail: `Deal dedupe property "${matchKey}" does not exist and could not be created; refusing to create a deal without its dedupe key.` };
        }
        const existing = await searchDealsBy(matchKey, matchValue);
        if (existing.length > 0) {
            createdDealsByMatch.set(dedupeKey, existing[0]);
            return { operationId: operation.id, status: "skipped", detail: `Deal ${matchKey}=${matchValue} already exists (${existing.join(", ")}); resolve-first declined to create.`, providerData: { id: existing[0], existing: true } };
        }
        // Stage: only the provider-neutral "closed_won" sentinel is understood,
        // and it must resolve to a real stage id from pipeline metadata.
        if (payload.dealStage !== "closed_won") {
            return { operationId: operation.id, status: "skipped", detail: 'create_record for deals needs dealStage "closed_won" (the connector resolves the real stage id from pipeline metadata).' };
        }
        const resolved = await resolveClosedWonStage(payload.dealPipeline);
        if (!resolved) {
            return {
                operationId: operation.id,
                status: "skipped",
                detail: payload.dealPipeline
                    ? `Could not resolve pipeline "${payload.dealPipeline}" (by id or label) to a closed-won stage; not guessing a stage.`
                    : "Could not resolve the default deal pipeline's closed-won stage (isClosed + probability 1) from pipeline metadata; not guessing a stage.",
            };
        }
        const properties = {
            ...payload.properties,
            [matchKey]: matchValue,
            pipeline: resolved.pipelineId,
            dealstage: resolved.stageId,
        };
        if (payload.ownerId && !properties.hubspot_owner_id) {
            properties.hubspot_owner_id = String(payload.ownerId);
        }
        let created;
        try {
            created = await request(`/crm/v3/objects/deals`, {
                method: "POST",
                body: JSON.stringify({ properties: { ...properties, hs_object_source_detail_2: `fullstackgtm backfill (${operation.id})` } }),
            });
        }
        catch {
            // Some portals reject writes to source-detail properties — the provenance
            // stamp is best-effort, the create is not.
            created = await request(`/crm/v3/objects/deals`, {
                method: "POST",
                body: JSON.stringify({ properties }),
            });
        }
        const dealId = String(created.id);
        createdDealsByMatch.set(dedupeKey, dealId);
        let companyNote = "";
        if (payload.associateCompanyName) {
            try {
                const companyId = await resolveOrCreateCompany(payload.associateCompanyName, payload.associateCompanyDomain, operation.id);
                if (companyId) {
                    await request(`/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/default/companies/${encodeURIComponent(companyId)}`, { method: "PUT" });
                    const domainNote = payload.associateCompanyDomain ? ` (${payload.associateCompanyDomain})` : "";
                    companyNote = ` Linked to company "${payload.associateCompanyName}"${domainNote} (${companyId}).`;
                }
                else {
                    companyNote = ` Company "${payload.associateCompanyName}" was ambiguous; left unlinked.`;
                }
            }
            catch (error) {
                // Association is best-effort — the deal create already succeeded.
                companyNote = ` (company link failed: ${error instanceof Error ? error.message : String(error)})`;
            }
        }
        return {
            operationId: operation.id,
            status: "applied",
            detail: `Created deal ${matchKey}=${matchValue} (${dealId}) in stage ${resolved.stageId}.${companyNote}`,
            providerData: { id: dealId, created: true, pipelineId: resolved.pipelineId, stageId: resolved.stageId },
        };
    }
    /**
     * Create a NET-NEW record (a sourced lead, or a backfilled deal).
     * Resolve-first: re-checks the dedupe key against the live CRM (the
     * plan-time snapshot can be stale) and creates ONLY on a confirmed miss — a
     * record a concurrent writer already added is returned as `skipped`, never
     * duplicated. Contacts and deals can be linked to a resolved-or-created
     * company in the same step.
     */
    async function createRecord(operation) {
        const payload = operation.afterValue;
        if (!payload || typeof payload !== "object" || !payload.properties) {
            return { operationId: operation.id, status: "skipped", detail: "create_record needs a CreateRecordPayload afterValue." };
        }
        const objectPath = OBJECT_PATHS[operation.objectType];
        if (operation.objectType !== "contact" && operation.objectType !== "account" && operation.objectType !== "deal") {
            return { operationId: operation.id, status: "skipped", detail: "create_record supports contacts, accounts, and deals." };
        }
        const matchValue = String(payload.matchValue ?? "").trim();
        if (!matchValue) {
            return { operationId: operation.id, status: "skipped", detail: "create_record needs a non-empty matchValue to resolve-first." };
        }
        if (operation.objectType === "deal") {
            return createDealRecord(operation, payload, matchValue);
        }
        if (operation.objectType === "account") {
            const id = await resolveOrCreateCompany(matchValue, stringOrUndefined(payload.properties?.domain), operation.id);
            if (id === null) {
                return { operationId: operation.id, status: "skipped", detail: `create_record: ambiguous — multiple companies named "${matchValue}". Not creating.` };
            }
            return { operationId: operation.id, status: "applied", detail: `Resolved/created company "${matchValue}" (${id}).`, providerData: { id } };
        }
        // contact — resolve-first on the dedupe key (email by default). The match
        // key is canonical (e.g. "linkedin"); translate it to the HubSpot property
        // name ("hs_linkedin_url") before searching — HubSpot 400s on a filter
        // against a property it doesn't have (there is no property named "linkedin").
        const matchKey = payload.matchKey || "email";
        const searchProperty = HUBSPOT_DEFAULT_FIELD_MAPPINGS.contacts[matchKey] ?? matchKey;
        const matchKeyLower = `${matchKey}:${matchValue.toLowerCase()}`;
        if (createdContactsByMatch.has(matchKeyLower)) {
            return { operationId: operation.id, status: "skipped", detail: `Contact ${matchKey}=${matchValue} already created earlier in this run; not duplicating.`, providerData: { id: createdContactsByMatch.get(matchKeyLower), existing: true } };
        }
        const existing = await searchContactsBy(searchProperty, matchValue);
        if (existing.length > 0) {
            createdContactsByMatch.set(matchKeyLower, existing[0]);
            return { operationId: operation.id, status: "skipped", detail: `Contact ${matchKey}=${matchValue} already exists (${existing.join(", ")}); resolve-first declined to create.`, providerData: { id: existing[0], existing: true } };
        }
        const properties = { ...payload.properties };
        // Stamp ownership at create time so the lead is never born ownerless. The
        // canonical ownerId maps to HubSpot's standard owner property.
        if (payload.ownerId && !properties.hubspot_owner_id) {
            properties.hubspot_owner_id = String(payload.ownerId);
        }
        let created;
        try {
            created = await request(`/crm/v3/objects/${objectPath}`, {
                method: "POST",
                body: JSON.stringify({ properties: { ...properties, hs_object_source_detail_2: `fullstackgtm acquire (${operation.id})` } }),
            });
        }
        catch {
            // Some portals reject writes to source-detail properties — the provenance
            // stamp is best-effort, the create is not.
            created = await request(`/crm/v3/objects/${objectPath}`, {
                method: "POST",
                body: JSON.stringify({ properties }),
            });
        }
        const contactId = String(created.id);
        createdContactsByMatch.set(matchKeyLower, contactId);
        let companyNote = "";
        if (payload.associateCompanyName) {
            try {
                const companyId = await resolveOrCreateCompany(payload.associateCompanyName, payload.associateCompanyDomain, operation.id);
                if (companyId) {
                    await request(`/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/default/companies/${encodeURIComponent(companyId)}`, { method: "PUT" });
                    const domainNote = payload.associateCompanyDomain ? ` (${payload.associateCompanyDomain})` : "";
                    companyNote = ` Linked to company "${payload.associateCompanyName}"${domainNote} (${companyId}).`;
                }
                else {
                    companyNote = ` Company "${payload.associateCompanyName}" was ambiguous; left unlinked.`;
                }
            }
            catch (error) {
                // Association is best-effort — the contact create already succeeded.
                companyNote = ` (company link failed: ${error instanceof Error ? error.message : String(error)})`;
            }
        }
        return {
            operationId: operation.id,
            status: "applied",
            detail: `Created contact ${matchKey}=${matchValue} (${contactId}).${companyNote}`,
            providerData: { id: contactId, created: true },
        };
    }
    /** Bulk resolve-first lookup: which match values already exist (value→id). */
    async function searchContactsByValues(property, values) {
        const found = new Map();
        for (let i = 0; i < values.length; i += 100) {
            const chunk = values.slice(i, i + 100);
            const data = await request(`/crm/v3/objects/contacts/search`, {
                method: "POST",
                body: JSON.stringify({
                    filterGroups: [{ filters: [{ propertyName: property, operator: "IN", values: chunk }] }],
                    properties: [property],
                    limit: 100,
                }),
            });
            for (const rec of (data?.results ?? [])) {
                const v = rec?.properties?.[property];
                if (typeof v === "string" && rec.id)
                    found.set(v.toLowerCase(), String(rec.id));
            }
        }
        return found;
    }
    /**
     * Batch create_record for contacts: bulk resolve-first (search IN), then
     * bulk-create the genuine misses (batch/create, 100/call) — two API calls per
     * ~100 leads instead of two per lead. On a batch-create rejection (e.g. an
     * email collision HubSpot 409s the whole batch over), it falls back to
     * per-record createRecord for that chunk, so one bad row never sinks the rest
     * and resolve-first is preserved. Returns one result per input op.
     */
    async function applyCreateContactsBatch(operations) {
        const byId = new Map();
        // Group by the HubSpot search property (matchKey is usually uniform across a
        // plan, but a mixed plan stays correct this way).
        const groups = new Map();
        for (const op of operations) {
            const matchKey = op.afterValue?.matchKey || "email";
            const searchProperty = HUBSPOT_DEFAULT_FIELD_MAPPINGS.contacts[matchKey] ?? matchKey;
            let arr = groups.get(searchProperty);
            if (!arr)
                groups.set(searchProperty, (arr = []));
            arr.push(op);
        }
        for (const [searchProperty, ops] of groups) {
            const wanted = ops
                .map((op) => String(op.afterValue.matchValue ?? "").trim())
                .filter(Boolean);
            const existing = await searchContactsByValues(searchProperty, [...new Set(wanted.map((v) => v.toLowerCase()))]);
            const toCreate = [];
            const seenInBatch = new Set();
            for (const op of ops) {
                const payload = op.afterValue;
                const matchKey = payload.matchKey || "email";
                const matchValue = String(payload.matchValue ?? "").trim();
                if (!matchValue) {
                    byId.set(op.id, { operationId: op.id, status: "skipped", detail: "create_record needs a non-empty matchValue to resolve-first." });
                    continue;
                }
                const lower = matchValue.toLowerCase();
                const dedupeKey = `${matchKey}:${lower}`;
                const already = createdContactsByMatch.get(dedupeKey);
                if (already) {
                    byId.set(op.id, { operationId: op.id, status: "skipped", detail: `Contact ${matchKey}=${matchValue} already created earlier in this run; not duplicating.`, providerData: { id: already, existing: true } });
                    continue;
                }
                const existingId = existing.get(lower);
                if (existingId) {
                    createdContactsByMatch.set(dedupeKey, existingId);
                    byId.set(op.id, { operationId: op.id, status: "skipped", detail: `Contact ${matchKey}=${matchValue} already exists (${existingId}); resolve-first declined to create.`, providerData: { id: existingId, existing: true } });
                    continue;
                }
                if (seenInBatch.has(lower)) {
                    byId.set(op.id, { operationId: op.id, status: "skipped", detail: `Contact ${matchKey}=${matchValue} duplicated within this batch; not duplicating.` });
                    continue;
                }
                seenInBatch.add(lower);
                toCreate.push(op);
            }
            for (let i = 0; i < toCreate.length; i += 100) {
                const chunk = toCreate.slice(i, i + 100);
                const inputs = chunk.map((op) => {
                    const payload = op.afterValue;
                    const properties = { ...payload.properties };
                    if (payload.ownerId && !properties.hubspot_owner_id)
                        properties.hubspot_owner_id = String(payload.ownerId);
                    properties.hs_object_source_detail_2 = `fullstackgtm acquire (${op.id})`;
                    return { properties };
                });
                try {
                    const data = await request(`/crm/v3/objects/contacts/batch/create`, {
                        method: "POST",
                        body: JSON.stringify({ inputs }),
                    });
                    const created = (data?.results ?? []);
                    const idByValue = new Map();
                    for (const rec of created) {
                        const v = rec?.properties?.[searchProperty];
                        if (typeof v === "string" && rec.id)
                            idByValue.set(v.toLowerCase(), String(rec.id));
                    }
                    for (const op of chunk) {
                        const payload = op.afterValue;
                        const matchKey = payload.matchKey || "email";
                        const matchValue = String(payload.matchValue).trim();
                        const id = idByValue.get(matchValue.toLowerCase());
                        if (id) {
                            createdContactsByMatch.set(`${matchKey}:${matchValue.toLowerCase()}`, id);
                            byId.set(op.id, { operationId: op.id, status: "applied", detail: `Created contact ${matchKey}=${matchValue} (${id}).`, providerData: { id, created: true } });
                        }
                        else {
                            // Result didn't echo this value — resolve it per-record to be safe.
                            byId.set(op.id, await createRecord(op));
                        }
                    }
                }
                catch {
                    // Whole-chunk rejection (e.g. a collision). Isolate per record.
                    for (const op of chunk)
                        byId.set(op.id, await createRecord(op));
                }
            }
        }
        return operations.map((op) => byId.get(op.id) ?? { operationId: op.id, status: "skipped", detail: "create_record was not processed." });
    }
    async function createTask(operation) {
        const associationTypeId = TASK_ASSOCIATION_TYPE_IDS[operation.objectType];
        if (associationTypeId === undefined) {
            return {
                operationId: operation.id,
                status: "skipped",
                detail: "Tasks can be attached to accounts, contacts, and deals.",
            };
        }
        const subject = operation.field ? humanizeField(operation.field) : "Follow up";
        // The operation id doubles as an idempotency token: it is stamped into
        // the task body and pre-checked so a replayed plan does not create the
        // same task twice. Fail-open — a search hiccup must not block the apply.
        const token = `fsgtm ${operation.id.replace(/^op_/, "")}`;
        try {
            const existing = await request(`/crm/v3/objects/tasks/search`, {
                method: "POST",
                body: JSON.stringify({
                    filterGroups: [
                        { filters: [{ propertyName: "hs_task_body", operator: "CONTAINS_TOKEN", value: token.split(" ")[1] }] },
                    ],
                    limit: 1,
                }),
            });
            const hit = (existing?.results ?? [])[0];
            if (hit?.id) {
                return {
                    operationId: operation.id,
                    status: "skipped",
                    detail: `Task for this operation already exists (task ${hit.id}); not creating a duplicate.`,
                    providerData: { id: hit.id, existing: true },
                };
            }
        }
        catch {
            // fall through to create
        }
        // A live CRM often already carries a human-created follow-up for the same
        // record (a previous partial run, or a rep's own task). Creating another
        // on top is duplicate noise — skip when the object already has an open
        // task, regardless of who created it. Fail-open: a lookup hiccup must
        // not block the apply.
        try {
            const objectPath = OBJECT_PATHS[operation.objectType];
            const assoc = await request(`/crm/v4/objects/${objectPath}/${encodeURIComponent(operation.objectId)}/associations/tasks?limit=20`);
            const taskIds = (assoc?.results ?? [])
                .map((row) => String(row.toObjectId ?? ""))
                .filter(Boolean)
                .slice(0, 10);
            for (const taskId of taskIds) {
                const existingTask = await request(`/crm/v3/objects/tasks/${encodeURIComponent(taskId)}?properties=hs_task_status`);
                const status = String(existingTask?.properties?.hs_task_status ?? "");
                if (status !== "COMPLETED" && status !== "DELETED") {
                    return {
                        operationId: operation.id,
                        status: "skipped",
                        detail: `An open task (task ${taskId}) already exists on ${operation.objectType}/${operation.objectId}; not creating a duplicate follow-up.`,
                        providerData: { id: taskId, existing: true },
                    };
                }
            }
        }
        catch {
            // fall through to create
        }
        const body = `${String(operation.afterValue ?? operation.reason ?? "")}\n\n[${token}]`;
        const response = await request(`/crm/v3/objects/tasks`, {
            method: "POST",
            body: JSON.stringify({
                properties: {
                    hs_task_subject: subject,
                    hs_task_body: body,
                    hs_task_status: "NOT_STARTED",
                    hs_task_priority: "MEDIUM",
                    hs_timestamp: Date.now(),
                },
                associations: [
                    {
                        to: { id: operation.objectId },
                        types: [
                            { associationCategory: "HUBSPOT_DEFINED", associationTypeId },
                        ],
                    },
                ],
            }),
        });
        return {
            operationId: operation.id,
            status: "applied",
            detail: `Created task "${subject}" on ${operation.objectType}/${operation.objectId}.`,
            providerData: { id: response?.id },
        };
    }
    async function archiveRecord(operation) {
        const objectPath = OBJECT_PATHS[operation.objectType];
        if (!objectPath) {
            return {
                operationId: operation.id,
                status: "skipped",
                detail: "archive_record is supported for accounts, contacts, and deals.",
            };
        }
        await request(`/crm/v3/objects/${objectPath}/${encodeURIComponent(operation.objectId)}`, {
            method: "DELETE",
        });
        return {
            operationId: operation.id,
            status: "applied",
            detail: `Archived ${objectPath}/${operation.objectId}.`,
        };
    }
    function fieldMapping(operation) {
        const objectPath = OBJECT_PATHS[operation.objectType];
        const mappingType = MAPPING_OBJECT_TYPES[operation.objectType];
        if (!objectPath || !mappingType || !operation.field)
            return null;
        const defaults = HUBSPOT_DEFAULT_FIELD_MAPPINGS[mappingType] ?? {};
        return { objectPath, property: mappedField(mappings, mappingType, operation.field, defaults[operation.field] ?? operation.field) };
    }
    function normalizeHubspotReadValue(field, value) {
        if (field === "closeDate" && typeof value === "string")
            return value.split("T")[0];
        return value ?? null;
    }
    function normalizeForComparison(value) {
        if (value === undefined || value === null || value === "")
            return null;
        return String(value);
    }
    function batchErrorIds(error) {
        const context = error?.context ?? {};
        const ids = context.ids ?? context.id ?? error?.id ?? error?.objectId;
        if (Array.isArray(ids))
            return ids.map(String);
        if (ids !== undefined && ids !== null)
            return [String(ids)];
        return [];
    }
    function batchErrorDetail(error) {
        const category = error?.category ? `${String(error.category)}: ` : "";
        return `${category}${String(error?.message ?? "HubSpot batch row failed.")}`;
    }
    async function applySetFieldBatch(operations) {
        const out = new Map();
        const mapped = operations.map((operation) => ({ operation, mapping: fieldMapping(operation) }));
        for (const item of mapped) {
            if (!item.mapping) {
                out.set(item.operation.id, {
                    operationId: item.operation.id,
                    status: "skipped",
                    detail: "Field writes are only supported for accounts, contacts, and deals with an explicit field.",
                });
            }
        }
        const clean = mapped.filter((item) => Boolean(item.mapping));
        if (clean.length === 0)
            return operations.map((operation) => out.get(operation.id));
        const objectPath = clean[0].mapping.objectPath;
        const properties = [...new Set(clean.map((item) => item.mapping.property))];
        const liveById = new Map();
        const ids = [...new Set(clean.map((item) => item.operation.objectId))];
        for (let i = 0; i < ids.length; i += 100) {
            const chunkIds = ids.slice(i, i + 100);
            const data = await request(`/crm/v3/objects/${objectPath}/batch/read`, {
                method: "POST",
                body: JSON.stringify({ properties, inputs: chunkIds.map((id) => ({ id })) }),
            });
            for (const row of data?.results ?? []) {
                if (row?.id)
                    liveById.set(String(row.id), row.properties ?? {});
            }
        }
        const toWrite = [];
        for (const { operation, mapping } of clean) {
            const props = liveById.get(operation.objectId);
            const current = normalizeHubspotReadValue(operation.field, props?.[mapping.property] ?? null);
            const expected = normalizeForComparison(operation.beforeValue);
            const found = normalizeForComparison(current);
            if (!props || expected !== found) {
                out.set(operation.id, {
                    operationId: operation.id,
                    status: "conflict",
                    detail: `Value drifted since the plan was proposed: expected ${expected ?? "∅"}, found ${found ?? "∅"}. Re-run the audit.`,
                    providerData: { currentValue: current ?? null },
                });
                continue;
            }
            toWrite.push({ operation, property: mapping.property });
        }
        for (let i = 0; i < toWrite.length; i += 100) {
            const chunk = toWrite.slice(i, i + 100);
            let data;
            try {
                data = await request(`/crm/v3/objects/${objectPath}/batch/update`, {
                    method: "POST",
                    body: JSON.stringify({
                        inputs: chunk.map(({ operation, property }) => ({
                            id: operation.objectId,
                            properties: { [property]: operation.operation === "clear_field" ? "" : String(operation.afterValue ?? "") },
                        })),
                    }),
                });
            }
            catch (error) {
                for (const { operation } of chunk)
                    out.set(operation.id, { operationId: operation.id, status: "failed", detail: error instanceof Error ? error.message : String(error) });
                continue;
            }
            const opByObjectId = new Map(chunk.map(({ operation }) => [operation.objectId, operation]));
            for (const error of data?.errors ?? []) {
                for (const id of batchErrorIds(error)) {
                    const operation = opByObjectId.get(id);
                    if (operation)
                        out.set(operation.id, { operationId: operation.id, status: "failed", detail: batchErrorDetail(error) });
                }
            }
            for (const result of data?.results ?? []) {
                const operation = opByObjectId.get(String(result?.id));
                if (operation && !out.has(operation.id))
                    out.set(operation.id, { operationId: operation.id, status: "applied", detail: `Set ${chunk.find((item) => item.operation.id === operation.id)?.property ?? "field"} on ${objectPath}/${operation.objectId}.`, providerData: { id: result?.id } });
            }
            for (const { operation, property } of chunk) {
                if (!out.has(operation.id))
                    out.set(operation.id, { operationId: operation.id, status: "applied", detail: `Set ${property} on ${objectPath}/${operation.objectId}.` });
            }
        }
        return operations.map((operation) => out.get(operation.id) ?? { operationId: operation.id, status: "failed", detail: "Batch update did not process this operation." });
    }
    async function applyArchiveBatch(operations) {
        const objectPath = OBJECT_PATHS[operations[0]?.objectType];
        if (!objectPath)
            return operations.map((operation) => ({ operationId: operation.id, status: "skipped", detail: "archive_record is supported for accounts, contacts, and deals." }));
        const out = new Map();
        for (let i = 0; i < operations.length; i += 100) {
            const chunk = operations.slice(i, i + 100);
            let data;
            try {
                data = await request(`/crm/v3/objects/${objectPath}/batch/archive`, {
                    method: "POST",
                    body: JSON.stringify({ inputs: chunk.map((operation) => ({ id: operation.objectId })) }),
                });
            }
            catch (error) {
                for (const operation of chunk)
                    out.set(operation.id, { operationId: operation.id, status: "failed", detail: error instanceof Error ? error.message : String(error) });
                continue;
            }
            const opByObjectId = new Map(chunk.map((operation) => [operation.objectId, operation]));
            for (const error of data?.errors ?? []) {
                for (const id of batchErrorIds(error)) {
                    const operation = opByObjectId.get(id);
                    if (operation)
                        out.set(operation.id, { operationId: operation.id, status: "failed", detail: batchErrorDetail(error) });
                }
            }
            for (const result of data?.results ?? []) {
                const operation = opByObjectId.get(String(result?.id));
                if (operation && !out.has(operation.id))
                    out.set(operation.id, { operationId: operation.id, status: "applied", detail: `Archived ${objectPath}/${operation.objectId}.` });
            }
            for (const operation of chunk) {
                if (!out.has(operation.id))
                    out.set(operation.id, { operationId: operation.id, status: "applied", detail: `Archived ${objectPath}/${operation.objectId}.` });
            }
        }
        return operations.map((operation) => out.get(operation.id) ?? { operationId: operation.id, status: "failed", detail: "Batch archive did not process this operation." });
    }
    async function applyBatch(operations) {
        if (operations.length === 0)
            return [];
        if (operations.every((operation) => (operation.operation === "set_field" || operation.operation === "clear_field") && operation.objectType === operations[0].objectType)) {
            return applySetFieldBatch(operations);
        }
        if (operations.every((operation) => operation.operation === "archive_record" && operation.objectType === operations[0].objectType)) {
            return applyArchiveBatch(operations);
        }
        return operations.map((operation) => ({ operationId: operation.id, status: "skipped", detail: "This mixed operation batch is not supported." }));
    }
    /**
     * Merge a duplicate group into the approved survivor via HubSpot's v3
     * merge API (supported for contacts, companies, deals, and tickets).
     * Merges are pairwise and IRREVERSIBLE; the survivor's values win on
     * conflict and each loser is archived by HubSpot. A loser that is already
     * gone (404 — e.g. a replayed plan) is treated as already merged.
     */
    async function mergeRecords(operation) {
        const objectPath = OBJECT_PATHS[operation.objectType];
        if (!objectPath || operation.objectType === "user" || operation.objectType === "activity") {
            return {
                operationId: operation.id,
                status: "skipped",
                detail: "merge_records is supported for accounts, contacts, and deals.",
            };
        }
        const survivorId = String(operation.afterValue ?? "");
        const groupIds = Array.isArray(operation.beforeValue)
            ? operation.beforeValue.map((id) => String(id))
            : [];
        if (!survivorId || groupIds.length < 2) {
            return {
                operationId: operation.id,
                status: "skipped",
                detail: "merge_records needs a survivor id (afterValue) and the duplicate group ids (beforeValue).",
            };
        }
        if (!groupIds.includes(survivorId)) {
            return {
                operationId: operation.id,
                status: "skipped",
                detail: `Survivor ${survivorId} is not in the duplicate group (${groupIds.join(", ")}); refusing to merge into an unrelated record.`,
            };
        }
        const losers = groupIds.filter((id) => id !== survivorId);
        const mergedIds = [];
        const alreadyGoneIds = [];
        for (const loser of losers) {
            try {
                await request(`/crm/v3/objects/${objectPath}/merge`, {
                    method: "POST",
                    body: JSON.stringify({ primaryObjectId: survivorId, objectIdToMerge: loser }),
                });
                mergedIds.push(loser);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (message.includes(" 404")) {
                    alreadyGoneIds.push(loser); // replayed plan: loser already merged/archived
                    continue;
                }
                return {
                    operationId: operation.id,
                    status: "failed",
                    detail: `Merged ${mergedIds.length} of ${losers.length} into ${survivorId}, then failed on ${loser}: ${message}`,
                    providerData: { survivorId, mergedIds, alreadyGoneIds },
                };
            }
        }
        return {
            operationId: operation.id,
            status: mergedIds.length === 0 && alreadyGoneIds.length === losers.length ? "skipped" : "applied",
            detail: mergedIds.length === 0 && alreadyGoneIds.length === losers.length
                ? `All ${losers.length} duplicates were already merged into ${survivorId}; nothing to do.`
                : `Merged ${mergedIds.length} duplicate ${objectPath} into ${survivorId}${alreadyGoneIds.length ? ` (${alreadyGoneIds.length} already gone)` : ""}. Irreversible.`,
            providerData: { survivorId, mergedIds, alreadyGoneIds },
        };
    }
    async function applyOperation(operation) {
        try {
            switch (operation.operation) {
                case "set_field":
                case "clear_field":
                    return await setField(operation);
                case "link_record":
                    return await linkRecord(operation);
                case "create_task":
                    return await createTask(operation);
                case "create_record":
                    return await createRecord(operation);
                case "merge_records":
                    return await mergeRecords(operation);
                case "archive_record":
                    return await archiveRecord(operation);
                default:
                    return {
                        operationId: operation.id,
                        status: "skipped",
                        detail: `Unknown operation ${operation.operation}.`,
                    };
            }
        }
        catch (error) {
            return {
                operationId: operation.id,
                status: "failed",
                detail: error instanceof Error ? error.message : String(error),
            };
        }
    }
    function readMapped(source, objectType, targetField, fallbackField) {
        return readMappedValue(source, mappings, objectType, targetField, fallbackField);
    }
    async function readField(objectType, objectId, field) {
        const objectPath = OBJECT_PATHS[objectType];
        const mappingType = MAPPING_OBJECT_TYPES[objectType];
        if (!objectPath || !mappingType) {
            throw new Error(`Field reads are only supported for accounts, contacts, and deals.`);
        }
        // accountId is an association in HubSpot, not a property — without this
        // branch the compare-and-set on link_record reads null and passes blind.
        if (field === "accountId" && (objectType === "deal" || objectType === "contact")) {
            const data = await request(`/crm/v4/objects/${objectPath}/${encodeURIComponent(objectId)}/associations/companies?limit=1`);
            const first = (data?.results ?? [])[0];
            return first?.toObjectId !== undefined ? String(first.toObjectId) : null;
        }
        const defaults = HUBSPOT_DEFAULT_FIELD_MAPPINGS[mappingType] ?? {};
        const property = mappedField(mappings, mappingType, field, defaults[field] ?? field);
        const data = await request(`/crm/v3/objects/${objectPath}/${encodeURIComponent(objectId)}?properties=${encodeURIComponent(property)}`);
        const value = data?.properties?.[property] ?? null;
        // fetchSnapshot normalizes closeDate to a date with `?.split("T")[0]`, so the
        // value baked into an op's beforeValue is date-only ("2026-03-07"). The
        // single-object read here returns HubSpot's raw "2026-03-07T00:00:00Z", which
        // made compare-and-set see a spurious drift and refuse every date-field write.
        // Mirror the snapshot's normalization so the comparison is apples-to-apples.
        return normalizeHubspotReadValue(field, value);
    }
    return {
        provider: "hubspot",
        fetchSnapshot,
        fetchChanges,
        applyOperation,
        applyCreateContactsBatch,
        applyBatch,
        applyBatchLimit: 100,
        readField,
    };
}
function provenanceFrom(props) {
    const source = stringOrUndefined(props.hs_object_source);
    const sourceLabel = stringOrUndefined(props.hs_object_source_label);
    const sourceId = stringOrUndefined(props.hs_object_source_id);
    if (!source && !sourceLabel && !sourceId)
        return undefined;
    return { source, sourceLabel, sourceId };
}
function stringOrUndefined(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    return String(value);
}
function stringOrFallback(value, fallback) {
    return stringOrUndefined(value) ?? fallback;
}
function numberOrUndefined(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : undefined;
}
