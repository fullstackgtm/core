/**
 * Governed duplicate cleanup: `dedupe` groups records by a normalized
 * identity key (account domain, contact email, or name) and builds a
 * dry-run PatchPlan of merge_records operations — one per duplicate group,
 * with a DETERMINISTIC survivor. It NEVER writes — the plan flows through
 * the same plans-approve → apply gate as every other plan.
 *
 * The merge contract matches the connectors (see mergeRecords in
 * connectors/hubspot.ts): afterValue = the survivor id, beforeValue = the
 * ids of EVERY record in the group (survivor included). Merges are
 * IRREVERSIBLE on every provider that supports them, so every operation is
 * riskLevel high and approvalRequired.
 *
 * Survivor selection ("--keep"):
 *   richest (default)  the record with the most non-empty canonical data
 *                      fields (bookkeeping fields like id/crmId/identities
 *                      don't count); ties break to the lowest numeric id
 *   oldest             the lowest numeric id (CRMs assign ids in creation
 *                      order)
 */
import { normalizeDomain } from "./merge.js";
import { stableHash } from "./rules.js";
const COLLECTIONS = {
    account: "accounts",
    contact: "contacts",
    deal: "deals",
};
/** Which identity keys make sense per object type. */
const VALID_KEYS = {
    account: ["domain", "name"],
    contact: ["email", "name"],
    deal: ["name"],
};
/**
 * Bookkeeping fields excluded from the richness count: they are populated
 * (or not) by the sync machinery, not by the quality of the record's data,
 * so counting them would let plumbing decide which record survives a merge.
 */
const NON_DATA_FIELDS = new Set(["id", "provider", "crmId", "identities", "raw", "provenance"]);
function populatedDataFields(record) {
    return Object.entries(record).filter(([field, value]) => !NON_DATA_FIELDS.has(field) && value !== undefined && value !== null && value !== "").length;
}
/**
 * The subset of a record worth keeping as a merge-recovery artifact: its id (to
 * reference) plus every populated data field, dropping bulky/plumbing fields
 * (raw, identities, provenance) that aren't needed to recreate it by hand.
 */
export function recoverableFields(record) {
    const out = { id: String(record.id) };
    for (const [field, value] of Object.entries(record)) {
        if (NON_DATA_FIELDS.has(field))
            continue;
        if (value === undefined || value === null || value === "")
            continue;
        out[field] = value;
    }
    return out;
}
/** True when id `a` sorts before id `b` — numeric when both ids are numeric. */
function idBefore(a, b) {
    const numericA = Number(a);
    const numericB = Number(b);
    if (Number.isFinite(numericA) && Number.isFinite(numericB) && numericA !== numericB) {
        return numericA < numericB;
    }
    return a < b;
}
/** Normalize a record's identity key; undefined when the field is empty. */
export function dedupeKey(record, key) {
    if (key === "domain")
        return normalizeDomain(record.domain);
    const raw = record[key];
    if (raw === undefined || raw === null)
        return undefined;
    const normalized = String(raw).trim().toLowerCase();
    return normalized || undefined;
}
export function buildDedupePlan(snapshot, options) {
    const keep = options.keep ?? "richest";
    const maxOperations = options.maxOperations ?? 500;
    if (!VALID_KEYS[options.objectType].includes(options.key)) {
        throw new Error(`Cannot dedupe ${COLLECTIONS[options.objectType]} by "${options.key}". Valid keys for ${options.objectType}s: ${VALID_KEYS[options.objectType].join(", ")}.`);
    }
    if (keep !== "richest" && keep !== "oldest") {
        throw new Error(`--keep must be richest or oldest, got "${keep}".`);
    }
    const records = snapshot[COLLECTIONS[options.objectType]];
    const groups = new Map();
    for (const record of records) {
        const key = dedupeKey(record, options.key);
        if (!key)
            continue; // records without the identity key cannot be duplicates by it
        const existing = groups.get(key) ?? [];
        existing.push(record);
        groups.set(key, existing);
    }
    for (const [key, members] of Array.from(groups.entries())) {
        if (members.length < 2)
            groups.delete(key);
    }
    if (groups.size > maxOperations) {
        throw new Error(`Found ${groups.size} duplicate groups — above the ${maxOperations}-group safety cap. Raise --max-operations explicitly after reviewing the volume.`);
    }
    const operations = [];
    let duplicateRecordCount = 0;
    for (const [key, members] of groups) {
        duplicateRecordCount += members.length;
        // deterministic survivor: richest data first (ties to lowest id), or
        // simply the lowest id when keeping the oldest
        const survivor = [...members].sort((a, b) => {
            if (keep === "richest") {
                const richness = populatedDataFields(b) - populatedDataFields(a);
                if (richness !== 0)
                    return richness;
            }
            return idBefore(String(a.id), String(b.id)) ? -1 : 1;
        })[0];
        const groupIds = members
            .map((member) => String(member.id))
            .sort((a, b) => (idBefore(a, b) ? -1 : 1));
        // Recovery artifact: the records that will be merged away (everyone but the
        // survivor), captured with their field values so a human can recreate one by
        // hand if the merge was wrong. Merges are irreversible — the plan is the backup.
        const recoverySnapshot = members
            .filter((member) => String(member.id) !== String(survivor.id))
            .map((member) => recoverableFields(member));
        const survivorName = typeof survivor.name === "string" && survivor.name
            ? survivor.name
            : typeof survivor.email === "string" && survivor.email
                ? survivor.email
                : String(survivor.id);
        const keepDetail = keep === "richest"
            ? `${populatedDataFields(survivor)} populated data fields, the most in the group (ties break to the lowest id)`
            : "the lowest id in the group (oldest record)";
        operations.push({
            id: `op_${stableHash(`dedupe:${options.objectType}:${options.key}:${groupIds.join(",")}`)}`,
            objectType: options.objectType,
            objectId: String(survivor.id),
            operation: "merge_records",
            field: "merge",
            beforeValue: groupIds,
            afterValue: String(survivor.id),
            reason: options.reason ??
                `${members.length} ${COLLECTIONS[options.objectType]} share ${options.key} "${key}". Merge into "${survivorName}" (${survivor.id}) — survivor has ${keepDetail}.`,
            riskLevel: "high",
            approvalRequired: true,
            sourceRuleOrPolicy: "dedupe",
            groupId: `grp_${options.objectType}_${String(survivor.id)}`,
            recoverySnapshot,
            rollback: "IRREVERSIBLE: provider merges cannot be unmerged. recoverySnapshot on this operation retains every merged-away record's field values; recreate a record manually from it if a merge was wrong.",
        });
    }
    return {
        id: `patch_plan_${stableHash(`dedupe:${snapshot.provider}:${snapshot.generatedAt}:${options.objectType}:${options.key}:${keep}:${operations.length}`)}`,
        title: `Dedupe: ${COLLECTIONS[options.objectType]} sharing the same ${options.key}`,
        createdAt: snapshot.generatedAt,
        status: operations.length > 0 ? "needs_approval" : "draft",
        dryRun: true,
        summary: `${groups.size} duplicate group(s) across ${duplicateRecordCount} ${COLLECTIONS[options.objectType]} (key: ${options.key}, keep: ${keep}); ${operations.length} proposed dry-run merge_records operation(s). Merges are IRREVERSIBLE — review each survivor before approving.`,
        findings: [],
        operations,
    };
}
