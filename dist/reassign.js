/**
 * The ownership-handoff playbook: `reassign` compiles one bulk-update-style
 * dry-run plan PER object type (accounts, contacts, deals by default) that
 * moves every record owned by --from to --to. It NEVER writes — each plan
 * flows through the same plans-approve → apply gate, and because every plan
 * carries its full filter, eligibility (extra --where scoping AND the
 * --except-deal-stage exclusion) is re-verified per record against a FRESH
 * snapshot at apply time, with mid-apply rechecks. A record that drifts into
 * the exception set mid-run surfaces as a conflict, not a bad write.
 *
 * --except-deal-stage <stage> excludes in-flight business end to end:
 *   - deal plans drop deals in that stage (stage!=<stage>), and
 *   - ALL plans drop records whose account has an OPEN deal in that stage
 *     (accounts: openDealStages!~<stage>; deals/contacts:
 *     account.openDealStages!~<stage>).
 *
 * Deal plans cover OPEN deals only unless includeClosedDeals is set: closed
 * deals keep their historical owner in a handoff.
 *
 * Extra --where clauses are account-scoped where needed: a clause on a field
 * that only exists on accounts (e.g. domain~.de) is lifted to the relational
 * pseudo-field (account.domain~.de) for contact and deal plans, so one
 * invocation scopes all three object types consistently.
 */
import { buildBulkUpdatePlan, isFilterableField, parseWhere } from "./bulkUpdate.js";
const ALL_OBJECTS = ["account", "contact", "deal"];
/**
 * Scope an extra --where clause to one object type: pass through when the
 * field is valid there, lift account-only fields to account.<field> for
 * contacts and deals. Unknown fields fall through to buildBulkUpdatePlan's
 * strict validation, which throws with the valid-field list.
 */
function scopeWhere(objectType, raw) {
    const clause = parseWhere(raw);
    if (isFilterableField(objectType, clause.field))
        return raw;
    if (objectType !== "account" && isFilterableField(objectType, `account.${clause.field}`)) {
        return `account.${raw}`;
    }
    return raw;
}
export function buildReassignPlans(snapshot, options) {
    if (!options.fromOwnerId || !options.toOwnerId) {
        throw new Error("reassign requires both --from <ownerId> and --to <ownerId>.");
    }
    if (options.fromOwnerId === options.toOwnerId) {
        throw new Error("reassign --from and --to are the same owner — nothing to hand off.");
    }
    // The receiving owner must exist: a typo'd --to would otherwise write an
    // invalid owner onto every matched record.
    if (!snapshot.users.some((user) => user.id === options.toOwnerId)) {
        throw new Error(`reassign --to ${options.toOwnerId} is not a known user in the snapshot. Known users: ${snapshot.users
            .map((user) => `${user.id} (${user.name})`)
            .join(", ") || "none"}.`);
    }
    const objects = options.objects ?? ALL_OBJECTS;
    for (const objectType of objects) {
        if (!ALL_OBJECTS.includes(objectType)) {
            throw new Error(`reassign --objects supports account, contact, deal — got "${objectType}".`);
        }
    }
    return objects.map((objectType) => {
        const where = [`ownerId=${options.fromOwnerId}`];
        if (objectType === "deal" && !options.includeClosedDeals) {
            where.push("isClosed=false"); // closed deals keep their historical owner
        }
        for (const extra of options.where ?? []) {
            where.push(scopeWhere(objectType, extra));
        }
        if (options.exceptDealStage) {
            const stage = options.exceptDealStage;
            if (objectType === "deal")
                where.push(`stage!=${stage}`);
            where.push(objectType === "account"
                ? `openDealStages!~${stage}`
                : `account.openDealStages!~${stage}`);
        }
        return buildBulkUpdatePlan(snapshot, {
            objectType,
            where,
            set: { ownerId: options.toOwnerId },
            reason: options.reason ??
                `reassign: hand off ${objectType}s from owner ${options.fromOwnerId} to ${options.toOwnerId}`,
            maxOperations: options.maxOperations,
        });
    });
}
