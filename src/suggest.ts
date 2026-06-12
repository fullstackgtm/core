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

    if (placeholder === "requires_human_survivor_selection") {
      suggestions.push(suggestSurvivor(operation, snapshot, dealsById));
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

  // Convention 1: "Contact Name - Company Name" (hyphen, en or em dash).
  // Both signals below are independent; agreement upgrades confidence,
  // conflict downgrades it.
  const separator = [" - ", " – ", " — "]
    .map((s) => ({ s, index: deal.name.indexOf(s) }))
    .filter(({ index }) => index >= 0)
    .sort((a, b) => a.index - b.index)[0];
  const left = separator ? deal.name.slice(0, separator.index).trim() : deal.name;
  const right = separator ? deal.name.slice(separator.index + separator.s.length).trim() : "";

  // Convention 2: "Company - Deal descriptor" (e.g. "Globex – Expansion",
  // "Hooli – New Business"). When the right side is purely deal-descriptor
  // words, the company is on the LEFT. Only an exact account-name match
  // counts as high; an unknown left side proposes a create — the engine
  // never guesses at an existing record.
  if (left && right && isDealDescriptor(right)) {
    const leftMatch = accountsByNorm.get(normalize(left));
    if (leftMatch) {
      return {
        ...base,
        suggestedValue: leftMatch.id,
        confidence: "high",
        reason: `Deal name leads with the exact account name "${leftMatch.name}" ("${right}" is a deal descriptor, not a company).`,
      };
    }
    if (!contactsByName.get(normalize(left))) {
      return {
        ...base,
        suggestedValue: `create:${left}`,
        confidence: "create",
        reason: `No account named "${left}" exists ("${right}" is a deal descriptor) — approving creates the company, then links.`,
      };
    }
  }

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
  // Convention 3: "<Company> <descriptor…>" without a separator (e.g.
  // "INITECH renewal"): strip trailing descriptor words and accept only an
  // exact account-name match on what remains.
  if (!separator) {
    const words = normalize(deal.name).split(" ").filter(Boolean);
    while (words.length > 1 && DEAL_DESCRIPTOR_WORDS.has(words[words.length - 1])) words.pop();
    const strippedMatch = words.length > 0 ? accountsByNorm.get(words.join(" ")) : undefined;
    if (strippedMatch) {
      return {
        ...base,
        suggestedValue: strippedMatch.id,
        confidence: "high",
        reason: `Deal name leads with the exact account name "${strippedMatch.name}" (trailing words are deal descriptors).`,
      };
    }
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

/**
 * Words that describe the deal rather than name a company. Used to recognize
 * the "Company - Deal descriptor" naming convention: a segment counts as a
 * descriptor only when EVERY word is in this list, so any real company name
 * ("Brand New Startup") falls through to the contact/company conventions.
 */
const DEAL_DESCRIPTOR_WORDS = new Set([
  "renewal", "expansion", "pilot", "annual", "monthly", "platform", "new", "business",
  "add", "on", "addon", "upsell", "upgrade", "trial", "poc", "proof", "concept",
  "subscription", "license", "licence", "contract", "opportunity", "deal", "engagement",
  "implementation", "onboarding", "services", "inbound", "outbound",
  "q1", "q2", "q3", "q4",
]);

function isDealDescriptor(segment: string): boolean {
  const words = normalize(segment).split(" ").filter(Boolean);
  return words.length > 0 && words.every((word) => DEAL_DESCRIPTOR_WORDS.has(word));
}

/**
 * Survivor selection for merge_records. Ranking is deterministic and
 * evidence-based: most complete record first (count of populated canonical
 * fields), most recent activity as the tiebreaker, group order last.
 * Confidence is capped at "low" by design: merges are irreversible, so a
 * survivor suggestion must never clear the default bulk-approval bar —
 * accepting one requires --min-confidence low or an explicit --value.
 */
function suggestSurvivor(
  operation: PatchOperation,
  snapshot: CanonicalGtmSnapshot,
  dealsById: Map<string, { name: string }>,
): ValueSuggestion {
  const base = {
    operationId: operation.id,
    objectType: operation.objectType,
    objectId: operation.objectId,
    objectName: dealsById.get(operation.objectId)?.name,
    placeholder: "requires_human_survivor_selection",
  };
  const groupIds = Array.isArray(operation.beforeValue)
    ? operation.beforeValue.map((id) => String(id))
    : [];
  if (groupIds.length < 2) {
    return {
      ...base,
      suggestedValue: null,
      confidence: "none",
      reason: "Operation does not carry a duplicate group (expected ids in beforeValue).",
    };
  }
  const collection =
    operation.objectType === "account"
      ? snapshot.accounts
      : operation.objectType === "contact"
        ? snapshot.contacts
        : operation.objectType === "deal"
          ? snapshot.deals
          : [];
  const records = groupIds
    .map((id) => collection.find((row) => row.id === id))
    .filter((row): row is NonNullable<typeof row> => row !== undefined);
  if (records.length !== groupIds.length) {
    return {
      ...base,
      suggestedValue: null,
      confidence: "none",
      reason: "Not every group member is present in the snapshot; re-run the audit before merging.",
    };
  }
  const ranked = [...records].sort((a, b) => {
    const completeness = populatedFields(b) - populatedFields(a);
    if (completeness !== 0) return completeness;
    return activityMs(b) - activityMs(a);
  });
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const name = "name" in winner && typeof winner.name === "string" ? winner.name : winner.id;
  return {
    ...base,
    suggestedValue: winner.id,
    confidence: "low",
    reason:
      `"${name}" (${winner.id}) is the most complete record in the group ` +
      `(${populatedFields(winner)} populated fields vs ${populatedFields(runnerUp)}` +
      `${activityMs(winner) > activityMs(runnerUp) ? ", and more recent activity" : ""}). ` +
      `Merging is IRREVERSIBLE — survivor suggestions never exceed low confidence; ` +
      `approve with --min-confidence low or an explicit --value after review.`,
  };
}

function populatedFields(record: object) {
  return Object.values(record).filter(
    (value) => value !== undefined && value !== null && value !== "",
  ).length;
}

function activityMs(record: object) {
  const value = (record as { lastActivityAt?: string }).lastActivityAt;
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
