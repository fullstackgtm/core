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
            const body = await response.text();
            throw new Error(`HubSpot API error ${response.status}: ${body}`);
        }
        // DELETE and some association writes return 204 with an empty body.
        const text = await response.text();
        return text ? JSON.parse(text) : null;
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
        const companyProperties = mappedFields(mappings, "accounts", HUBSPOT_DEFAULT_FIELD_MAPPINGS.accounts).join(",");
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
                lastSyncAt: stringOrUndefined(company.updatedAt),
                raw: company,
            };
        });
        const contactProperties = mappedFields(mappings, "contacts", HUBSPOT_DEFAULT_FIELD_MAPPINGS.contacts).join(",");
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
                ownerId: stringOrUndefined(readMapped(props, "contacts", "ownerId", "hubspot_owner_id")),
                lastSyncAt: stringOrUndefined(contact.updatedAt),
                raw: contact,
            };
        });
        const dealProperties = mappedFields(mappings, "deals", HUBSPOT_DEFAULT_FIELD_MAPPINGS.deals).join(",");
        const hubspotDeals = await fetchObjects("deals", dealProperties, true);
        const deals = hubspotDeals
            .filter((deal) => deal.id)
            .map((deal) => {
            const props = deal.properties ?? {};
            const companyId = deal.associations?.companies?.results?.[0]?.id;
            const stage = stringOrUndefined(readMapped(props, "deals", "stage", "dealstage"));
            const normalizedStage = (stage ?? "").toLowerCase();
            const isWon = normalizedStage.includes("closedwon");
            const isClosed = isWon || normalizedStage.includes("closedlost");
            const forecastCategory = isWon
                ? "closed_won"
                : normalizedStage.includes("closedlost")
                    ? "closed_lost"
                    : "pipeline";
            const lastActivityAt = stringOrUndefined(readMapped(props, "deals", "lastActivityAt", "hs_last_sales_activity_timestamp"));
            return {
                id: String(deal.id),
                provider: "hubspot",
                crmId: String(deal.id),
                identities: [{ provider: "hubspot", externalId: String(deal.id) }],
                accountId: companyId ? String(companyId) : undefined,
                ownerId: stringOrUndefined(readMapped(props, "deals", "ownerId", "hubspot_owner_id")),
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
        const companyId = String(operation.afterValue ?? "");
        if (!companyId) {
            return { operationId: operation.id, status: "skipped", detail: "link_record needs a target company id." };
        }
        await request(`/crm/v4/objects/${fromPath}/${encodeURIComponent(operation.objectId)}/associations/default/companies/${encodeURIComponent(companyId)}`, { method: "PUT" });
        return {
            operationId: operation.id,
            status: "applied",
            detail: `Linked ${fromPath}/${operation.objectId} to company ${companyId}.`,
            providerData: { companyId },
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
        const body = String(operation.afterValue ?? operation.reason ?? "");
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
