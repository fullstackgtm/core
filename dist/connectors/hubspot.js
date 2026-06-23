import { HUBSPOT_DEFAULT_FIELD_MAPPINGS, mappedField, mappedFields, readMappedValue, } from "../mappings.js";
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
    const mappings = options.fieldMappings;
    // create:<Name> dedup within one connector lifetime (one apply run): the
    // search API is eventually consistent, so a just-created company is
    // invisible to search — this map is the authoritative same-run record.
    const createdCompaniesByName = new Map();
    // Same-run dedup for `create_record` contact creates, keyed by lowercased
    // match value (email): HubSpot search is eventually consistent, so a contact
    // created earlier in this apply run is invisible to a later search.
    const createdContactsByMatch = new Map();
    async function request(path, init = {}) {
        const token = await options.getAccessToken();
        let response;
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
        if (!response.ok) {
            // Status line only — HubSpot 4xx bodies echo submitted property values
            // (contact emails, company domains) and the request payload, and these
            // errors are persisted into scheduled-run records. Never interpolate it.
            await response.text().catch(() => undefined);
            throw new Error(`HubSpot API error ${response.status}. Check the token scopes and request.`);
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
    async function list(path) {
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
            after = data.paging?.next?.after;
        } while (after);
        return results;
    }
    async function assembleSnapshot(fetchObjects) {
        const owners = await list("/crm/v3/owners?limit=100");
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
        return assembleSnapshot((objectType, properties, withAssociations) => list(`/crm/v3/objects/${objectType}?limit=100&properties=${properties}${withAssociations ? "&associations=companies" : ""}`));
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
        // Associate a deal or contact with a company (the only link the built-in
        // rules emit — missing-deal-account). afterValue is the target company id.
        const fromPath = OBJECT_PATHS[operation.objectType];
        if ((operation.objectType !== "deal" && operation.objectType !== "contact") || !fromPath) {
            return {
                operationId: operation.id,
                status: "skipped",
                detail: "link_record is supported for deals and contacts (to a company).",
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
    /** Exact-name company lookup for resolve-first creates. Returns matching ids (max 3 fetched). */
    async function searchCompaniesByName(name) {
        const data = await request(`/crm/v3/objects/companies/search`, {
            method: "POST",
            body: JSON.stringify({
                filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: name }] }],
                properties: ["name"],
                limit: 3,
            }),
        });
        return (data?.results ?? []).map((row) => String(row.id));
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
     * Resolve a company by exact name, creating it on a confirmed miss. Returns
     * the company id, or null on ambiguity (≥2 existing) so the caller skips the
     * association rather than guessing. Same-run safe via createdCompaniesByName.
     */
    async function resolveOrCreateCompanyByName(name, opId) {
        const nameKey = name.toLowerCase();
        const already = createdCompaniesByName.get(nameKey);
        if (already)
            return already;
        const matches = await searchCompaniesByName(name);
        if (matches.length > 1)
            return null;
        if (matches.length === 1) {
            createdCompaniesByName.set(nameKey, matches[0]);
            return matches[0];
        }
        let created;
        try {
            created = await request(`/crm/v3/objects/companies`, {
                method: "POST",
                body: JSON.stringify({
                    properties: { name, hs_object_source_detail_2: `fullstackgtm acquire (${opId})` },
                }),
            });
        }
        catch {
            created = await request(`/crm/v3/objects/companies`, {
                method: "POST",
                body: JSON.stringify({ properties: { name } }),
            });
        }
        const id = String(created.id);
        createdCompaniesByName.set(nameKey, id);
        return id;
    }
    /**
     * Create a NET-NEW record (a sourced lead). Resolve-first: re-checks the
     * dedupe key against the live CRM (the plan-time snapshot can be stale) and
     * creates ONLY on a confirmed miss — a record a concurrent writer already
     * added is returned as `skipped`, never duplicated. Contacts can be linked
     * to a resolved-or-created company in the same step.
     */
    async function createRecord(operation) {
        const payload = operation.afterValue;
        if (!payload || typeof payload !== "object" || !payload.properties) {
            return { operationId: operation.id, status: "skipped", detail: "create_record needs a CreateRecordPayload afterValue." };
        }
        const objectPath = OBJECT_PATHS[operation.objectType];
        if (operation.objectType !== "contact" && operation.objectType !== "account") {
            return { operationId: operation.id, status: "skipped", detail: "create_record supports contacts and accounts." };
        }
        const matchValue = String(payload.matchValue ?? "").trim();
        if (!matchValue) {
            return { operationId: operation.id, status: "skipped", detail: "create_record needs a non-empty matchValue to resolve-first." };
        }
        if (operation.objectType === "account") {
            const id = await resolveOrCreateCompanyByName(matchValue, operation.id);
            if (id === null) {
                return { operationId: operation.id, status: "skipped", detail: `create_record: ambiguous — multiple companies named "${matchValue}". Not creating.` };
            }
            return { operationId: operation.id, status: "applied", detail: `Resolved/created company "${matchValue}" (${id}).`, providerData: { id } };
        }
        // contact — resolve-first on the dedupe key (email by default)
        const matchKey = payload.matchKey || "email";
        const matchKeyLower = `${matchKey}:${matchValue.toLowerCase()}`;
        if (createdContactsByMatch.has(matchKeyLower)) {
            return { operationId: operation.id, status: "skipped", detail: `Contact ${matchKey}=${matchValue} already created earlier in this run; not duplicating.`, providerData: { id: createdContactsByMatch.get(matchKeyLower), existing: true } };
        }
        const existing = await searchContactsBy(matchKey, matchValue);
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
                const companyId = await resolveOrCreateCompanyByName(payload.associateCompanyName, operation.id);
                if (companyId) {
                    await request(`/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/default/companies/${encodeURIComponent(companyId)}`, { method: "PUT" });
                    companyNote = ` Linked to company "${payload.associateCompanyName}" (${companyId}).`;
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
        return data?.properties?.[property] ?? null;
    }
    return {
        provider: "hubspot",
        fetchSnapshot,
        fetchChanges,
        applyOperation,
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
