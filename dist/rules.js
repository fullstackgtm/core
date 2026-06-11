import { normalizeDomain } from "./merge.js";
/**
 * Placeholder used as `afterValue` when the right value is a human decision
 * (e.g. which owner to assign). Apply orchestration refuses to write these
 * unless an explicit override value is supplied at approval time.
 */
export const REQUIRES_HUMAN_PREFIX = "requires_human_";
export function requiresHumanInput(value) {
    return typeof value === "string" && value.startsWith(REQUIRES_HUMAN_PREFIX);
}
/**
 * Attribution for duplicate groups: when the provider exposes record-source
 * provenance (RecordProvenance), name the writer(s) that created the group —
 * the fix for recurring dupes is upstream in the writer, not in the records.
 */
export function provenanceSummary(records) {
    const counts = new Map();
    for (const record of records) {
        const p = record.provenance;
        if (!p)
            continue;
        const label = p.sourceLabel ?? p.source ?? "unknown source";
        const key = p.sourceId ? `${label} (${p.sourceId})` : label;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (counts.size === 0)
        return "";
    const parts = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => (count > 1 ? `${key} ×${count}` : key));
    return ` Created by: ${parts.join(", ")}.`;
}
export function auditFindingId(ruleId, objectId) {
    return `finding_${stableHash(`${ruleId}:${objectId}`)}`;
}
export function patchOperationId(ruleId, objectId) {
    return `op_${stableHash(`${ruleId}:${objectId}`)}`;
}
export function stableHash(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
    }
    return hash.toString(36);
}
export function buildSnapshotIndex(snapshot) {
    const contactsByAccountId = new Map();
    const dealsByAccountId = new Map();
    const activitiesByDealId = new Map();
    for (const contact of snapshot.contacts) {
        if (!contact.accountId)
            continue;
        const existing = contactsByAccountId.get(contact.accountId) ?? [];
        existing.push(contact);
        contactsByAccountId.set(contact.accountId, existing);
    }
    for (const deal of snapshot.deals) {
        if (!deal.accountId)
            continue;
        const existing = dealsByAccountId.get(deal.accountId) ?? [];
        existing.push(deal);
        dealsByAccountId.set(deal.accountId, existing);
    }
    for (const activity of snapshot.activities) {
        if (!activity.dealId)
            continue;
        const existing = activitiesByDealId.get(activity.dealId) ?? [];
        existing.push(activity);
        activitiesByDealId.set(activity.dealId, existing);
    }
    return {
        usersById: new Map(snapshot.users.map((user) => [user.id, user])),
        accountsById: new Map(snapshot.accounts.map((account) => [account.id, account])),
        contactsByAccountId,
        dealsByAccountId,
        activitiesByDealId,
    };
}
function isOpen(deal) {
    return deal.isClosed !== true && deal.isWon !== true;
}
function dealFinding(deal, ruleId, title) {
    return {
        id: auditFindingId(ruleId, deal.id),
        objectType: "deal",
        objectId: deal.id,
        ruleId,
        title,
        severity: "warning",
        summary: `${deal.name} violates ${ruleId.replace(/-/g, " ")} policy.`,
        recommendation: "Review the proposed patch operation and approve an explicit CRM update.",
    };
}
function staleDays(deal, today) {
    const reference = deal.lastActivityAt ?? deal.lastSyncAt ?? deal.closeDate;
    if (!reference)
        return 0;
    return Math.max(0, daysBetween(reference, today));
}
function daysBetween(start, end) {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs))
        return 0;
    return Math.floor((endMs - startMs) / 86_400_000);
}
function compareDate(left, right) {
    return Date.parse(left) - Date.parse(right);
}
function riskForStaleness(days) {
    if (days >= 90)
        return "high";
    if (days >= 45)
        return "medium";
    return "low";
}
export const orphanAccountRule = {
    id: "orphan-account",
    title: "Account has no contacts or deals",
    description: "Flags accounts not connected to any contact or opportunity so someone owns the next action.",
    category: "hygiene",
    evaluate: ({ snapshot, index }) => {
        const findings = [];
        const operations = [];
        for (const account of snapshot.accounts) {
            const contacts = index.contactsByAccountId.get(account.id) ?? [];
            const deals = index.dealsByAccountId.get(account.id) ?? [];
            if (contacts.length > 0 || deals.length > 0)
                continue;
            findings.push({
                id: auditFindingId("orphan-account", account.id),
                objectType: "account",
                objectId: account.id,
                ruleId: "orphan-account",
                title: "Account has no contacts or deals",
                severity: "warning",
                summary: `${account.name} is not connected to any contact or open opportunity.`,
                recommendation: "Review whether the account should be enriched, assigned for research, or archived.",
            });
            operations.push({
                id: patchOperationId("orphan-account", account.id),
                objectType: "account",
                objectId: account.id,
                operation: "create_task",
                field: "follow_up_task",
                beforeValue: null,
                afterValue: "Research account fit and decide whether to archive or enrich",
                reason: "Orphan accounts add CRM noise unless someone owns the next action.",
                riskLevel: "low",
                approvalRequired: true,
            });
        }
        return { findings, operations };
    },
};
export const missingDealOwnerRule = {
    id: "missing-deal-owner",
    title: "Deal has no valid owner",
    description: "Flags deals whose owner is missing or not a known user.",
    category: "hygiene",
    evaluate: ({ snapshot, policy, index }) => {
        if (!policy.requireDealOwner)
            return { findings: [], operations: [] };
        const findings = [];
        const operations = [];
        for (const deal of snapshot.deals) {
            if (deal.ownerId && index.usersById.has(deal.ownerId))
                continue;
            findings.push(dealFinding(deal, "missing-deal-owner", "Deal has no valid owner"));
            operations.push({
                id: patchOperationId("missing-deal-owner", deal.id),
                objectType: "deal",
                objectId: deal.id,
                operation: "set_field",
                field: "ownerId",
                beforeValue: deal.ownerId ?? null,
                afterValue: "requires_human_owner_selection",
                reason: "Every open opportunity needs a human owner before the agent can suggest routing.",
                riskLevel: "medium",
                approvalRequired: true,
            });
        }
        return { findings, operations };
    },
};
export const missingDealAccountRule = {
    id: "missing-deal-account",
    title: "Deal is not linked to an account",
    description: "Flags deals that are not associated with a known account.",
    category: "hygiene",
    evaluate: ({ snapshot, policy, index }) => {
        if (!policy.requireAccountForDeal)
            return { findings: [], operations: [] };
        const findings = [];
        const operations = [];
        for (const deal of snapshot.deals) {
            if (deal.accountId && index.accountsById.has(deal.accountId))
                continue;
            findings.push(dealFinding(deal, "missing-deal-account", "Deal is not linked to an account"));
            operations.push({
                id: patchOperationId("missing-deal-account", deal.id),
                objectType: "deal",
                objectId: deal.id,
                operation: "link_record",
                field: "accountId",
                beforeValue: deal.accountId ?? null,
                afterValue: "requires_human_account_selection",
                reason: "Opportunity reporting, ABM, attribution, and forecasting need account context.",
                riskLevel: "medium",
                approvalRequired: true,
            });
        }
        return { findings, operations };
    },
};
export const pastCloseDateRule = {
    id: "past-close-date",
    title: "Open deal has a past close date",
    description: "Flags open deals whose close date is already behind today.",
    category: "hygiene",
    evaluate: ({ snapshot, policy }) => {
        const findings = [];
        const operations = [];
        for (const deal of snapshot.deals) {
            if (!isOpen(deal) || !deal.closeDate)
                continue;
            if (compareDate(deal.closeDate, policy.today) >= 0)
                continue;
            findings.push(dealFinding(deal, "past-close-date", "Open deal has a past close date"));
            operations.push({
                id: patchOperationId("past-close-date", deal.id),
                objectType: "deal",
                objectId: deal.id,
                operation: "set_field",
                field: "closeDate",
                beforeValue: deal.closeDate,
                afterValue: "requires_human_close_date_selection",
                reason: "Past close dates make forecast and pipeline aging unreliable.",
                riskLevel: "medium",
                approvalRequired: true,
            });
        }
        return { findings, operations };
    },
};
export const staleDealRule = {
    id: "stale-deal",
    title: "Deal has stale activity",
    description: "Flags open deals with no recorded activity for longer than the policy's stale window.",
    category: "hygiene",
    evaluate: ({ snapshot, policy }) => {
        const findings = [];
        const operations = [];
        for (const deal of snapshot.deals) {
            if (!isOpen(deal))
                continue;
            const days = staleDays(deal, policy.today);
            if (days <= policy.staleDealDays)
                continue;
            findings.push({
                id: auditFindingId("stale-deal", deal.id),
                objectType: "deal",
                objectId: deal.id,
                ruleId: "stale-deal",
                title: "Deal has stale activity",
                severity: "warning",
                summary: `${deal.name} has had no recorded activity for ${days} days.`,
                recommendation: "Ask the owner to confirm next step, close lost, or update the forecast category.",
            });
            operations.push({
                id: patchOperationId("stale-deal", deal.id),
                objectType: "deal",
                objectId: deal.id,
                operation: "create_task",
                field: "next_step_task",
                beforeValue: null,
                afterValue: "Confirm next step or close out stale opportunity",
                reason: "Stale open pipeline inflates forecast coverage and hides execution risk.",
                riskLevel: riskForStaleness(days),
                approvalRequired: true,
            });
        }
        return { findings, operations };
    },
};
export const missingDealAmountRule = {
    id: "missing-deal-amount",
    title: "Open deal has no amount",
    description: "Flags open deals without an amount; they make forecast coverage meaningless.",
    category: "forecast",
    evaluate: ({ snapshot, policy }) => {
        if (policy.requireDealAmount === false)
            return { findings: [], operations: [] };
        const findings = [];
        const operations = [];
        for (const deal of snapshot.deals) {
            if (!isOpen(deal))
                continue;
            if (deal.amount !== undefined && deal.amount !== 0)
                continue;
            findings.push(dealFinding(deal, "missing-deal-amount", "Open deal has no amount"));
            operations.push({
                id: patchOperationId("missing-deal-amount", deal.id),
                objectType: "deal",
                objectId: deal.id,
                operation: "set_field",
                field: "amount",
                beforeValue: deal.amount ?? null,
                afterValue: "requires_human_amount_selection",
                reason: "Amountless open pipeline understates coverage and breaks weighted forecasts.",
                riskLevel: "medium",
                approvalRequired: true,
            });
        }
        return { findings, operations };
    },
};
function duplicateGroups(items, keyOf) {
    const groups = new Map();
    for (const item of items) {
        const key = keyOf(item)?.trim().toLowerCase();
        if (!key)
            continue;
        const existing = groups.get(key) ?? [];
        existing.push(item);
        groups.set(key, existing);
    }
    for (const [key, members] of Array.from(groups.entries())) {
        if (members.length < 2)
            groups.delete(key);
    }
    return groups;
}
export const duplicateAccountDomainRule = {
    id: "duplicate-account-domain",
    title: "Accounts share the same domain",
    description: "Flags accounts with identical domains — usually duplicates splitting activity, deals, and attribution.",
    category: "data-quality",
    evaluate: ({ snapshot }) => {
        const findings = [];
        const operations = [];
        for (const [domain, accounts] of duplicateGroups(snapshot.accounts, (account) => normalizeDomain(account.domain))) {
            const anchor = accounts[0];
            findings.push({
                id: auditFindingId("duplicate-account-domain", anchor.id),
                objectType: "account",
                objectId: anchor.id,
                ruleId: "duplicate-account-domain",
                title: "Accounts share the same domain",
                severity: "warning",
                summary: `${accounts.length} accounts share ${domain}: ${accounts.map((account) => account.name).join(", ")}.${provenanceSummary(accounts)}`,
                recommendation: "Review the group and merge duplicates so activity and deals roll up once.",
            });
            operations.push({
                id: patchOperationId("duplicate-account-domain", anchor.id),
                objectType: "account",
                objectId: anchor.id,
                operation: "merge_records",
                field: "merge",
                beforeValue: accounts.map((account) => account.id),
                afterValue: "requires_human_survivor_selection",
                reason: `Duplicate accounts split pipeline, attribution, and ownership. Merge the ${accounts.length} accounts sharing ${domain} into one survivor.`,
                riskLevel: "high",
                approvalRequired: true,
                rollback: "IRREVERSIBLE: provider merges cannot be unmerged. The pre-apply snapshot retains every record's field values; recreate a record manually from it if a merge was wrong.",
            });
        }
        return { findings, operations };
    },
};
export const duplicateContactEmailRule = {
    id: "duplicate-contact-email",
    title: "Contacts share the same email",
    description: "Flags contacts with identical emails — duplicates that fragment engagement history and routing.",
    category: "data-quality",
    evaluate: ({ snapshot }) => {
        const findings = [];
        const operations = [];
        for (const [email, contacts] of duplicateGroups(snapshot.contacts, (contact) => contact.email)) {
            const anchor = contacts[0];
            findings.push({
                id: auditFindingId("duplicate-contact-email", anchor.id),
                objectType: "contact",
                objectId: anchor.id,
                ruleId: "duplicate-contact-email",
                title: "Contacts share the same email",
                severity: "warning",
                summary: `${contacts.length} contacts share ${email}.${provenanceSummary(contacts)}`,
                recommendation: "Merge the duplicates so engagement history and routing stay coherent.",
            });
            operations.push({
                id: patchOperationId("duplicate-contact-email", anchor.id),
                objectType: "contact",
                objectId: anchor.id,
                operation: "merge_records",
                field: "merge",
                beforeValue: contacts.map((contact) => contact.id),
                afterValue: "requires_human_survivor_selection",
                reason: `Duplicate contacts fragment engagement history and double-route outreach. Merge the ${contacts.length} contacts sharing ${email} into one survivor.`,
                riskLevel: "high",
                approvalRequired: true,
                rollback: "IRREVERSIBLE: provider merges cannot be unmerged. The pre-apply snapshot retains every record's field values; recreate a record manually from it if a merge was wrong.",
            });
        }
        return { findings, operations };
    },
};
export const duplicateOpenDealRule = {
    id: "duplicate-open-deal",
    title: "Open deals duplicate the same opportunity",
    description: "Flags multiple open deals carrying the same name (scoped to the account when linked) — " +
        "usually an integration re-creating deals instead of upserting, which counts the same " +
        "revenue several times in pipeline and forecast.",
    category: "data-quality",
    evaluate: ({ snapshot }) => {
        const findings = [];
        const operations = [];
        const keyOf = (deal) => {
            if (!isOpen(deal))
                return undefined;
            const name = deal.name?.trim().toLowerCase().replace(/\s+/g, " ");
            if (!name)
                return undefined;
            return `${deal.accountId ?? "unlinked"}:${name}`;
        };
        for (const [, deals] of duplicateGroups(snapshot.deals, keyOf)) {
            const anchor = deals[0];
            findings.push({
                id: auditFindingId("duplicate-open-deal", anchor.id),
                objectType: "deal",
                objectId: anchor.id,
                ruleId: "duplicate-open-deal",
                title: "Open deals duplicate the same opportunity",
                severity: "warning",
                summary: `${deals.length} open deals named "${anchor.name}"${anchor.accountId ? " on the same account" : ""}: ${deals.map((deal) => deal.id).join(", ")}.${provenanceSummary(deals)}`,
                recommendation: "Keep one deal, archive the copies, and fix the integration that is re-creating them.",
            });
            operations.push({
                id: patchOperationId("duplicate-open-deal", anchor.id),
                objectType: "deal",
                objectId: anchor.id,
                operation: "merge_records",
                field: "merge",
                beforeValue: deals.map((deal) => deal.id),
                afterValue: "requires_human_survivor_selection",
                reason: `Duplicate open deals inflate pipeline and forecast the same revenue more than once. Merge the ${deals.length} deals named "${anchor.name}" into one survivor.`,
                riskLevel: "high",
                approvalRequired: true,
                rollback: "IRREVERSIBLE: provider merges cannot be unmerged. The pre-apply snapshot retains every record's field values; recreate a record manually from it if a merge was wrong.",
            });
        }
        return { findings, operations };
    },
};
export const activeDealAccountWithoutContactsRule = {
    id: "active-deal-account-without-contacts",
    title: "Account with open pipeline has no contacts",
    description: "Flags accounts carrying open deals without a single contact — pipeline with nobody to talk to.",
    category: "coverage",
    evaluate: ({ index }) => {
        const findings = [];
        const operations = [];
        for (const [accountId, deals] of index.dealsByAccountId) {
            if (!deals.some(isOpen))
                continue;
            if ((index.contactsByAccountId.get(accountId) ?? []).length > 0)
                continue;
            const account = index.accountsById.get(accountId);
            if (!account)
                continue;
            findings.push({
                id: auditFindingId("active-deal-account-without-contacts", account.id),
                objectType: "account",
                objectId: account.id,
                ruleId: "active-deal-account-without-contacts",
                title: "Account with open pipeline has no contacts",
                severity: "warning",
                summary: `${account.name} has open deals but no contacts on record.`,
                recommendation: "Add the champion and buying-committee contacts before the deal advances.",
            });
            operations.push({
                id: patchOperationId("active-deal-account-without-contacts", account.id),
                objectType: "account",
                objectId: account.id,
                operation: "create_task",
                field: "add_contacts_task",
                beforeValue: null,
                afterValue: "Add champion and buying-committee contacts for the open opportunities",
                reason: "Open pipeline without contacts cannot be advanced, routed, or marketed to.",
                riskLevel: "low",
                approvalRequired: true,
            });
        }
        return { findings, operations };
    },
};
export const closingSoonInactiveRule = {
    id: "closing-soon-inactive",
    title: "Deal closing soon with no recent activity",
    description: "Flags open deals inside the closing-soon window whose last activity is older than the idle threshold.",
    category: "forecast",
    evaluate: ({ snapshot, policy }) => {
        const windowDays = policy.closingSoonDays ?? 14;
        const idleDays = policy.closingSoonIdleDays ?? 7;
        const findings = [];
        const operations = [];
        for (const deal of snapshot.deals) {
            if (!isOpen(deal) || !deal.closeDate)
                continue;
            const daysToClose = daysBetween(policy.today, deal.closeDate);
            if (daysToClose < 0 || daysToClose > windowDays)
                continue;
            const idle = staleDays(deal, policy.today);
            if (idle <= idleDays)
                continue;
            findings.push({
                id: auditFindingId("closing-soon-inactive", deal.id),
                objectType: "deal",
                objectId: deal.id,
                ruleId: "closing-soon-inactive",
                title: "Deal closing soon with no recent activity",
                severity: "critical",
                summary: `${deal.name} closes in ${daysToClose} days but has had no activity for ${idle} days.`,
                recommendation: "Confirm the close plan with the owner today, or move the close date and forecast category.",
            });
            operations.push({
                id: patchOperationId("closing-soon-inactive", deal.id),
                objectType: "deal",
                objectId: deal.id,
                operation: "create_task",
                field: "close_plan_task",
                beforeValue: null,
                afterValue: "Confirm close plan or update close date and forecast category",
                reason: "Deals forecast to close imminently without engagement are silent slip risk.",
                riskLevel: "high",
                approvalRequired: true,
            });
        }
        return { findings, operations };
    },
};
export const accountSingleSourceRule = {
    id: "account-single-source",
    title: "Account exists in only one connected system",
    description: "On merged multi-system snapshots, flags accounts known to just one source — the seams where GTM systems disagree.",
    category: "cross-system",
    evaluate: ({ snapshot }) => {
        const providersSeen = new Set(snapshot.accounts.flatMap((account) => (account.identities ?? []).map((identity) => String(identity.provider))));
        // Only meaningful when the snapshot actually spans systems.
        if (providersSeen.size < 2)
            return { findings: [], operations: [] };
        const findings = [];
        for (const account of snapshot.accounts) {
            const sources = new Set((account.identities ?? []).map((identity) => String(identity.provider)));
            if (sources.size !== 1)
                continue;
            const source = Array.from(sources)[0];
            findings.push({
                id: auditFindingId("account-single-source", account.id),
                objectType: "account",
                objectId: account.id,
                ruleId: "account-single-source",
                title: "Account exists in only one connected system",
                severity: "info",
                summary: `${account.name} exists only in ${source} (${providersSeen.size} systems connected).`,
                recommendation: "Check whether the account is missing from the other systems or matched under a different domain/name.",
            });
        }
        return { findings, operations: [] };
    },
};
export const builtinAuditRules = [
    orphanAccountRule,
    missingDealOwnerRule,
    missingDealAccountRule,
    pastCloseDateRule,
    staleDealRule,
    missingDealAmountRule,
    duplicateAccountDomainRule,
    duplicateContactEmailRule,
    duplicateOpenDealRule,
    activeDealAccountWithoutContactsRule,
    closingSoonInactiveRule,
    accountSingleSourceRule,
];
