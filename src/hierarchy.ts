import { normalizeDomain } from "./merge.ts";
import { stableHash } from "./rules.ts";
import { accountParentId, accountsShareKnownFamily } from "./accountFamily.ts";
import type { CanonicalAccount, CanonicalGtmSnapshot, PatchPlan } from "./types.ts";

export type AccountHierarchyNode = {
  accountId: string;
  name: string;
  domain?: string;
  parentAccountId?: string;
  parentReason?: string;
  children: AccountHierarchyNode[];
};

export type AccountHierarchyConflict = {
  type: "duplicate_domain" | "related_shared_domain" | "ambiguous_parent" | "cycle";
  accountIds: string[];
  key: string;
  detail: string;
};

export type AccountHierarchyReport = {
  generatedAt: string;
  roots: AccountHierarchyNode[];
  orphanAccounts: string[];
  conflicts: AccountHierarchyConflict[];
  counts: { accounts: number; roots: number; linkedChildren: number; conflicts: number };
};

function cloneNode(account: CanonicalAccount): AccountHierarchyNode {
  return { accountId: String(account.id), name: account.name, ...(account.domain ? { domain: account.domain } : {}), children: [] };
}

function looksLikePublicSuffix(domain: string): boolean {
  const parts = domain.split(".");
  if (parts.length !== 2) return false;
  const [label, tld] = parts;
  return tld.length === 2 && ["ac", "co", "com", "edu", "gov", "net", "org"].includes(label);
}

function domainParent(childDomain: string, domains: Map<string, CanonicalAccount[]>): CanonicalAccount | "ambiguous" | null {
  const parts = childDomain.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    if (candidate.split(".").length < 2 || looksLikePublicSuffix(candidate)) continue;
    const unique = new Map((domains.get(candidate) ?? []).map((account) => [String(account.id), account]));
    if (unique.size > 1) return "ambiguous";
    if (unique.size === 1) return [...unique.values()][0];
  }
  return null;
}

