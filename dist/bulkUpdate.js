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
import { stableHash } from "./rules.js";
const FIELD_PATTERN = "[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z][a-zA-Z0-9_]*)?";
export function parseWhere(expr) {
    const empty = expr.match(new RegExp(`^(${FIELD_PATTERN}):(empty|notempty)$`));
    if (empty)
        return { field: empty[1], op: empty[2], raw: expr };
    const neq = expr.match(new RegExp(`^(${FIELD_PATTERN})!=(.*)$`));
    if (neq)
        return { field: neq[1], op: "neq", value: neq[2], raw: expr };
    const notContains = expr.match(new RegExp(`^(${FIELD_PATTERN})!~(.*)$`));
    if (notContains)
        return { field: notContains[1], op: "notcontains", value: notContains[2], raw: expr };
    const contains = expr.match(new RegExp(`^(${FIELD_PATTERN})~(.*)$`));
    if (contains)
        return { field: contains[1], op: "contains", value: contains[2], raw: expr };
    const eq = expr.match(new RegExp(`^(${FIELD_PATTERN})=(.*)$`));
    if (eq)
        return { field: eq[1], op: "eq", value: eq[2], raw: expr };
    throw new Error(`Cannot parse --where "${expr}". Use field=value, field!=value, field~substring, field!~substring, field:empty, or field:notempty.`);
}
function fieldValue(view, field) {
    const value = view[field];
    if (value === undefined || value === null)
        return "";
    return String(value);
}
function matches(view, clause) {
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
const COLLECTIONS = {
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
const VALID_FIELDS = {
    account: new Set(["id", "crmId", "name", "domain", "industry", "ownerId", "employeeCount", "annualRevenue", "lastActivityAt", "lastSyncAt", "contactCount", "openDealCount", "openDealStages"]),
    contact: new Set(["id", "crmId", "accountId", "firstName", "lastName", "email", "phone", "title", "ownerId", "lastSyncAt", ...RELATIONAL_FIELDS]),
    deal: new Set(["id", "crmId", "accountId", "ownerId", "name", "amount", "currency", "stage", "closeDate", "dealType", "forecastCategory", "nextStep", "probability", "isClosed", "isWon", "lastActivityAt", "lastSyncAt", ...RELATIONAL_FIELDS]),
};
function assertValidFields(objectType, clauses, context) {
    for (const clause of clauses) {
        if (!VALID_FIELDS[objectType].has(clause.field)) {
            throw new Error(`Unknown field "${clause.field}" in ${context} "${clause.raw}" for ${objectType}s. Valid fields: ${[...VALID_FIELDS[objectType]].join(", ")}.`);
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
function buildViews(snapshot, objectType) {
    const accountsById = new Map(snapshot.accounts.map((a) => [a.id, a]));
    const contactCountByAccount = new Map();
    for (const c of snapshot.contacts) {
        if (c.accountId)
            contactCountByAccount.set(c.accountId, (contactCountByAccount.get(c.accountId) ?? 0) + 1);
    }
    const openDealCountByAccount = new Map();
    const openDealStagesByAccount = new Map();
    for (const d of snapshot.deals) {
        if (d.accountId && !d.isClosed) {
            openDealCountByAccount.set(d.accountId, (openDealCountByAccount.get(d.accountId) ?? 0) + 1);
            const stages = openDealStagesByAccount.get(d.accountId) ?? [];
            if (d.stage)
                stages.push(d.stage);
            openDealStagesByAccount.set(d.accountId, stages);
        }
    }
    const records = snapshot[COLLECTIONS[objectType]];
    return records.map((record) => {
        const view = { ...record };
        if (objectType === "account") {
            view.contactCount = contactCountByAccount.get(String(record.id)) ?? 0;
            view.openDealCount = openDealCountByAccount.get(String(record.id)) ?? 0;
            view.openDealStages = (openDealStagesByAccount.get(String(record.id)) ?? []).join(",");
        }
        else {
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
export function parseGuard(raw) {
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
    assertValidFields(objectType, where.map(parseWhere), "--guard");
    return { objectType: objectType, where, expect: expect, description: raw };
}
/** Ids of records matching a filter — used for apply-time filter re-verification. */
export function eligibleIds(snapshot, objectType, where) {
    const clauses = where.map(parseWhere);
    const views = buildViews(snapshot, objectType);
    return new Set(views.filter(({ view }) => clauses.every((c) => matches(view, c))).map(({ record }) => String(record.id)));
}
/** Evaluate a plan guard against a snapshot. Returns null when satisfied, else a failure detail. */
export function evaluateGuard(snapshot, guard) {
    const clauses = guard.where.map(parseWhere);
    const views = buildViews(snapshot, guard.objectType);
    const matchCount = views.filter(({ view }) => clauses.every((c) => matches(view, c))).length;
    const ok = guard.expect === "none" ? matchCount === 0 : matchCount > 0;
    if (ok)
        return null;
    return `Guard failed: expected ${guard.expect === "none" ? "no" : "at least one"} ${guard.objectType}(s) matching [${guard.where.join(" AND ")}], found ${matchCount}.`;
}
export function buildBulkUpdatePlan(snapshot, options) {
    const maxOperations = options.maxOperations ?? 500;
    if (options.where.length === 0) {
        throw new Error("bulk-update requires at least one --where filter — refusing to build an unscoped mass write.");
    }
    const hasSet = options.set && Object.keys(options.set).length > 0;
    const actions = [hasSet, options.archive, options.createTask !== undefined].filter(Boolean).length;
    if (actions !== 1) {
        throw new Error("bulk-update needs exactly one action: --set <field>=<value> (repeatable), --archive, or --create-task <text>.");
    }
    const clauses = options.where.map(parseWhere);
    assertValidFields(options.objectType, clauses, "--where");
    const WRITABLE_BLOCKLIST = new Set(["id", "crmId", "contactCount", "openDealCount", "openDealStages"]);
    for (const field of Object.keys(options.set ?? {})) {
        if (!VALID_FIELDS[options.objectType].has(field) || WRITABLE_BLOCKLIST.has(field) || field.includes(".")) {
            throw new Error(`Cannot --set "${field}" on ${options.objectType}s — not a writable canonical field.`);
        }
    }
    const views = buildViews(snapshot, options.objectType);
    const matched = views.filter(({ view }) => clauses.every((c) => matches(view, c)));
    if (matched.length > maxOperations) {
        throw new Error(`Filter matched ${matched.length} ${COLLECTIONS[options.objectType]} — above the ${maxOperations}-record safety cap. Narrow the --where filter or raise --max-operations explicitly.`);
    }
    // Preconditions: explicit --require, plus every equality filter on a real
    // (re-readable, non-relational) field. The premise the plan was built on
    // is re-verified per record at apply time.
    const writtenFields = new Set(Object.keys(options.set ?? {}));
    const preconditionSpecs = [];
    for (const raw of options.require ?? []) {
        const clause = parseWhere(raw);
        if (clause.op !== "eq" || clause.field.includes(".") || (clause.value ?? "").includes("|")) {
            throw new Error(`--require must be a direct single-value field equality (field=value), got "${raw}".`);
        }
        assertValidFields(options.objectType, [clause], "--require");
        preconditionSpecs.push({ field: clause.field, expectedValue: clause.value ?? "" });
    }
    for (const clause of clauses) {
        if (clause.op !== "eq")
            continue;
        if ((clause.value ?? "").includes("|"))
            continue; // alternations are not single-value preconditions
        if (clause.field.includes(".") || NON_READABLE_FIELDS.has(clause.field))
            continue;
        if (writtenFields.has(clause.field))
            continue; // beforeValue already guards it
        if (preconditionSpecs.some((p) => p.field === clause.field))
            continue;
        preconditionSpecs.push({ field: clause.field, expectedValue: clause.value ?? "" });
    }
    const whereText = options.where.join(" AND ");
    const action = options.archive
        ? `archive`
        : options.createTask !== undefined
            ? `create task "${options.createTask}"`
            : `set ${Object.entries(options.set).map(([k, v]) => `${k}=${v}`).join(", ")}`;
    const reason = options.reason ?? `bulk-update: ${action} where ${whereText}`;
    const operations = [];
    for (const { record } of matched) {
        const objectId = String(record.id);
        const groupId = `grp_${options.objectType}_${objectId}`;
        const preconditions = preconditionSpecs.map((p) => ({
            field: p.field,
            // expected value is the record's CURRENT canonical value, not the
            // filter literal — preserves casing/format the provider will echo back
            expectedValue: record[p.field] ?? p.expectedValue,
        }));
        const shared = {
            objectType: options.objectType,
            objectId,
            reason,
            approvalRequired: true,
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
                rollback: "Archived records can be restored from the provider's recycle bin within its retention window.",
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
        for (const [field, value] of Object.entries(options.set)) {
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
        if (failure)
            throw new Error(`${failure} The guard already fails against the current snapshot — the plan would never apply.`);
    }
    return {
        id: `patch_plan_${stableHash(`bulk:${snapshot.provider}:${snapshot.generatedAt}:${whereText}:${action}:${operations.length}`)}`,
        title: `Bulk update: ${options.objectType}s where ${whereText}`,
        createdAt: snapshot.generatedAt,
        status: operations.length > 0 ? "needs_approval" : "draft",
        dryRun: true,
        summary: `${matched.length} ${COLLECTIONS[options.objectType]} matched (${whereText}); ${operations.length} proposed dry-run operations (${action}).${guards.length > 0 ? ` ${guards.length} apply-time guard(s).` : ""}`,
        findings: [],
        operations,
        filter: { objectType: options.objectType, where: options.where },
        ...(guards.length > 0 ? { guards } : {}),
    };
}
