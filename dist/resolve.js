import { normalizeDomain } from "./merge.js";
import { accountsShareKnownFamily } from "./accountFamily.js";
export function resolveRecord(snapshot, candidate) {
    if (candidate.objectType === "account")
        return resolveAccount(snapshot, candidate);
    if (candidate.objectType === "contact")
        return resolveContact(snapshot, candidate);
    return resolveDeal(snapshot, candidate);
}
function resolveAccount(snapshot, c) {
    const base = { objectType: "account" };
    const domain = normalizeDomain(c.domain);
    if (domain) {
        const matches = snapshot.accounts
            .filter((a) => normalizeDomain(a.domain) === domain)
            .map((a) => match(a.id, a.name, "domain", `account domain ${a.domain} normalizes to ${domain}`));
        if (matches.length === 1) {
            return { ...base, verdict: "exists", matches, reason: `An account with domain ${domain} already exists: "${matches[0].name}" (${matches[0].id}). Link to it instead of creating.` };
        }
        if (matches.length > 1) {
            const matchedAccounts = snapshot.accounts.filter((a) => normalizeDomain(a.domain) === domain);
            const related = accountsShareKnownFamily(matchedAccounts);
            return {
                ...base,
                verdict: "ambiguous",
                matches,
                reason: related
                    ? `${matches.length} related accounts share domain ${domain}. Choose the correct family member or supply a subsidiary-specific domain; do not create or merge based on domain alone.`
                    : `${matches.length} accounts already share domain ${domain} — review whether they are duplicates or intentional business units before creating or merging anything.`,
            };
        }
    }
    if (c.name) {
        const key = normalizeName(c.name);
        const matches = snapshot.accounts
            .filter((a) => normalizeName(a.name) === key)
            .map((a) => match(a.id, a.name, "name", `account name matches "${c.name}" (domain: ${a.domain ?? "none"})`));
        if (matches.length > 0) {
            // Name alone is suggestive, not identity — two real companies can share
            // a name (the merge engine treats this the same way).
            return {
                ...base,
                verdict: "ambiguous",
                matches,
                reason: `${matches.length} account(s) named "${c.name}" exist but ${domain ? `none share domain ${domain}` : "no domain was supplied to confirm identity"}. Confirm before creating — supply a domain to disambiguate.`,
            };
        }
    }
    if (!domain && !c.name) {
        return { ...base, verdict: "ambiguous", matches: [], reason: "Supply --domain and/or --name to resolve an account." };
    }
    return { ...base, verdict: "safe_to_create", matches: [], reason: `No account matches ${domain ? `domain ${domain}` : `name "${c.name}"`}. Safe to create.` };
}
function resolveContact(snapshot, c) {
    const base = { objectType: "contact" };
    const email = c.email?.trim().toLowerCase();
    if (email) {
        const matches = snapshot.contacts
            .filter((row) => row.email?.trim().toLowerCase() === email)
            .map((row) => match(row.id, contactName(row), "email", `contact email matches ${email}`));
        if (matches.length === 1) {
            return { ...base, verdict: "exists", matches, reason: `A contact with email ${email} already exists: "${matches[0].name}" (${matches[0].id}). Update it instead of creating.` };
        }
        if (matches.length > 1) {
            return { ...base, verdict: "ambiguous", matches, reason: `${matches.length} contacts already share ${email} — a duplicate group; merge before adding more. Do not create.` };
        }
        return { ...base, verdict: "safe_to_create", matches: [], reason: `No contact matches ${email}. Safe to create.` };
    }
    if (c.name) {
        const key = normalizeName(c.name);
        const matches = snapshot.contacts
            .filter((row) => normalizeName(contactName(row)) === key)
            .map((row) => match(row.id, contactName(row), "name", `contact name matches "${c.name}" (email: ${row.email ?? "none"})`));
        if (matches.length > 0) {
            return { ...base, verdict: "ambiguous", matches, reason: `${matches.length} contact(s) named "${c.name}" exist; names are not identity. Supply --email to resolve definitively.` };
        }
        return { ...base, verdict: "safe_to_create", matches: [], reason: `No contact named "${c.name}". Safe to create — but prefer resolving by email.` };
    }
    return { ...base, verdict: "ambiguous", matches: [], reason: "Supply --email (preferred) or --name to resolve a contact." };
}
function resolveDeal(snapshot, c) {
    const base = { objectType: "deal" };
    if (!c.name) {
        return { ...base, verdict: "ambiguous", matches: [], reason: "Supply --name (and ideally --account-id) to resolve a deal." };
    }
    const nameKey = normalizeName(c.name);
    const open = snapshot.deals.filter((d) => d.isClosed !== true && d.isWon !== true);
    if (c.accountId) {
        const key = `${c.accountId}:${nameKey}`;
        const matches = open
            .filter((d) => `${d.accountId ?? "unlinked"}:${normalizeName(d.name)}` === key)
            .map((d) => match(d.id, d.name, "deal_key", `open deal with the same name on account ${c.accountId}`));
        if (matches.length > 0) {
            return {
                ...base,
                verdict: "exists",
                matches,
                reason: `${matches.length} open deal(s) already match "${c.name}" on account ${c.accountId} — creating another would double-count pipeline. Update the existing deal.`,
            };
        }
        const closedSameName = snapshot.deals.filter((d) => (d.isClosed === true || d.isWon === true) &&
            d.accountId === c.accountId &&
            normalizeName(d.name) === nameKey);
        return {
            ...base,
            verdict: "safe_to_create",
            matches: [],
            reason: closedSameName.length > 0
                ? `No open deal matches on account ${c.accountId}; ${closedSameName.length} closed deal(s) on it share the name (a re-open/renewal may be intended). Safe to create.`
                : `No open deal matches "${c.name}" on account ${c.accountId}. Safe to create.`,
        };
    }
    // No account scope: name-only matches across ALL open deals are ambiguous,
    // never safe — a gate that ignores name collisions protects nobody.
    const sameName = open
        .filter((d) => normalizeName(d.name) === nameKey)
        .map((d) => match(d.id, d.name, "name", `open deal with the same name on ${d.accountId ? `account ${d.accountId}` : "no account"}`));
    if (sameName.length > 0) {
        return {
            ...base,
            verdict: "ambiguous",
            matches: sameName,
            reason: `${sameName.length} open deal(s) named "${c.name}" exist (no --account-id supplied to scope the check). Confirm before creating — supply --account-id to resolve definitively.`,
        };
    }
    return { ...base, verdict: "safe_to_create", matches: [], reason: `No open deal named "${c.name}" anywhere. Safe to create.` };
}
function contactName(row) {
    return [row.firstName, row.lastName].filter(Boolean).join(" ") || "(unnamed)";
}
function normalizeName(value) {
    return value.trim().toLowerCase().replace(/\s+/g, " ");
}
function match(id, name, matchedBy, detail) {
    return { id, name, matchedBy, detail };
}