function detectCycles(parentByChild: Map<string, { parentId: string; reason: string }>): { accountIds: Set<string>; cycles: string[][] } {
  const cyclic = new Set<string>();
  const cycles: string[][] = [];
  const emitted = new Set<string>();

  for (const start of parentByChild.keys()) {
    const path: string[] = [];
    const indexById = new Map<string, number>();
    let cursor: string | undefined = start;
    while (cursor && parentByChild.has(cursor)) {
      const seenAt = indexById.get(cursor);
      if (seenAt !== undefined) {
        const cycle = path.slice(seenAt);
        for (const id of cycle) cyclic.add(id);
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

export function buildAccountHierarchy(snapshot: CanonicalGtmSnapshot): AccountHierarchyReport {
  const byId = new Map(snapshot.accounts.map((account) => [String(account.id), account]));
  const accounts = [...byId.values()];
  const domains = new Map<string, CanonicalAccount[]>();
  for (const account of accounts) {
    const domain = normalizeDomain(account.domain);
    if (domain) domains.set(domain, [...(domains.get(domain) ?? []), account]);
  }

  const conflicts: AccountHierarchyConflict[] = [];
  for (const [domain, accounts] of domains) {
    const ids = [...new Set(accounts.map((account) => String(account.id)))];
    if (ids.length > 1) {
      const related = accountsShareKnownFamily(accounts);
      conflicts.push({
        type: related ? "related_shared_domain" : "duplicate_domain",
        accountIds: ids.sort(),
        key: domain,
        detail: related
          ? `${ids.length} related accounts share domain ${domain}; preserving them as distinct family members.`
          : `${ids.length} accounts share domain ${domain}; review whether they are duplicates or intentional business units.`,
      });
    }
  }

  const nodes = new Map(accounts.map((account) => [String(account.id), cloneNode(account)]));
  const parentByChild = new Map<string, { parentId: string; reason: string }>();
  for (const account of accounts) {
    const id = String(account.id);
    const hint = accountParentId(account);
    if (hint && byId.has(hint) && hint !== id) {
      parentByChild.set(id, { parentId: hint, reason: "provider-parent" });
      continue;
    }
    const domain = normalizeDomain(account.domain);
    if (!domain) continue;
    const inferred = domainParent(domain, domains);
    if (inferred === "ambiguous") conflicts.push({ type: "ambiguous_parent", accountIds: [id], key: domain, detail: `Multiple possible parent accounts found for ${domain}; leaving account as a root.` });
    else if (inferred && String(inferred.id) !== id) parentByChild.set(id, { parentId: String(inferred.id), reason: "domain-subdomain" });
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
  for (const accountId of cyclicAccounts.accountIds) parentByChild.delete(accountId);

  const roots: AccountHierarchyNode[] = [];
  const orphanAccounts: string[] = [];
  const linkedChildren = new Set<string>();
  for (const account of accounts) {
    const id = String(account.id);
    const node = nodes.get(id)!;
    const parent = parentByChild.get(id);
    if (parent && nodes.has(parent.parentId)) {
      node.parentAccountId = parent.parentId;
      node.parentReason = parent.reason;
      nodes.get(parent.parentId)!.children.push(node);
      linkedChildren.add(id);
    } else {
      roots.push(node);
      if (!account.domain && !accountParentId(account)) orphanAccounts.push(id);
    }
  }
  const sortTree = (list: AccountHierarchyNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name) || a.accountId.localeCompare(b.accountId));
    for (const node of list) sortTree(node.children);
  };
  sortTree(roots);
  return { generatedAt: snapshot.generatedAt, roots, orphanAccounts: orphanAccounts.sort(), conflicts, counts: { accounts: accounts.length, roots: roots.length, linkedChildren: linkedChildren.size, conflicts: conflicts.length } };
}

export type ParentLinkPlanOptions = {
  childAccountId: string;
  parentAccountId: string;
  reason?: string;
};

/** Build one governed parent-link proposal. Existing different parents are
 * intentionally refused: re-parenting needs a separate operation that can
 * preserve provider-specific association labels. */
export function buildParentLinkPlan(snapshot: CanonicalGtmSnapshot, options: ParentLinkPlanOptions): PatchPlan {
  const childId = String(options.childAccountId);
  const parentId = String(options.parentAccountId);
  if (childId === parentId) throw new Error("An account cannot be its own parent.");
  const byId = new Map(snapshot.accounts.map((account) => [String(account.id), account]));
  const child = byId.get(childId);
  const parent = byId.get(parentId);
  if (!child) throw new Error(`Unknown child account ${childId}.`);
  if (!parent) throw new Error(`Unknown parent account ${parentId}.`);

  const currentParent = accountParentId(child);
  if (currentParent && currentParent !== parentId) {
    throw new Error(`Account ${childId} already has parent ${currentParent}; refusing to re-parent it implicitly.`);
  }

  let cursor: string | undefined = parentId;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    if (cursor === childId) throw new Error(`Linking ${childId} under ${parentId} would create a hierarchy cycle.`);
    visited.add(cursor);
    const account = byId.get(cursor);
    cursor = account ? accountParentId(account) : undefined;
  }

  const operations = currentParent === parentId ? [] : [{
    id: `op_${stableHash(`parent-link:${childId}:${parentId}`)}`,
    objectType: "account" as const,
    objectId: childId,
    operation: "link_record" as const,
    field: "parentAccountId",
    beforeValue: null,
    afterValue: parentId,
    reason: options.reason ?? `Link ${child.name} (${childId}) as a child of ${parent.name} (${parentId}).`,
    riskLevel: "medium" as const,
    approvalRequired: true,
    sourceRuleOrPolicy: "hierarchy.parent_link",
    rollback: `Remove the parent relationship from ${childId}; no records are merged or deleted.`,
  }];

  return {
    id: `patch_plan_${stableHash(`parent-link:${snapshot.provider}:${snapshot.generatedAt}:${childId}:${parentId}`)}`,
    title: `Parent account: ${child.name} → ${parent.name}`,
    createdAt: snapshot.generatedAt,
    status: operations.length ? "needs_approval" : "draft",
    dryRun: true,
    summary: operations.length
      ? `1 proposed parent link; no accounts will be merged or deleted.`
      : `${child.name} is already a child of ${parent.name}; nothing to change.`,
    findings: [],
    operations,
  };
}

export function accountHierarchyToMarkdown(report: AccountHierarchyReport): string {
  const lines = ["# Account hierarchy", "", `${report.counts.accounts} account(s), ${report.counts.roots} root(s), ${report.counts.linkedChildren} inferred child link(s), ${report.counts.conflicts} conflict(s).`, ""];
  const walk = (nodes: AccountHierarchyNode[], depth: number) => {
    for (const node of nodes) {
      const suffix = [node.domain, node.parentReason ? `via ${node.parentReason}` : undefined].filter(Boolean).join("; ");
      lines.push(`${"  ".repeat(depth)}- ${node.name} (${node.accountId}${suffix ? ` — ${suffix}` : ""})`);
      walk(node.children, depth + 1);
    }
  };
  walk(report.roots, 0);
  if (report.conflicts.length) {
    lines.push("", "## Conflicts");
    for (const conflict of report.conflicts) lines.push(`- ${conflict.type} ${conflict.key}: ${conflict.detail}`);
  }
  return lines.join("\n");
}
