import { normalizeDomain } from "./merge.js";
function rawString(account, keys) {
    if (!account.raw || typeof account.raw !== "object")
        return undefined;
    const raw = account.raw;
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
        if (value && typeof value === "object") {
            const nested = value;
            for (const nestedKey of ["id", "value", "name"]) {
                if (typeof nested[nestedKey] === "string" && String(nested[nestedKey]).trim())
                    return String(nested[nestedKey]).trim();
            }
        }
    }
    return undefined;
}
function parentHint(account) {
    return rawString(account, ["parentAccountId", "parent_account_id", "ParentId", "parentCompanyId", "hs_parent_company_id"]);
}
function cloneNode(account) {
    return { accountId: String(account.id), name: account.name, ...(account.domain ? { domain: account.domain } : {}), children: [] };
}
function looksLikePublicSuffix(domain) {
    const parts = domain.split(".");
    if (parts.length !== 2)
        return false;
    const [label, tld] = parts;
    return tld.length === 2 && ["ac", "co", "com", "edu", "gov", "net", "org"].includes(label);
}
function domainParent(childDomain, domains) {
    const parts = childDomain.split(".");
    for (let i = 1; i < parts.length - 1; i++) {
        const candidate = parts.slice(i).join(".");
        if (candidate.split(".").length < 2 || looksLikePublicSuffix(candidate))
            continue;
        const unique = new Map((domains.get(candidate) ?? []).map((account) => [String(account.id), account]));
        if (unique.size > 1)
            return "ambiguous";
        if (unique.size === 1)
            return [...unique.values()][0];
    }
    return null;
}
function detectCycles(parentByChild) {
    const cyclic = new Set();
    const cycles = [];
    const emitted = new Set();
    for (const start of parentByChild.keys()) {
        const path = [];
        const indexById = new Map();
        let cursor = start;
        while (cursor && parentByChild.has(cursor)) {
            const seenAt = indexById.get(cursor);
            if (seenAt !== undefined) {
                const cycle = path.slice(seenAt);
                for (const id of cycle)
                    cyclic.add(id);
                const key = [...cycle].sort().join("|");
                if (!emitted.has(key)) {
                    emitted.add(key);
                    cycles.push(cycle);
                }
                break;
            }
            indexById.set(cursor, path.length);
            path.push(cursor);
            cursor = parentByChild.get(cursor)?.parentId;
        }
    }
    return { accountIds: cyclic, cycles };
}
export function buildAccountHierarchy(snapshot) {
    const byId = new Map(snapshot.accounts.map((account) => [String(account.id), account]));
    const accounts = [...byId.values()];
    const domains = new Map();
    for (const account of accounts) {
        const domain = normalizeDomain(account.domain);
        if (domain)
            domains.set(domain, [...(domains.get(domain) ?? []), account]);
    }
    const conflicts = [];
    for (const [domain, accounts] of domains) {
        const ids = [...new Set(accounts.map((account) => String(account.id)))];
        if (ids.length > 1)
            conflicts.push({ type: "duplicate_domain", accountIds: ids.sort(), key: domain, detail: `${ids.length} accounts share domain ${domain}; hierarchy inference will not choose between them.` });
    }
    const nodes = new Map(accounts.map((account) => [String(account.id), cloneNode(account)]));
    const parentByChild = new Map();
    for (const account of accounts) {
        const id = String(account.id);
        const hint = parentHint(account);
        if (hint && byId.has(hint) && hint !== id) {
            parentByChild.set(id, { parentId: hint, reason: "provider-parent" });
            continue;
        }
        const domain = normalizeDomain(account.domain);
        if (!domain)
            continue;
        const inferred = domainParent(domain, domains);
        if (inferred === "ambiguous")
            conflicts.push({ type: "ambiguous_parent", accountIds: [id], key: domain, detail: `Multiple possible parent accounts found for ${domain}; leaving account as a root.` });
        else if (inferred && String(inferred.id) !== id)
            parentByChild.set(id, { parentId: String(inferred.id), reason: "domain-subdomain" });
    }
    const cyclicAccounts = detectCycles(parentByChild);
    for (const cycle of cyclicAccounts.cycles) {
        const ordered = [...cycle].sort();
        const key = ordered.join(" -> ");
        conflicts.push({
            type: "cycle",
            accountIds: ordered,
            key,
            detail: `Cyclic parent hints detected among ${ordered.join(", ")}; leaving those accounts as roots instead of hiding them in a loop.`,
        });
    }
    for (const accountId of cyclicAccounts.accountIds)
        parentByChild.delete(accountId);
    const roots = [];
    const orphanAccounts = [];
    const linkedChildren = new Set();
    for (const account of accounts) {
        const id = String(account.id);
        const node = nodes.get(id);
        const parent = parentByChild.get(id);
        if (parent && nodes.has(parent.parentId)) {
            node.parentAccountId = parent.parentId;
            node.parentReason = parent.reason;
            nodes.get(parent.parentId).children.push(node);
            linkedChildren.add(id);
        }
        else {
            roots.push(node);
            if (!account.domain && !parentHint(account))
                orphanAccounts.push(id);
        }
    }
    const sortTree = (list) => {
        list.sort((a, b) => a.name.localeCompare(b.name) || a.accountId.localeCompare(b.accountId));
        for (const node of list)
            sortTree(node.children);
    };
    sortTree(roots);
    return { generatedAt: snapshot.generatedAt, roots, orphanAccounts: orphanAccounts.sort(), conflicts, counts: { accounts: accounts.length, roots: roots.length, linkedChildren: linkedChildren.size, conflicts: conflicts.length } };
}
export function accountHierarchyToMarkdown(report) {
    const lines = ["# Account hierarchy", "", `${report.counts.accounts} account(s), ${report.counts.roots} root(s), ${report.counts.linkedChildren} inferred child link(s), ${report.counts.conflicts} conflict(s).`, ""];
    const walk = (nodes, depth) => {
        for (const node of nodes) {
            const suffix = [node.domain, node.parentReason ? `via ${node.parentReason}` : undefined].filter(Boolean).join("; ");
            lines.push(`${"  ".repeat(depth)}- ${node.name} (${node.accountId}${suffix ? ` — ${suffix}` : ""})`);
            walk(node.children, depth + 1);
        }
    };
    walk(report.roots, 0);
    if (report.conflicts.length) {
        lines.push("", "## Conflicts");
        for (const conflict of report.conflicts)
            lines.push(`- ${conflict.type} ${conflict.key}: ${conflict.detail}`);
    }
    return lines.join("\n");
}
