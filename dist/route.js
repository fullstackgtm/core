import { resolveAssignment } from "./assign.js";
import { FREE_EMAIL_DOMAINS } from "./freeEmailDomains.js";
import { normalizeDomain } from "./merge.js";
import { stableHash } from "./rules.js";
function norm(value) {
    if (value === undefined || value === null)
        return undefined;
    const out = String(value).trim().toLowerCase();
    return out || undefined;
}
function contactEmailDomain(contact) {
    const email = norm(contact.email);
    if (!email || !email.includes("@"))
        return undefined;
    return normalizeDomain(email.slice(email.lastIndexOf("@") + 1));
}
function rawString(record, keys) {
    if (!record.raw || typeof record.raw !== "object")
        return undefined;
    const raw = record.raw;
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
        if (value && typeof value === "object") {
            const nested = value;
            for (const nestedKey of ["value", "name", "label"]) {
                if (typeof nested[nestedKey] === "string" && String(nested[nestedKey]).trim()) {
                    return String(nested[nestedKey]).trim();
                }
            }
        }
    }
    return undefined;
}
function companyNameFor(contact) {
    return rawString(contact, ["company", "companyName", "company_name", "account", "accountName", "account_name"]);
}
function uniqueAccount(matches) {
    const byId = new Map(matches.map((account) => [String(account.id), account]));
    const unique = [...byId.values()];
    if (unique.length === 0)
        return null;
    if (unique.length > 1)
        return "ambiguous";
    return unique[0];
}
function employeeBand(employeeCount) {
    if (employeeCount === undefined)
        return undefined;
    if (employeeCount <= 10)
        return "1-10";
    if (employeeCount <= 50)
        return "11-50";
    if (employeeCount <= 200)
        return "51-200";
    if (employeeCount <= 1000)
        return "201-1000";
    return "1001+";
}
function routeContext(contact, account) {
    const geo = norm(rawString(contact, ["country", "countryCode", "country_code", "state", "region"])) ??
        norm(rawString(account ?? { raw: undefined }, ["country", "countryCode", "country_code", "state", "region"]));
    const department = norm(rawString(contact, ["department", "jobDepartment", "job_department"]));
    return {
        geo,
        industry: norm(account?.industry),
        employeeBand: employeeBand(account?.employeeCount),
        department,
        title: norm(contact.title),
        accountOwnerId: account?.ownerId,
    };
}
function activeOwnerIds(snapshot) {
    const ids = new Set();
    for (const user of snapshot.users) {
        if (user.active === false)
            continue;
        ids.add(String(user.id));
        if (user.crmId)
            ids.add(String(user.crmId));
    }
    return ids;
}
export function buildLeadRoutePlan(snapshot, options = {}) {
    const matchByDomain = options.matchByDomain ?? true;
    const matchByCompanyName = options.matchByCompanyName ?? false;
    const inheritAccountOwner = options.inheritAccountOwner ?? true;
    const reassignExistingOwner = options.reassignExistingOwner ?? false;
    const maxOperations = options.maxOperations ?? 500;
    const accountsByDomain = new Map();
    const accountsByName = new Map();
    for (const account of snapshot.accounts) {
        const domain = normalizeDomain(account.domain);
        if (domain)
            accountsByDomain.set(domain, [...(accountsByDomain.get(domain) ?? []), account]);
        const name = norm(account.name);
        if (name)
            accountsByName.set(name, [...(accountsByName.get(name) ?? []), account]);
    }
    const operations = [];
    const counts = {
        contactsScanned: 0,
        matchedContacts: 0,
        matchedExistingAccount: 0,
        matchedByDomain: 0,
        matchedByCompanyName: 0,
        ambiguousAccountMatches: 0,
        skippedFreeEmail: 0,
        linkOperations: 0,
        ownerOperations: 0,
        ownerAssigned: 0,
        policyAssigned: 0,
        unmatched: 0,
    };
    const knownOwners = activeOwnerIds(snapshot);
    let policyAssignmentIndex = 0;
    for (const contact of snapshot.contacts) {
        counts.contactsScanned += 1;
        const currentAccount = contact.accountId ? snapshot.accounts.find((account) => account.id === contact.accountId) : undefined;
        let matchedAccount = currentAccount;
        let matchRule = currentAccount ? "existing" : undefined;
        if (currentAccount)
            counts.matchedExistingAccount += 1;
        let skippedFreeEmail = false;
        if (!matchedAccount && matchByDomain) {
            const domain = contactEmailDomain(contact);
            if (domain && FREE_EMAIL_DOMAINS.has(domain)) {
                counts.skippedFreeEmail += 1;
                skippedFreeEmail = true;
            }
            else if (domain) {
                const match = uniqueAccount(accountsByDomain.get(domain) ?? []);
                if (match === "ambiguous")
                    counts.ambiguousAccountMatches += 1;
                else if (match) {
                    matchedAccount = match;
                    matchRule = "domain";
                    counts.matchedByDomain += 1;
                }
            }
        }
        if (!matchedAccount && matchByCompanyName && !skippedFreeEmail) {
            const company = norm(companyNameFor(contact));
            if (company && (accountsByName.get(company) ?? []).length > 0) {
                // Name-only account matches are not safe enough to auto-link. Keep the
                // contact unmatched and surface the skipped match as ambiguous.
                counts.ambiguousAccountMatches += 1;
            }
        }
        if (matchedAccount)
            counts.matchedContacts += 1;
        const contactOps = [];
        if (matchedAccount && !contact.accountId) {
            contactOps.push({
                id: `op_${stableHash(`route:link:${contact.id}:${matchedAccount.id}`)}`,
                objectType: "contact",
                objectId: String(contact.id),
                operation: "link_record",
                field: "accountId",
                beforeValue: contact.accountId ?? null,
                afterValue: String(matchedAccount.id),
                reason: options.reason ?? `Lead-to-account match by ${matchRule}: link contact to account ${matchedAccount.name} (${matchedAccount.id}).`,
                riskLevel: "medium",
                approvalRequired: true,
                sourceRuleOrPolicy: "route.lead_to_account",
            });
            counts.linkOperations += 1;
        }
        let ownerId = null;
        let ownerRule;
        if (inheritAccountOwner &&
            matchedAccount?.ownerId &&
            matchedAccount.ownerId !== contact.ownerId &&
            (!contact.ownerId || reassignExistingOwner) &&
            knownOwners.has(matchedAccount.ownerId)) {
            ownerId = matchedAccount.ownerId;
            ownerRule = "account-owner";
        }
        else if (options.assignmentPolicy && !contact.ownerId) {
            const assigned = resolveAssignment(options.assignmentPolicy, routeContext(contact, matchedAccount), policyAssignmentIndex, knownOwners);
            policyAssignmentIndex += 1;
            ownerId = assigned.ownerId;
            ownerRule = assigned.rule;
            if (ownerId)
                counts.policyAssigned += 1;
        }
        if (ownerId && ownerId !== contact.ownerId) {
            contactOps.push({
                id: `op_${stableHash(`route:owner:${contact.id}:${ownerId}`)}`,
                objectType: "contact",
                objectId: String(contact.id),
                operation: "set_field",
                field: "ownerId",
                beforeValue: contact.ownerId ?? null,
                afterValue: ownerId,
                reason: options.reason ?? `Route contact owner by ${ownerRule ?? "policy"}${matchedAccount ? ` after matching account ${matchedAccount.name}` : ""}.`,
                riskLevel: "medium",
                approvalRequired: true,
                sourceRuleOrPolicy: "route.owner_assignment",
            });
            counts.ownerOperations += 1;
            counts.ownerAssigned = counts.ownerOperations;
        }
        if (contactOps.length > 1) {
            const groupId = `grp_route_${contact.id}`;
            for (const operation of contactOps)
                operation.groupId = groupId;
        }
        operations.push(...contactOps);
        if (!matchedAccount)
            counts.unmatched += 1;
    }
    if (operations.length > maxOperations) {
        throw new Error(`route would create ${operations.length} operations — above the ${maxOperations}-operation safety cap. Raise --max-operations after reviewing scope.`);
    }
    const plan = {
        id: `patch_plan_${stableHash(`route:${snapshot.provider}:${snapshot.generatedAt}:${operations.map((op) => op.id).join(",")}`)}`,
        title: "Route leads: match contacts to accounts and owners",
        createdAt: snapshot.generatedAt,
        status: operations.length > 0 ? "needs_approval" : "draft",
        dryRun: true,
        summary: `${counts.matchedContacts} matched contact(s), ${counts.linkOperations} lead-to-account link(s), ${counts.ownerOperations} owner assignment(s), ${counts.ambiguousAccountMatches} ambiguous match(es), ${counts.unmatched} unmatched contact(s). Dry-run only; approve before apply.`,
        findings: [],
        operations,
    };
    return { plan, counts };
}
