import { SALESFORCE_DEFAULT_FIELD_MAPPINGS, mappedField, mappedFields, readMappedValue, } from "../mappings.js";
const DEFAULT_API_VERSION = "v59.0";
const SOBJECT_TYPES = {
    account: "Account",
    contact: "Contact",
    deal: "Opportunity",
};
// SObjects the SOAP merge() call supports. Opportunity is deliberately absent —
// Salesforce has no opportunity merge at all (API or UI).
const SOAP_MERGEABLE = {
    account: "Account",
    contact: "Contact",
};
const MAPPING_OBJECT_TYPES = {
    account: "accounts",
    contact: "contacts",
    deal: "deals",
};
/**
 * Reference connector for Salesforce.
 *
 * Reads run SOQL with cursor pagination; writes PATCH sobjects directly.
 * Like the HubSpot connector, it never drops records it cannot fully resolve
 * (ownerless or amountless opportunities are returned so audit rules can
 * surface the gaps). Probabilities are normalized to 0..1 to match the
 * canonical model.
 */
export function createSalesforceConnector(options) {
    const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    const fetchImpl = options.fetchImpl ?? fetch;
    const mappings = options.fieldMappings;
    // create:<Name> dedup within one connector lifetime (one apply run).
    const createdAccountsByName = new Map();
    async function request(path, init = {}) {
        const connection = await options.getConnection();
        const url = path.startsWith("http")
            ? path
            : `${connection.instanceUrl.replace(/\/$/, "")}${path}`;
        let response;
        try {
            response = await fetchImpl(url, {
                ...init,
                headers: {
                    Authorization: `Bearer ${connection.accessToken}`,
                    "Content-Type": "application/json",
                    ...(init.headers ?? {}),
                },
            });
        }
        catch (error) {
            const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
            throw new Error(`Cannot reach Salesforce at ${connection.instanceUrl}${cause}. Check SALESFORCE_INSTANCE_URL (your My Domain URL, e.g. https://yourco.my.salesforce.com) and network access.`);
        }
        if (!response.ok) {
            // Status line only — the body echoes submitted field values and the
            // request, and these errors are persisted into scheduled-run records.
            await response.text().catch(() => undefined);
            throw new Error(`Salesforce API error ${response.status}. Check the token and request.`);
        }
        // Salesforce PATCH returns 204 No Content on success.
        const text = await response.text();
        return text ? JSON.parse(text) : null;
    }
    async function query(soql) {
        const records = [];
        let next = `/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`;
        const seen = new Set();
        while (next) {
            // Defend against a repeated nextRecordsUrl (would loop forever).
            if (seen.has(next))
                break;
            seen.add(next);
            const data = await request(next);
            records.push(...(data?.records ?? []));
            next = data?.nextRecordsUrl ?? undefined;
        }
        return records;
    }
    function readMapped(source, objectType, targetField, fallbackField) {
        return readMappedValue(source, mappings, objectType, targetField, fallbackField);
    }
    function selectFields(objectType) {
        return mappedFields(mappings, objectType, SALESFORCE_DEFAULT_FIELD_MAPPINGS[objectType]).join(", ");
    }
    async function assembleSnapshot(whereClause) {
        const sfUsers = await query(`SELECT ${selectFields("owners")} FROM User${whereClause}`);
        const users = sfUsers.map((user) => {
            const id = String(readMapped(user, "owners", "id", "Id"));
            const email = stringOrUndefined(readMapped(user, "owners", "email", "Email"));
            return {
                id,
                provider: "salesforce",
                crmId: id,
                identities: [{ provider: "salesforce", externalId: id }],
                name: stringOrFallback(readMapped(user, "owners", "name", "Name"), email ?? `User ${id}`),
                email,
                title: stringOrUndefined(readMapped(user, "owners", "title", "Title")),
                active: Boolean(readMapped(user, "owners", "isActive", "IsActive")),
            };
        });
        const sfAccounts = await query(`SELECT ${selectFields("accounts")} FROM Account${whereClause}`);
        const accounts = sfAccounts.map((account) => {
            const id = String(readMapped(account, "accounts", "id", "Id"));
            return {
                id,
                provider: "salesforce",
                crmId: id,
                identities: [{ provider: "salesforce", externalId: id }],
                name: stringOrFallback(readMapped(account, "accounts", "name", "Name"), "Unknown Account"),
                domain: stringOrUndefined(readMapped(account, "accounts", "domain", "Website")),
                industry: stringOrUndefined(readMapped(account, "accounts", "industry", "Industry")),
                employeeCount: numberOrUndefined(readMapped(account, "accounts", "employeeCount", "NumberOfEmployees")),
                annualRevenue: numberOrUndefined(readMapped(account, "accounts", "annualRevenue", "AnnualRevenue")),
                ownerId: stringOrUndefined(readMapped(account, "accounts", "ownerId", "OwnerId")),
                raw: account,
            };
        });
        const sfContacts = await query(`SELECT ${selectFields("contacts")} FROM Contact${whereClause}`);
        const contacts = sfContacts.map((contact) => {
            const id = String(readMapped(contact, "contacts", "id", "Id"));
            return {
                id,
                provider: "salesforce",
                crmId: id,
                identities: [{ provider: "salesforce", externalId: id }],
                accountId: stringOrUndefined(readMapped(contact, "contacts", "accountId", "AccountId")),
                firstName: stringOrUndefined(readMapped(contact, "contacts", "firstName", "FirstName")),
                lastName: stringOrUndefined(readMapped(contact, "contacts", "lastName", "LastName")),
                email: stringOrUndefined(readMapped(contact, "contacts", "email", "Email")),
                phone: stringOrUndefined(readMapped(contact, "contacts", "phone", "Phone")),
                title: stringOrUndefined(readMapped(contact, "contacts", "title", "Title")),
                ownerId: stringOrUndefined(readMapped(contact, "contacts", "ownerId", "OwnerId")),
                raw: contact,
            };
        });
        const sfOpportunities = await query(`SELECT ${selectFields("deals")} FROM Opportunity${whereClause}`);
        const deals = sfOpportunities.map((opportunity) => {
            const id = String(readMapped(opportunity, "deals", "id", "Id"));
            const probability = numberOrUndefined(readMapped(opportunity, "deals", "probability", "Probability"));
            const isClosed = Boolean(readMapped(opportunity, "deals", "isClosed", "IsClosed"));
            const isWon = Boolean(readMapped(opportunity, "deals", "isWon", "IsWon"));
            const forecastCategoryName = stringOrUndefined(readMapped(opportunity, "deals", "forecastCategoryName", "ForecastCategory"));
            const forecastCategory = isWon
                ? "closed_won"
                : isClosed
                    ? "closed_lost"
                    : // Map Salesforce's native ForecastCategory (e.g. "BestCase",
                        // "Commit", "Pipeline") to the canonical snake_case form, falling
                        // back to "pipeline" when absent.
                        (forecastCategoryName
                            ? forecastCategoryName
                                .replace(/([a-z])([A-Z])/g, "$1_$2")
                                .toLowerCase()
                            : "pipeline");
            return {
                id,
                provider: "salesforce",
                crmId: id,
                identities: [{ provider: "salesforce", externalId: id }],
                accountId: stringOrUndefined(readMapped(opportunity, "deals", "accountId", "AccountId")),
                ownerId: stringOrUndefined(readMapped(opportunity, "deals", "ownerId", "OwnerId")),
                name: stringOrFallback(readMapped(opportunity, "deals", "name", "Name"), "Untitled Opportunity"),
                amount: numberOrUndefined(readMapped(opportunity, "deals", "amount", "Amount")),
                stage: stringOrUndefined(readMapped(opportunity, "deals", "stage", "StageName")),
                closeDate: stringOrUndefined(readMapped(opportunity, "deals", "closeDate", "CloseDate"))?.split("T")[0],
                dealType: stringOrUndefined(readMapped(opportunity, "deals", "dealType", "Type")),
                forecastCategory,
                // Salesforce probabilities are 0..100; canonical is 0..1.
                probability: probability === undefined ? undefined : probability / 100,
                isClosed,
                isWon,
                lastActivityAt: stringOrUndefined(readMapped(opportunity, "deals", "lastActivityAt", "LastActivityDate")),
                raw: opportunity,
            };
        });
        return {
            generatedAt: new Date().toISOString(),
            provider: "salesforce",
            users,
            accounts,
            contacts,
            deals,
            // Task/Event reads come with engagement support; staleness falls back
            // to close dates until then.
            activities: [],
        };
    }
    async function fetchSnapshot() {
        return assembleSnapshot("");
    }
    /** Records modified since `sinceIso`, filtered on `SystemModstamp`. */
    async function fetchChanges(sinceIso) {
        const sinceMs = Date.parse(sinceIso);
        if (!Number.isFinite(sinceMs))
            throw new Error(`Invalid since timestamp: ${sinceIso}`);
        return assembleSnapshot(` WHERE SystemModstamp >= ${new Date(sinceMs).toISOString()}`);
    }
    function humanizeField(field) {
        return field
            .replace(/_task$/, "")
            .replace(/[_-]+/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase())
            .trim();
    }
    async function setField(operation) {
        const sobjectType = SOBJECT_TYPES[operation.objectType];
        const mappingType = MAPPING_OBJECT_TYPES[operation.objectType];
        if (!sobjectType || !mappingType || !operation.field) {
            return {
                operationId: operation.id,
                status: "skipped",
                detail: "Field writes are only supported for accounts, contacts, and deals with an explicit field.",
            };
        }
        const defaults = SALESFORCE_DEFAULT_FIELD_MAPPINGS[mappingType] ?? {};
        const field = mappedField(mappings, mappingType, operation.field, defaults[operation.field] ?? operation.field);
        const value = operation.operation === "clear_field" ? null : String(operation.afterValue ?? "");
        await request(`/services/data/${apiVersion}/sobjects/${sobjectType}/${encodeURIComponent(operation.objectId)}`, { method: "PATCH", body: JSON.stringify({ [field]: value }) });
        return {
            operationId: operation.id,
            status: "applied",
            detail: `Set ${field} on ${sobjectType}/${operation.objectId}.`,
            providerData: { sobjectType, field },
        };
    }
    async function createTask(operation) {
        // Salesforce activities relate via WhatId (account/opportunity) or WhoId
        // (contact). Subject is required.
        const reference = operation.objectType === "contact"
            ? { WhoId: operation.objectId }
            : operation.objectType === "account" || operation.objectType === "deal"
                ? { WhatId: operation.objectId }
                : null;
        if (!reference) {
            return {
                operationId: operation.id,
                status: "skipped",
                detail: "Tasks can be attached to accounts, contacts, and deals.",
            };
        }
        // Idempotency: the operation id is stamped into the Description and
        // pre-checked, so replaying a plan does not duplicate tasks. Fail-open.
        const token = `fsgtm:${operation.id}`;
        try {
            const existing = await query(`SELECT Id FROM Task WHERE Description LIKE '%${token.replace(/'/g, "\\'")}%' LIMIT 1`);
            if (existing.length > 0) {
                return {
                    operationId: operation.id,
                    status: "skipped",
                    detail: `Task for this operation already exists (task ${existing[0].Id}); not creating a duplicate.`,
                    providerData: { id: String(existing[0].Id), existing: true },
                };
            }
        }
        catch {
            // fall through to create
        }
        const response = await request(`/services/data/${apiVersion}/sobjects/Task`, {
            method: "POST",
            body: JSON.stringify({
                Subject: operation.field ? humanizeField(operation.field) : "Follow up",
                Description: `${String(operation.afterValue ?? operation.reason ?? "")}\n\n[${token}]`,
                Status: "Not Started",
                Priority: "Normal",
                ...reference,
            }),
        });
        return {
            operationId: operation.id,
            status: "applied",
            detail: `Created task on ${operation.objectType}/${operation.objectId}.`,
            providerData: { id: response?.id },
        };
    }
    async function archiveRecord(operation) {
        const sobjectType = SOBJECT_TYPES[operation.objectType];
        if (!sobjectType) {
            return {
                operationId: operation.id,
                status: "skipped",
                detail: "archive_record is supported for accounts, contacts, and deals.",
            };
        }
        await request(`/services/data/${apiVersion}/sobjects/${sobjectType}/${encodeURIComponent(operation.objectId)}`, { method: "DELETE" });
        return {
            operationId: operation.id,
            status: "applied",
            detail: `Deleted ${sobjectType}/${operation.objectId}.`,
        };
    }
    function escapeXml(value) {
        return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&apos;");
    }
    /**
     * One SOAP merge() call: master + up to 2 records to merge. Salesforce has no
     * REST merge resource, but the Partner SOAP API's merge() works for Account,
     * Contact, Lead, and Case, and accepts the OAuth access token as the SOAP
     * session id. Returns ok/detail (the SOAP fault/error message is operational
     * — MALFORMED_ID, entity-locked — not a data echo, so it's surfaced, capped).
     */
    async function soapMerge(sobjectType, masterId, loserIds) {
        const connection = await options.getConnection();
        const version = apiVersion.replace(/^v/, ""); // SOAP path uses "59.0", not "v59.0"
        const url = `${connection.instanceUrl.replace(/\/$/, "")}/services/Soap/u/${version}`;
        const toMerge = loserIds.map((id) => `<urn:recordToMergeIds>${escapeXml(id)}</urn:recordToMergeIds>`).join("");
        const envelope = `<?xml version="1.0" encoding="UTF-8"?>` +
            `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com" xmlns:urn1="urn:sobject.partner.soap.sforce.com">` +
            `<soapenv:Header><urn:SessionHeader><urn:sessionId>${escapeXml(connection.accessToken)}</urn:sessionId></urn:SessionHeader></soapenv:Header>` +
            `<soapenv:Body><urn:merge><urn:request>` +
            `<urn:masterRecord><urn1:type>${sobjectType}</urn1:type><urn1:Id>${escapeXml(masterId)}</urn1:Id></urn:masterRecord>` +
            toMerge +
            `</urn:request></urn:merge></soapenv:Body></soapenv:Envelope>`;
        let response;
        try {
            response = await fetchImpl(url, {
                method: "POST",
                headers: { "Content-Type": "text/xml; charset=UTF-8", SOAPAction: '""' },
                body: envelope,
            });
        }
        catch (error) {
            const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
            return { ok: false, detail: `Cannot reach the Salesforce SOAP endpoint${cause}.` };
        }
        const text = await response.text().catch(() => "");
        if (!response.ok) {
            const fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(text)?.[1]?.trim();
            return { ok: false, detail: `Salesforce SOAP merge failed (HTTP ${response.status})${fault ? `: ${fault.slice(0, 200)}` : ""}.` };
        }
        if (!/<success>\s*true\s*<\/success>/i.test(text)) {
            const message = /<message>([\s\S]*?)<\/message>/.exec(text)?.[1]?.trim();
            return { ok: false, detail: `Salesforce rejected the merge${message ? `: ${message.slice(0, 200)}` : ""}.` };
        }
        return { ok: true };
    }
    async function mergeRecords(operation) {
        const sobjectType = SOAP_MERGEABLE[operation.objectType];
        if (!sobjectType) {
            return {
                operationId: operation.id,
                status: "skipped",
                detail: operation.objectType === "deal"
                    ? "Salesforce opportunities cannot be merged (no merge exists in the API or the UI). Pick a survivor and close/archive the duplicate opportunities instead."
                    : `Salesforce merge supports Account and Contact only (not ${operation.objectType}).`,
            };
        }
        const master = operation.objectId;
        const group = Array.isArray(operation.beforeValue) ? operation.beforeValue.map(String) : [];
        const losers = group.filter((id) => id !== master);
        if (losers.length === 0) {
            return { operationId: operation.id, status: "skipped", detail: "Nothing to merge — no records besides the survivor." };
        }
        // SOAP merge() takes the master + at most 2 records per call; batch larger
        // duplicate groups. A mid-batch failure is reported with what was merged so
        // far (merges are irreversible).
        const merged = [];
        for (let i = 0; i < losers.length; i += 2) {
            const batch = losers.slice(i, i + 2);
            const result = await soapMerge(sobjectType, master, batch);
            if (!result.ok) {
                return {
                    operationId: operation.id,
                    status: "failed",
                    detail: `${result.detail} Merged ${merged.length} of ${losers.length} into ${master} before failing — IRREVERSIBLE; the remaining duplicates were not merged.`,
                    providerData: { survivorId: master, mergedRecordIds: merged },
                };
            }
            merged.push(...batch);
        }
        return {
            operationId: operation.id,
            status: "applied",
            detail: `Merged ${merged.length} ${sobjectType} record(s) into ${master} (irreversible).`,
            providerData: { survivorId: master, mergedRecordIds: merged },
        };
    }
    async function applyOperation(operation) {
        try {
            switch (operation.operation) {
                case "set_field":
                case "clear_field":
                    // link_record on a deal is just setting AccountId in Salesforce.
                    return await setField(operation);
                case "link_record": {
                    // `create:<Name>` is resolve-first: link to an unambiguous existing
                    // Account, refuse on ambiguity, create only on a confirmed miss —
                    // and never create the same name twice within one apply run.
                    const value = String(operation.afterValue ?? "");
                    if (value.startsWith("create:")) {
                        const name = value.slice("create:".length).trim();
                        if (!name) {
                            return { operationId: operation.id, status: "skipped", detail: "create: needs an account name (create:<Name>)." };
                        }
                        const nameKey = name.toLowerCase();
                        let accountId = createdAccountsByName.get(nameKey);
                        let createdNew = false;
                        if (!accountId) {
                            const soqlName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
                            const matches = await query(`SELECT Id FROM Account WHERE Name = '${soqlName}' LIMIT 3`);
                            if (matches.length > 1) {
                                return {
                                    operationId: operation.id,
                                    status: "skipped",
                                    detail: `create:${name} is ambiguous — ${matches.length} accounts already named "${name}". Link an explicit account id instead.`,
                                };
                            }
                            if (matches.length === 1) {
                                accountId = String(matches[0].Id);
                            }
                            else {
                                const created = await request(`/services/data/${apiVersion}/sobjects/Account`, {
                                    method: "POST",
                                    body: JSON.stringify({ Name: name }),
                                });
                                accountId = String(created.id);
                                createdNew = true;
                            }
                            createdAccountsByName.set(nameKey, accountId);
                        }
                        const result = await setField({ ...operation, operation: "set_field", afterValue: accountId });
                        return result.status === "applied"
                            ? {
                                ...result,
                                detail: createdNew
                                    ? `Created account "${name}" (${accountId}) and linked ${operation.objectType}/${operation.objectId} to it.`
                                    : `Linked ${operation.objectType}/${operation.objectId} to existing account ${accountId} (resolved by name, nothing created).`,
                                providerData: { accountId, ...(createdNew ? { createdAccount: true } : {}) },
                            }
                            : result;
                    }
                    return await setField({ ...operation, operation: "set_field" });
                }
                case "create_task":
                    return await createTask(operation);
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
    async function readField(objectType, objectId, field) {
        const sobjectType = SOBJECT_TYPES[objectType];
        const mappingType = MAPPING_OBJECT_TYPES[objectType];
        if (!sobjectType || !mappingType) {
            throw new Error(`Field reads are only supported for accounts, contacts, and deals.`);
        }
        const defaults = SALESFORCE_DEFAULT_FIELD_MAPPINGS[mappingType] ?? {};
        const sfField = mappedField(mappings, mappingType, field, defaults[field] ?? field);
        const data = await request(`/services/data/${apiVersion}/sobjects/${sobjectType}/${encodeURIComponent(objectId)}?fields=${encodeURIComponent(sfField)}`);
        return data?.[sfField] ?? null;
    }
    return {
        provider: "salesforce",
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
