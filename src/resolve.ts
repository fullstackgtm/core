import { normalizeDomain } from "./merge.ts";
import type { CanonicalGtmSnapshot } from "./types.ts";

/**
 * The resolve gate — the Prevent layer of the CRM-health lifecycle.
 *
 * Before any writer (sync job, webhook handler, agent, this CLI's own
 * `create:` path) creates a record, it should ask: does this record already
 * exist? The gate answers deterministically from a snapshot using the same
 * identity keys the audit and merge engines use:
 *
 *   account → normalized domain (exact), then normalized name
 *   contact → normalized email (exact), then full name
 *   deal    → open-deal key: (accountId | "unlinked") + normalized name
 *
 * Verdicts are gate-shaped: `exists` (link to it, don't create),
 * `ambiguous` (a human must pick — do NOT blind-create), `safe_to_create`.
 */

export type ResolveCandidate = {
  objectType: "account" | "contact" | "deal";
  name?: string;
  domain?: string;
  email?: string;
  /** For deals: scope the duplicate key to an account. */
  accountId?: string;
};

export type ResolveMatch = {
  id: string;
  name: string;
  matchedBy: "domain" | "email" | "name" | "deal_key";
  detail: string;
};

export type ResolveResult = {
  objectType: ResolveCandidate["objectType"];
  verdict: "exists" | "ambiguous" | "safe_to_create";
  matches: ResolveMatch[];
  reason: string;
};

export function resolveRecord(
  snapshot: CanonicalGtmSnapshot,
  candidate: ResolveCandidate,
): ResolveResult {
  if (candidate.objectType === "account") return resolveAccount(snapshot, candidate);
  if (candidate.objectType === "contact") return resolveContact(snapshot, candidate);
  return resolveDeal(snapshot, candidate);
}

function resolveAccount(snapshot: CanonicalGtmSnapshot, c: ResolveCandidate): ResolveResult {
  const base = { objectType: "account" as const };
  const domain = normalizeDomain(c.domain);
  if (domain) {
    const matches = snapshot.accounts
      .filter((a) => normalizeDomain(a.domain) === domain)
      .map((a) => match(a.id, a.name, "domain", `account domain ${a.domain} normalizes to ${domain}`));
    if (matches.length === 1) {
      return { ...base, verdict: "exists", matches, reason: `An account with domain ${domain} already exists: "${matches[0].name}" (${matches[0].id}). Link to it instead of creating.` };
    }
    if (matches.length > 1) {
      return { ...base, verdict: "ambiguous", matches, reason: `${matches.length} accounts already share domain ${domain} — that's a duplicate group; merge it before adding more. Do not create.` };
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

function resolveContact(snapshot: CanonicalGtmSnapshot, c: ResolveCandidate): ResolveResult {
  const base = { objectType: "contact" as const };
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

function resolveDeal(snapshot: CanonicalGtmSnapshot, c: ResolveCandidate): ResolveResult {
  const base = { objectType: "deal" as const };
  if (!c.name) {
    return { ...base, verdict: "ambiguous", matches: [], reason: "Supply --name (and ideally --account-id) to resolve a deal." };
  }
  const key = `${c.accountId ?? "unlinked"}:${normalizeName(c.name)}`;
  const open = snapshot.deals.filter((d) => d.isClosed !== true && d.isWon !== true);
  const matches = open
    .filter((d) => `${d.accountId ?? "unlinked"}:${normalizeName(d.name)}` === key)
    .map((d) => match(d.id, d.name, "deal_key", `open deal with the same name on ${c.accountId ? `account ${c.accountId}` : "no account"}`));
  if (matches.length > 0) {
    return {
      ...base,
      verdict: "exists",
      matches,
      reason: `${matches.length} open deal(s) already match "${c.name}" on ${c.accountId ? `account ${c.accountId}` : "unlinked"} — creating another would double-count pipeline. Update the existing deal.`,
    };
  }
  const closedSameName = snapshot.deals.filter(
    (d) => (d.isClosed === true || d.isWon === true) && normalizeName(d.name) === normalizeName(c.name!),
  );
  return {
    ...base,
    verdict: "safe_to_create",
    matches: [],
    reason: closedSameName.length > 0
      ? `No open deal matches; ${closedSameName.length} closed deal(s) share the name (a re-open/renewal may be intended). Safe to create.`
      : `No open deal matches "${c.name}". Safe to create.`,
  };
}

function contactName(row: { firstName?: string; lastName?: string }) {
  return [row.firstName, row.lastName].filter(Boolean).join(" ") || "(unnamed)";
}

function normalizeName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function match(id: string, name: string, matchedBy: ResolveMatch["matchedBy"], detail: string): ResolveMatch {
  return { id, name, matchedBy, detail };
}
