/**
 * Governed generic writes: `bulk-update` builds a dry-run patch plan from a
 * filter over the canonical snapshot plus an action (field assignments, an
 * archive directive, or a task to create). It NEVER writes — the plan flows
 * through the same plans-approve → apply gate as audit plans.
 *
 * Safety model, in layers:
 *  - every set_field captures the record's live value as `beforeValue`
 *    (apply refuses the write if the written field drifted);
 *  - every equality filter on a real record field becomes an automatic
 *    PRECONDITION, re-verified at apply time (the plan's premise must still
 *    hold — guards against drift on fields other than the one written);
 *  - `--require field=value` adds explicit preconditions on top;
 *  - all operations for one record share a groupId, so multi-field updates
 *    are all-or-nothing per record.
 *
 * Filter grammar (each --where is AND-ed):
 *   field=value     case-insensitive equality
 *   field!=value    case-insensitive inequality
 *   field~value     case-insensitive substring
 *   field:empty     unset or empty string
 *   field:notempty  set and non-empty
 *
 * Fields are canonical (ownerId, stage, closeDate, amount, domain, name,
 * email, isClosed, accountId, …). Relational pseudo-fields are available in
 * filters: deals and contacts get `account.name`, `account.domain`,
 * `account.ownerId`, `account.contactCount`; accounts get `contactCount`
 * and `openDealCount`.
 */
import { recoverableFields } from "./dedupe.ts";
import { normalizeDomain } from "./merge.ts";
import { stableHash } from "./rules.ts";
import type {
  CanonicalGtmSnapshot,
  GtmObjectType,
  PatchOperation,
  PatchPlan,
  PlanGuard,
} from "./types.ts";

export type BulkUpdateOptions = {
  objectType: "account" | "contact" | "deal";
  /** raw --where expressions, AND-ed together; at least one is required */
  where: string[];
  /**
   * canonical field → new value; one action only. A value of the form
   * `from:<sourceField>` is resolved PER RECORD from the filter view at
   * plan time (relational pseudo-fields like account.ownerId included);
   * records whose source value is empty are skipped, not failed, and
   * counted in the plan summary.
   */
  set?: Record<string, string>;
  /** propose archive_record instead of field writes */
  archive?: boolean;
  /**
   * bypass the archive duplicate guard: by default --archive refuses when a
   * matched account/contact shares its identity key (normalized domain /
   * lowercased email) with another record — those are duplicates, and
   * archiving a duplicate discards its data where merging preserves it
   */
  forceArchiveDuplicates?: boolean;
  /** propose create_task on each matched record with this subject/body text */
  createTask?: string;
  /** explicit preconditions (field=value), re-verified at apply time */
  require?: string[];
  /**
   * plan-level guards, raw form "<objectType>:<where>[;<where>…]:<none|some>",
   * re-evaluated against a fresh snapshot at apply time; failure aborts the
   * entire plan
   */
  guard?: string[];
  reason?: string;
  /** refuse to build plans larger than this (default 500 operations) */
  maxOperations?: number;
};

type WhereClause = {
  field: string;
  op: "eq" | "neq" | "contains" | "notcontains" | "empty" | "notempty";
  value?: string;
  raw: string;
};

const FIELD_PATTERN = "[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z][a-zA-Z0-9_]*)?";

export function parseWhere(expr: string): WhereClause {
  const empty = expr.match(new RegExp(`^(${FIELD_PATTERN}):(empty|notempty)$`));
  if (empty) return { field: empty[1], op: empty[2] as "empty" | "notempty", raw: expr };
  const neq = expr.match(new RegExp(`^(${FIELD_PATTERN})!=(.*)$`));
  if (neq) return { field: neq[1], op: "neq", value: neq[2], raw: expr };
  const notContains = expr.match(new RegExp(`^(${FIELD_PATTERN})!~(.*)$`));
  if (notContains) return { field: notContains[1], op: "notcontains", value: notContains[2], raw: expr };
  const contains = expr.match(new RegExp(`^(${FIELD_PATTERN})~(.*)$`));
  if (contains) return { field: contains[1], op: "contains", value: contains[2], raw: expr };
  const eq = expr.match(new RegExp(`^(${FIELD_PATTERN})=(.*)$`));
  if (eq) return { field: eq[1], op: "eq", value: eq[2], raw: expr };
  throw new Error(
    `Cannot parse --where "${expr}". Use field=value, field!=value, field~substring, field!~substring, field:empty, or field:notempty.`,
  );
}

function fieldValue(view: Record<string, unknown>, field: string): string {
  const value = view[field];
  if (value === undefined || value === null) return "";
  return String(value);
}

