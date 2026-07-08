import { normalizeDomain } from "./merge.js";
function fullName(contact) {
    return [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email || contact.id;
}
function inferRole(title) {
    const t = (title ?? "").toLowerCase();
    if (/\b(cfo|ceo|coo|cro|chief|founder|owner|president)\b/.test(t))
        return "economic_buyer";
    if (/\b(vp|vice president|head of|director|gm|general manager)\b/.test(t))
        return "decision_maker";
    if (/\b(cto|cio|security|it|engineering|architect|developer|technical|data)\b/.test(t))
        return "technical_buyer";
    if (/\b(champion|revops|sales ops|revenue operations|operations)\b/.test(t))
        return "champion";
    if (t)
        return "influencer";
    return "unknown";
}
function inferSentiment(text) {
    const lower = text.toLowerCase();
    if (/\b(blocked|concern|risk|no budget|not interested|detractor|negative|unhappy)\b/.test(lower))
        return "negative";
    if (/\b(champion|excited|interested|positive|approved|referred|next step|pilot)\b/.test(lower))
        return "positive";
    return "neutral";
}
function maxSentiment(a, b) {
    const rank = { unknown: 0, neutral: 1, positive: 2, negative: 3 };
    return rank[b] > rank[a] ? b : a;
}
function findAccount(snapshot, selector) {
    if (selector.accountId)
        return snapshot.accounts.find((account) => String(account.id) === selector.accountId) ?? null;
    if (selector.domain) {
        const domain = normalizeDomain(selector.domain);
        return snapshot.accounts.find((account) => normalizeDomain(account.domain) === domain) ?? null;
    }
    return null;
}
export function buildRelationshipMap(snapshot, selector) {
    const account = findAccount(snapshot, selector);
    if (!account)
        throw new Error("relationships: account not found (use --account-id or --domain)");
    const contacts = snapshot.contacts.filter((contact) => contact.accountId === account.id);
    const contactIds = new Set(contacts.map((contact) => contact.id));
    const activities = snapshot.activities.filter((activity) => activity.accountId === account.id || (activity.contactId ? contactIds.has(activity.contactId) : false));
    const evidenceByContact = new Map();
    const sentimentByContact = new Map();
    for (const activity of activities) {
        if (!activity.contactId || !contactIds.has(activity.contactId))
            continue;
        const text = [activity.subject, activity.type, activity.occurredAt].filter(Boolean).join(" — ");
        evidenceByContact.set(activity.contactId, [...(evidenceByContact.get(activity.contactId) ?? []), text]);
        sentimentByContact.set(activity.contactId, maxSentiment(sentimentByContact.get(activity.contactId) ?? "unknown", inferSentiment(text)));
    }
    const stakeholders = contacts.map((contact) => ({
        contactId: String(contact.id),
        name: fullName(contact),
        ...(contact.title ? { title: contact.title } : {}),
        ...(contact.email ? { email: contact.email } : {}),
        role: inferRole(contact.title),
        sentiment: sentimentByContact.get(contact.id) ?? "unknown",
        ...(contact.lastActivityAt ? { lastActivityAt: contact.lastActivityAt } : {}),
        evidence: evidenceByContact.get(contact.id) ?? [],
    })).sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
    const openDeals = snapshot.deals.filter((deal) => deal.accountId === account.id && !deal.isClosed).map((deal) => ({
        dealId: String(deal.id),
        name: deal.name,
        ...(deal.stage ? { stage: deal.stage } : {}),
        ...(deal.amount !== undefined ? { amount: deal.amount } : {}),
        ...(deal.ownerId ? { ownerId: deal.ownerId } : {}),
    }));
    const roles = new Set(stakeholders.map((s) => s.role));
    const gaps = [];
    if (!roles.has("economic_buyer"))
        gaps.push("No obvious economic buyer found from titles.");
    if (!roles.has("decision_maker"))
        gaps.push("No obvious decision maker found from titles.");
    if (stakeholders.every((s) => s.sentiment === "unknown"))
        gaps.push("No stakeholder activity evidence attached to this account.");
    return { account: { accountId: String(account.id), name: account.name, ...(account.domain ? { domain: account.domain } : {}) }, stakeholders, openDeals, gaps, counts: { stakeholders: stakeholders.length, openDeals: openDeals.length, activities: activities.length } };
}
export function relationshipMapToMarkdown(map) {
    const lines = [`# Relationship map: ${map.account.name}`, "", `${map.counts.stakeholders} stakeholder(s), ${map.counts.openDeals} open deal(s), ${map.counts.activities} activity record(s).`, "", "## Stakeholders"];
    for (const s of map.stakeholders) {
        lines.push(`- ${s.name} — ${s.role}, ${s.sentiment}${s.title ? ` (${s.title})` : ""}`);
        for (const evidence of s.evidence.slice(0, 3))
            lines.push(`  - evidence: ${evidence}`);
    }
    if (map.openDeals.length) {
        lines.push("", "## Open deals");
        for (const deal of map.openDeals)
            lines.push(`- ${deal.name} (${deal.dealId})${deal.stage ? ` — ${deal.stage}` : ""}${deal.amount !== undefined ? ` — ${deal.amount}` : ""}`);
    }
    if (map.gaps.length) {
        lines.push("", "## Gaps");
        for (const gap of map.gaps)
            lines.push(`- ${gap}`);
    }
    return lines.join("\n");
}
