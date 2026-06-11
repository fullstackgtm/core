import { requiresHumanInput } from "./rules.ts";
import type { CanonicalGtmSnapshot, PatchOperation, PatchPlan } from "./types.ts";

/**
 * Deterministic value suggestions for `requires_human_*` placeholder
 * operations. The engine never invents data: every suggestion is derived
 * from evidence already in the snapshot (account names, contact→account
 * associations, the org's user list) and carries a confidence level plus a
 * human-readable reason, so a reviewer — or an agent driving the CLI — can
 * approve in bulk at a chosen confidence threshold.
 *
 * Born from dogfooding: an audit of a real portal produced 30
 * `requires_human_account_selection` placeholders whose answers were all
 * derivable from the snapshot itself.
 */

export type SuggestionConfidence = "high" | "low" | "create" | "none";

export type ValueSuggestion = {
  operationId: string;
  objectType: string;
  objectId: string;
  /** Display name of the object the operation targets (e.g. the deal name). */
  objectName?: string;
  /** The requires_human_* placeholder being filled. */
  placeholder: string;
  /**
   * The value to approve with, or null when no evidence supports one.
   * `create:<Name>` proposes creating the missing record on apply.
   */
  suggestedValue: string | null;
  confidence: SuggestionConfidence;
  reason: string;
};

export function suggestValues(
  plan: PatchPlan,
  snapshot: CanonicalGtmSnapshot,
): ValueSuggestion[] {
  const accountsByNorm = new Map<string, { id: string; name: string }>();
  for (const account of snapshot.accounts) {
    accountsByNorm.set(normalize(account.name), { id: account.id, name: account.name });
  }
  const accountsById = new Map(snapshot.accounts.map((a) => [a.id, a]));
  const contactsByName = new Map<string, { id: string; accountId?: string; name: string }>();
  for (const contact of snapshot.contacts) {
    const name = normalize(`${contact.firstName ?? ""} ${contact.lastName ?? ""}`);
    if (name) contactsByName.set(name, { id: contact.id, accountId: contact.accountId, name });
  }
  const dealsById = new Map(snapshot.deals.map((d) => [d.id, d]));
  const activeUsers = snapshot.users.filter((user) => user.active !== false);

  const suggestions: ValueSuggestion[] = [];
  for (const operation of plan.operations) {
    if (!requiresHumanInput(operation.afterValue)) continue;
    const placeholder = String(operation.afterValue);

    if (placeholder === "requires_human_account_selection" && operation.objectType === "deal") {
      suggestions.push(
        suggestDealAccount(operation, dealsById, accountsByNorm, accountsById, contactsByName),
      );
      continue;
    }

    if (placeholder === "requires_human_owner_selection" && activeUsers.length === 1) {
      suggestions.push({
        operationId: operation.id,
        objectType: operation.objectType,
        objectId: operation.objectId,
        objectName: dealsById.get(operation.objectId)?.name,
        placeholder,
        suggestedValue: activeUsers[0].id,
        confidence: "high",
        reason: `${activeUsers[0].name} is the only active user in the org.`,
      });
      continue;
    }

    suggestions.push({
      operationId: operation.id,
      objectType: operation.objectType,
      objectId: operation.objectId,
      objectName: dealsById.get(operation.objectId)?.name,
      placeholder,
      suggestedValue: null,
      confidence: "none",
      reason: `No deterministic heuristic for ${placeholder}; supply --value ${operation.id}=<value>.`,
    });
  }
  return suggestions;
}

function suggestDealAccount(
  operation: PatchOperation,
  dealsById: Map<string, { name: string }>,
  accountsByNorm: Map<string, { id: string; name: string }>,
  accountsById: Map<string, { id: string; name: string }>,
  contactsByName: Map<string, { id: string; accountId?: string; name: string }>,
): ValueSuggestion {
  const deal = dealsById.get(operation.objectId);
  const base = {
    operationId: operation.id,
    objectType: operation.objectType,
    objectId: operation.objectId,
    objectName: deal?.name,
    placeholder: "requires_human_account_selection",
  };
  if (!deal) {
    return { ...base, suggestedValue: null, confidence: "none", reason: "Deal not found in the snapshot." };
  }

  // Convention: "Contact Name - Company Name". Both signals below are
  // independent; agreement upgrades confidence, conflict downgrades it.
  const separatorIndex = deal.name.indexOf(" - ");
  const left = separatorIndex >= 0 ? deal.name.slice(0, separatorIndex) : deal.name;
  const right = separatorIndex >= 0 ? deal.name.slice(separatorIndex + 3).trim() : "";

  // Signal 1: company-name match against account names.
  let nameMatch: { id: string; name: string } | null = null;
  let nameMatchKind = "";
  if (right) {
    nameMatch = accountsByNorm.get(normalize(right)) ?? null;
    nameMatchKind = nameMatch ? "exact name match" : "";
    if (!nameMatch) {
      const rightNorm = normalize(right);
      const candidates = [...accountsByNorm.entries()].filter(
        ([norm]) => norm.includes(rightNorm) || rightNorm.includes(norm),
      );
      if (candidates.length === 1) {
        nameMatch = candidates[0][1];
        nameMatchKind = "partial name match";
      } else if (candidates.length > 1) {
        return {
          ...base,
          suggestedValue: null,
          confidence: "none",
          reason: `"${right}" matches ${candidates.length} accounts ambiguously: ${candidates.slice(0, 4).map(([, a]) => a.name).join(", ")}.`,
        };
      }
    }
  }

  // Signal 2: the deal's named contact already belongs to an account.
  const contact = contactsByName.get(normalize(left));
  const contactAccount = contact?.accountId ? accountsById.get(contact.accountId) ?? null : null;

  if (nameMatch && contactAccount) {
    if (nameMatch.id === contactAccount.id) {
      return {
        ...base,
        suggestedValue: nameMatch.id,
        confidence: "high",
        reason: `${nameMatchKind} on "${nameMatch.name}", confirmed by contact "${left}"'s account association.`,
      };
    }
    return {
      ...base,
      suggestedValue: null,
      confidence: "none",
      reason: `Signals conflict: name matches "${nameMatch.name}" but contact "${left}" belongs to "${contactAccount.name}".`,
    };
  }
  if (nameMatch) {
    return {
      ...base,
      suggestedValue: nameMatch.id,
      confidence: nameMatchKind === "exact name match" ? "high" : "low",
      reason: `${nameMatchKind} on "${nameMatch.name}" (no contact signal to confirm).`,
    };
  }
  if (contactAccount) {
    return {
      ...base,
      suggestedValue: contactAccount.id,
      confidence: "low",
      reason: `Contact "${left}" belongs to "${contactAccount.name}" (no account-name match to confirm).`,
    };
  }
  if (contact && !contact.accountId && right) {
    return {
      ...base,
      suggestedValue: `create:${right}`,
      confidence: "create",
      reason: `No account named "${right}" exists and contact "${left}" has none — approving creates the company, then links.`,
    };
  }
  return {
    ...base,
    suggestedValue: null,
    confidence: "none",
    reason: right
      ? `No account matches "${right}" and "${left}" is not a known contact. Supply --value ${operation.id}=<accountId> or --value ${operation.id}=create:<Company Name>.`
      : `Deal name "${deal.name}" has no "Contact - Company" pattern to derive a company from. Supply --value ${operation.id}=<accountId> or create:<Company Name>.`,
  };
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