function matches(view: Record<string, unknown>, clause: WhereClause): boolean {
  const actual = fieldValue(view, clause.field).toLowerCase();
  // `|` alternation: eq/contains match ANY alternative; neq/notcontains
  // must hold against ALL alternatives.
  const alternatives = (clause.value ?? "").toLowerCase().split("|");
  switch (clause.op) {
    case "eq":
      return alternatives.some((a) => actual === a);
    case "neq":
      return alternatives.every((a) => actual !== a);
    case "contains":
      return alternatives.some((a) => actual.includes(a));
    case "notcontains":
      return alternatives.every((a) => !actual.includes(a));
    case "empty":
      return actual === "";
    case "notempty":
      return actual !== "";
  }
}

const COLLECTIONS: Record<BulkUpdateOptions["objectType"], keyof CanonicalGtmSnapshot> = {
  account: "accounts",
  contact: "contacts",
  deal: "deals",
};

const RELATIONAL_FIELDS = ["account.name", "account.domain", "account.ownerId", "account.contactCount", "account.openDealStages"];
/**
 * Filterable fields per object type. Filters/requires/guards referencing any
 * other field are rejected at plan time: a typo'd field silently evaluating
 * to empty would make a ":none" guard pass vacuously — a safety assertion
 * that never fires. Strictness turns typos into immediate, correctable
 * errors.
 */
const VALID_FIELDS: Record<BulkUpdateOptions["objectType"], Set<string>> = {
  account: new Set(["id", "crmId", "name", "domain", "industry", "ownerId", "employeeCount", "annualRevenue", "lastActivityAt", "lastSyncAt", "contactCount", "openDealCount", "openDealStages"]),
  contact: new Set(["id", "crmId", "accountId", "firstName", "lastName", "email", "phone", "title", "ownerId", "lastSyncAt", ...RELATIONAL_FIELDS]),
  deal: new Set(["id", "crmId", "accountId", "ownerId", "name", "amount", "currency", "stage", "closeDate", "dealType", "forecastCategory", "nextStep", "probability", "isClosed", "isWon", "lastActivityAt", "lastSyncAt", ...RELATIONAL_FIELDS]),
};

/** True when `field` is filterable for this object type (relational pseudo-fields included). */
export function isFilterableField(
  objectType: BulkUpdateOptions["objectType"],
  field: string,
): boolean {
  return VALID_FIELDS[objectType].has(field);
}

function assertValidFields(objectType: BulkUpdateOptions["objectType"], clauses: WhereClause[], context: string): void {
  for (const clause of clauses) {
    if (!VALID_FIELDS[objectType].has(clause.field)) {
      throw new Error(
        `Unknown field "${clause.field}" in ${context} "${clause.raw}" for ${objectType}s. Valid fields: ${[...VALID_FIELDS[objectType]].join(", ")}.`,
      );
    }
  }
}

/**
 * Fields that are derived in the canonical model (no provider property to
 * re-read at apply time) or relational — excluded from auto-preconditions.
 */
const NON_READABLE_FIELDS = new Set([
  // derived in the canonical model — no provider property to re-read
  "isClosed", "isWon", "forecastCategory", "probability", "lastActivityAt", "lastSyncAt",
  // identity/bookkeeping fields — preconditions on these are meaningless
  "id", "crmId", "provider", "identities",
]);

/** Build the filter-evaluation view: record fields + relational pseudo-fields. */
function buildViews(
  snapshot: CanonicalGtmSnapshot,
  objectType: BulkUpdateOptions["objectType"],
): Array<{ record: Record<string, unknown>; view: Record<string, unknown> }> {
  const accountsById = new Map(snapshot.accounts.map((a) => [a.id, a]));
  const contactCountByAccount = new Map<string, number>();
  for (const c of snapshot.contacts) {
    if (c.accountId) contactCountByAccount.set(c.accountId, (contactCountByAccount.get(c.accountId) ?? 0) + 1);
  }
  const openDealCountByAccount = new Map<string, number>();
  const openDealStagesByAccount = new Map<string, string[]>();
  for (const d of snapshot.deals) {
    if (d.accountId && !d.isClosed) {
      openDealCountByAccount.set(d.accountId, (openDealCountByAccount.get(d.accountId) ?? 0) + 1);
      const stages = openDealStagesByAccount.get(d.accountId) ?? [];
      if (d.stage) stages.push(d.stage);
      openDealStagesByAccount.set(d.accountId, stages);
    }
  }
  const records = snapshot[COLLECTIONS[objectType]] as Array<Record<string, unknown>>;
  return records.map((record) => {
    const view: Record<string, unknown> = { ...record };
    if (objectType === "account") {
      view.contactCount = contactCountByAccount.get(String(record.id)) ?? 0;
      view.openDealCount = openDealCountByAccount.get(String(record.id)) ?? 0;
      view.openDealStages = (openDealStagesByAccount.get(String(record.id)) ?? []).join(",");
    } else {
      const account = record.accountId ? accountsById.get(String(record.accountId)) : undefined;
      view["account.name"] = account?.name ?? "";
      view["account.domain"] = account?.domain ?? "";
      view["account.ownerId"] = account?.ownerId ?? "";
      view["account.contactCount"] = account ? (contactCountByAccount.get(account.id) ?? 0) : 0;
      view["account.openDealStages"] = account ? (openDealStagesByAccount.get(account.id) ?? []).join(",") : "";
    }
    return { record, view };
  });
}

