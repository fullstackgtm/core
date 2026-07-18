import { accountsShareKnownFamily } from "./accountFamily.js";
const CONFLICT_IGNORED_FIELDS = new Set([
    "id", "provider", "crmId", "identities", "raw", "lastSyncAt", "lastActivityAt", "ownerId", "accountId", "provenance",
]);
export function normalizeDomain(domain) {
    if (!domain)
        return undefined;
    return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") || undefined;
}
function normalizeEmail(email) {
    const normalized = email?.trim().toLowerCase();
    return normalized || undefined;
}
function identityOf(record) {
    return { provider: record.provider ?? "unknown", externalId: record.crmId ?? record.id };
}
export function mergeSnapshots(snapshots) {
    if (snapshots.length === 0)
        throw new Error("mergeSnapshots needs at least one snapshot.");
    const sources = snapshots.map((snapshot) => snapshot.provider);
    const matches = [];
    const conflicts = [];
    // Original id (per source snapshot) → merged id, used to re-point references.
    const idRemap = new Map();
    function namespaced(provider, id) {
        return `${provider}:${id}`;
    }
    function mergeCollection(type, collections, keysOf) {
        const merged = [];
        const byKey = new Map();
        for (const { provider, records } of collections) {
            for (const record of records) {
                const sourceId = namespaced(provider, record.id);
                const keyed = keysOf(record);
                const existing = keyed
                    .map((entry) => ({ ...entry, match: byKey.get(`${entry.matchedBy}:${entry.key}`) }))
                    .find((entry) => entry.match);
                if (!existing?.match) {
                    const copy = {
                        ...record,
                        id: sourceId,
                        provider: record.provider ?? provider,
                        identities: [identityOf({ ...record, provider: record.provider ?? provider })],
                    };
                    merged.push(copy);
                    idRemap.set(sourceId, sourceId);
                    for (const entry of keyed)
                        byKey.set(`${entry.matchedBy}:${entry.key}`, copy);
                    continue;
                }
                const primary = existing.match;
                idRemap.set(sourceId, primary.id);
                primary.identities = [
                    ...(primary.identities ?? []),
                    identityOf({ ...record, provider: record.provider ?? provider }),
                ];
                const match = matches.find((candidate) => candidate.type === type && candidate.primaryId === primary.id);
                if (match)
                    match.mergedIds.push(sourceId);
                else
                    matches.push({ type, primaryId: primary.id, mergedIds: [sourceId], matchedBy: existing.matchedBy });
                // First source wins; fill gaps, report disagreements.
                for (const [field, value] of Object.entries(record)) {
                    if (CONFLICT_IGNORED_FIELDS.has(field) || value === undefined)
                        continue;
                    const current = primary[field];
                    if (current === undefined) {
                        primary[field] = value;
                    }
                    else if (JSON.stringify(current) !== JSON.stringify(value)) {
                        conflicts.push({
                            type,
                            recordId: primary.id,
                            field,
                            values: [
                                { provider: primary.provider ?? "unknown", value: current },
                                { provider: record.provider ?? provider, value },
                            ],
                        });
                    }
                }
            }
        }
        return merged;
    }
    const users = mergeCollection("user", snapshots.map((snapshot) => ({ provider: snapshot.provider, records: snapshot.users })), (user) => {
        const email = normalizeEmail(user.email);
        return email ? [{ key: email, matchedBy: "email" }] : [];
    });
    // A shared domain inside a recorded corporate family is not identity. Block
    // that domain from cross-system collapsing before any records are combined.
    const familyDomains = new Set();
    for (const snapshot of snapshots) {
        const byDomain = new Map();
        for (const account of snapshot.accounts) {
            const domain = normalizeDomain(account.domain);
            if (domain)
                byDomain.set(domain, [...(byDomain.get(domain) ?? []), account]);
        }
        for (const [domain, accounts] of byDomain) {
            if (accounts.length > 1 && accountsShareKnownFamily(accounts))
                familyDomains.add(domain);
        }
    }
    const accounts = mergeCollection("account", snapshots.map((snapshot) => ({
        provider: snapshot.provider,
        records: snapshot.accounts.map((account) => ({
            ...account,
            parentAccountId: account.parentAccountId ? namespaced(snapshot.provider, account.parentAccountId) : undefined,
        })),
    })), 
    // Auto-merge accounts ONLY on a shared normalized domain. Name is a weak,
    // collision-prone key (every "Acme Inc"); name-only collisions become
    // review suggestions below instead of silent merges.
    (account) => {
        const domain = normalizeDomain(account.domain);
        return domain && !familyDomains.has(domain) ? [{ key: domain, matchedBy: "domain" }] : [];
    });
    const suggestions = [];
    const byName = new Map();
    for (const account of accounts) {
        const key = account.name.trim().toLowerCase();
        if (!key)
            continue;
        byName.set(key, [...(byName.get(key) ?? []), account.id]);
    }
    for (const [, recordIds] of byName) {
        if (recordIds.length > 1) {
            const name = accounts.find((account) => account.id === recordIds[0]).name;
            suggestions.push({ type: "account", name, recordIds });
        }
    }
    const contacts = mergeCollection("contact", snapshots.map((snapshot) => ({ provider: snapshot.provider, records: snapshot.contacts })), (contact) => {
        const email = normalizeEmail(contact.email);
        return email ? [{ key: email, matchedBy: "email" }] : [];
    });
    const remapRef = (provider, id) => id === undefined ? undefined : idRemap.get(`${provider}:${id}`) ?? namespaced(provider, id);
    for (const account of accounts) {
        if (account.parentAccountId)
            account.parentAccountId = idRemap.get(account.parentAccountId) ?? account.parentAccountId;
    }
    const deals = snapshots.flatMap((snapshot) => snapshot.deals.map((deal) => ({
        ...deal,
        id: namespaced(snapshot.provider, deal.id),
        provider: deal.provider ?? snapshot.provider,
        identities: [identityOf({ ...deal, provider: deal.provider ?? snapshot.provider })],
        accountId: remapRef(snapshot.provider, deal.accountId),
        ownerId: remapRef(snapshot.provider, deal.ownerId),
    })));
    const activities = snapshots.flatMap((snapshot) => snapshot.activities.map((activity) => ({
        ...activity,
        id: namespaced(snapshot.provider, activity.id),
        provider: activity.provider ?? snapshot.provider,
        accountId: remapRef(snapshot.provider, activity.accountId),
        contactId: remapRef(snapshot.provider, activity.contactId),
        dealId: remapRef(snapshot.provider, activity.dealId),
        ownerId: remapRef(snapshot.provider, activity.ownerId),
    })));
    return {
        snapshot: {
            generatedAt: snapshots.map((snapshot) => snapshot.generatedAt).sort().at(-1),
            provider: "merged",
            users,
            accounts,
            contacts,
            deals,
            activities,
        },
        report: { sources, matches, conflicts, suggestions },
    };
}