export function parseGuard(raw: string): PlanGuard {
  const first = raw.indexOf(":");
  const last = raw.lastIndexOf(":");
  if (first === -1 || last === first) {
    throw new Error(`Cannot parse --guard "${raw}". Use <account|contact|deal>:<where>[;<where>…]:<none|some>.`);
  }
  const objectType = raw.slice(0, first);
  const expect = raw.slice(last + 1);
  const where = raw.slice(first + 1, last).split(";").map((s) => s.trim()).filter(Boolean);
  if (!["account", "contact", "deal"].includes(objectType) || !["none", "some"].includes(expect) || where.length === 0) {
    throw new Error(`Cannot parse --guard "${raw}". Use <account|contact|deal>:<where>[;<where>…]:<none|some>.`);
  }
  // validate eagerly at plan time: a typo'd guard must fail loudly, never
  // pass vacuously at apply time
  assertValidFields(objectType as BulkUpdateOptions["objectType"], where.map(parseWhere), "--guard");
  return { objectType: objectType as PlanGuard["objectType"], where, expect: expect as PlanGuard["expect"], description: raw };
}

/** Ids of records matching a filter — used for apply-time filter re-verification. */
export function eligibleIds(
  snapshot: CanonicalGtmSnapshot,
  objectType: BulkUpdateOptions["objectType"],
  where: string[],
): Set<string> {
  const clauses = where.map(parseWhere);
  const views = buildViews(snapshot, objectType);
  return new Set(
    views.filter(({ view }) => clauses.every((c) => matches(view, c))).map(({ record }) => String(record.id)),
  );
}

/** Evaluate a plan guard against a snapshot. Returns null when satisfied, else a failure detail. */
export function evaluateGuard(snapshot: CanonicalGtmSnapshot, guard: PlanGuard): string | null {
  const clauses = guard.where.map(parseWhere);
  const views = buildViews(snapshot, guard.objectType);
  const matchCount = views.filter(({ view }) => clauses.every((c) => matches(view, c))).length;
  const ok = guard.expect === "none" ? matchCount === 0 : matchCount > 0;
  if (ok) return null;
  return `Guard failed: expected ${guard.expect === "none" ? "no" : "at least one"} ${guard.objectType}(s) matching [${guard.where.join(" AND ")}], found ${matchCount}.`;
}

export function buildBulkUpdatePlan(
  snapshot: CanonicalGtmSnapshot,
  options: BulkUpdateOptions,
): PatchPlan {
  const maxOperations = options.maxOperations ?? 500;
  if (options.where.length === 0) {
    throw new Error(
      "bulk-update requires at least one --where filter — refusing to build an unscoped mass write.",
    );
  }
  const hasSet = options.set && Object.keys(options.set).length > 0;
  const actions = [hasSet, options.archive, options.createTask !== undefined].filter(Boolean).length;
  if (actions !== 1) {
    throw new Error("bulk-update needs exactly one action: --set <field>=<value> (repeatable), --archive, or --create-task <text>.");
  }

  const clauses = options.where.map(parseWhere);
  assertValidFields(options.objectType, clauses, "--where");
  const WRITABLE_BLOCKLIST = new Set(["id", "crmId", "contactCount", "openDealCount", "openDealStages"]);
  // `from:<sourceField>` values resolve per record from the filter view —
  // the source is validated with the same strictness as filters (relational
  // pseudo-fields allowed; the WRITTEN field still must be canonical).
  const assignments: Array<{ field: string; literal?: string; fromField?: string }> = [];
  for (const [field, value] of Object.entries(options.set ?? {})) {
    if (!VALID_FIELDS[options.objectType].has(field) || WRITABLE_BLOCKLIST.has(field) || field.includes(".")) {
      throw new Error(`Cannot --set "${field}" on ${options.objectType}s — not a writable canonical field.`);
    }
    if (value.startsWith("from:")) {
      const fromField = value.slice("from:".length);
      if (!VALID_FIELDS[options.objectType].has(fromField)) {
        throw new Error(
          `Cannot --set ${field}=from:${fromField} on ${options.objectType}s — unknown source field "${fromField}". Valid fields: ${[...VALID_FIELDS[options.objectType]].join(", ")}.`,
        );
      }
      assignments.push({ field, fromField });
    } else {
      assignments.push({ field, literal: value });
    }
  }
  const views = buildViews(snapshot, options.objectType);
  const matched = views.filter(({ view }) => clauses.every((c) => matches(view, c)));
  if (matched.length > maxOperations) {
    throw new Error(
      `Filter matched ${matched.length} ${COLLECTIONS[options.objectType]} — above the ${maxOperations}-record safety cap. Narrow the --where filter or raise --max-operations explicitly.`,
    );
  }

  // Archive duplicate guard: archiving a record that shares its identity key
  // with another active record discards data a merge would preserve. Refuse
  // and point at `dedupe` unless explicitly overridden. Deals are exempt —
  // they carry no identity key.
  if (options.archive && options.objectType !== "deal" && !options.forceArchiveDuplicates) {
    const keyName = options.objectType === "account" ? "domain" : "email";
    const keyOf = (record: Record<string, unknown>): string | undefined =>
      options.objectType === "account"
        ? normalizeDomain(record.domain as string | undefined)
        : ((record.email as string | undefined)?.trim().toLowerCase() || undefined);
    const allRecords = snapshot[COLLECTIONS[options.objectType]] as Array<Record<string, unknown>>;
    const byKey = new Map<string, Array<Record<string, unknown>>>();
    for (const record of allRecords) {
      const key = keyOf(record);
      if (!key) continue;
      const existing = byKey.get(key) ?? [];
      existing.push(record);
      byKey.set(key, existing);
    }
    const collisions: string[] = [];
    for (const { record } of matched) {
      const key = keyOf(record);
      if (!key) continue;
      const others = (byKey.get(key) ?? []).filter((other) => other.id !== record.id);
      if (others.length === 0) continue;
      const label = (record.name as string | undefined) ?? (record.email as string | undefined) ?? "";
      collisions.push(
        `${options.objectType} ${record.id}${label ? ` "${label}"` : ""} shares ${keyName} "${key}" with ${others
          .map((other) => `${other.id}${other.name ? ` "${other.name}"` : ""}`)
          .join(", ")}`,
      );
    }
    if (collisions.length > 0) {
      throw new Error(
        `Refusing to archive: ${collisions.length} matched record(s) look like duplicates of other records — archiving a duplicate DISCARDS its data, merging preserves it. Use \`fullstackgtm dedupe ${options.objectType} --key ${keyName}\` (merge_records) instead, or pass --force-archive-duplicates to archive anyway.\n  - ${collisions.join("\n  - ")}`,
      );
    }
  }

  // Preconditions: explicit --require, plus every equality filter on a real
  // (re-readable, non-relational) field. The premise the plan was built on
  // is re-verified per record at apply time.
  const writtenFields = new Set(Object.keys(options.set ?? {}));
  const preconditionSpecs: Array<{ field: string; expectedValue: string }> = [];
  for (const raw of options.require ?? []) {
    const clause = parseWhere(raw);
    if (clause.op !== "eq" || clause.field.includes(".") || (clause.value ?? "").includes("|")) {
      throw new Error(`--require must be a direct single-value field equality (field=value), got "${raw}".`);
    }
    assertValidFields(options.objectType, [clause], "--require");
    preconditionSpecs.push({ field: clause.field, expectedValue: clause.value ?? "" });
  }
  for (const clause of clauses) {
    if (clause.op !== "eq") continue;
    if ((clause.value ?? "").includes("|")) continue; // alternations are not single-value preconditions
    if (clause.field.includes(".") || NON_READABLE_FIELDS.has(clause.field)) continue;
    if (writtenFields.has(clause.field)) continue; // beforeValue already guards it
    if (preconditionSpecs.some((p) => p.field === clause.field)) continue;
    preconditionSpecs.push({ field: clause.field, expectedValue: clause.value ?? "" });
  }

  const whereText = options.where.join(" AND ");
  const action = options.archive
    ? `archive`
    : options.createTask !== undefined
      ? `create task "${options.createTask}"`
      : `set ${Object.entries(options.set!).map(([k, v]) => `${k}=${v}`).join(", ")}`;
  const reason = options.reason ?? `bulk-update: ${action} where ${whereText}`;

  const operations: PatchOperation[] = [];
  // records skipped because a from:<sourceField> value was empty, per source
  const skippedBySource = new Map<string, number>();
  for (const { record, view } of matched) {
    const objectId = String(record.id);
    const groupId = `grp_${options.objectType}_${objectId}`;
    const preconditions = preconditionSpecs.map((p) => ({
      field: p.field,
      // expected value is the record's CURRENT canonical value, not the
      // filter literal — preserves casing/format the provider will echo back
      expectedValue: record[p.field] ?? p.expectedValue,
    }));
    const shared = {
      objectType: options.objectType as GtmObjectType,
      objectId,
      reason,
      approvalRequired: true as const,
      sourceRuleOrPolicy: "bulk-update",
      ...(preconditions.length > 0 ? { preconditions } : {}),
      groupId,
    };
    if (options.archive) {
      operations.push({
        ...shared,
        id: `op_${stableHash(`bulk-archive:${options.objectType}:${objectId}:${whereText}`)}`,
        operation: "archive_record",
        beforeValue: null,
        afterValue: null,
        riskLevel: "high",
        // Carry the human's explicit force decision to the apply-time guard, and
        // snapshot the record so it can be recreated if the archive was wrong.
        ...(options.forceArchiveDuplicates ? { forceArchiveDuplicate: true } : {}),
        recoverySnapshot: [recoverableFields(record)],
        rollback: "Archived records can be restored from the provider's recycle bin within its retention window; recoverySnapshot also retains the field values.",
      });
      continue;
    }
    if (options.createTask !== undefined) {
      operations.push({
        ...shared,
        id: `op_${stableHash(`bulk-task:${options.objectType}:${objectId}:${options.createTask}`)}`,
        operation: "create_task",
        field: "follow_up_task",
        beforeValue: null,
        afterValue: options.createTask,
        riskLevel: "low",
        rollback: "Delete the created task.",
      });
      continue;
    }
    // Resolve every assignment for this record BEFORE emitting any of its
    // operations: a record whose from:<sourceField> resolves empty is
    // skipped whole (its operations share a groupId — half a record's
    // updates is exactly what grouping exists to prevent).
    const resolved: Array<{ field: string; value: string }> = [];
    let emptySource: string | null = null;
    for (const assignment of assignments) {
      if (assignment.fromField !== undefined) {
        const value = fieldValue(view, assignment.fromField);
        if (value === "") {
          emptySource = assignment.fromField;
          break;
        }
        resolved.push({ field: assignment.field, value });
      } else {
        resolved.push({ field: assignment.field, value: assignment.literal! });
      }
    }
    if (emptySource !== null) {
      skippedBySource.set(emptySource, (skippedBySource.get(emptySource) ?? 0) + 1);
      continue;
    }
    for (const { field, value } of resolved) {
      operations.push({
        ...shared,
        id: `op_${stableHash(`bulk-set:${options.objectType}:${objectId}:${field}:${value}`)}`,
        operation: "set_field",
        field,
        beforeValue: record[field] ?? null,
        afterValue: value,
        riskLevel: "medium",
        rollback: `Set ${field} back to ${JSON.stringify(record[field] ?? null)}.`,
      });
    }
  }

  const guards = (options.guard ?? []).map(parseGuard);
  // guards must hold at plan time too — building a plan whose guard already
  // fails is a footgun, surface it immediately
  for (const guard of guards) {
    const failure = evaluateGuard(snapshot, guard);
    if (failure) throw new Error(`${failure} The guard already fails against the current snapshot — the plan would never apply.`);
  }

  const skippedText = [...skippedBySource.entries()]
    .map(([sourceField, count]) => ` ${count} skipped: empty ${sourceField}.`)
    .join("");
  return {
    id: `patch_plan_${stableHash(`bulk:${snapshot.provider}:${snapshot.generatedAt}:${options.objectType}:${whereText}:${action}:${operations.length}`)}`,
    title: `Bulk update: ${options.objectType}s where ${whereText}`,
    createdAt: snapshot.generatedAt,
    status: operations.length > 0 ? "needs_approval" : "draft",
    dryRun: true,
    summary: `${matched.length} ${COLLECTIONS[options.objectType]} matched (${whereText}); ${operations.length} proposed dry-run operations (${action}).${skippedText}${guards.length > 0 ? ` ${guards.length} apply-time guard(s).` : ""}`,
    findings: [],
    operations,
    filter: { objectType: options.objectType, where: options.where },
    ...(guards.length > 0 ? { guards } : {}),
  };
}
