/**
 * AssignmentPolicy — the shared rule that decides which owner a record belongs
 * to. One policy, two consumers:
 *   1. `enrich acquire` stamps the resolved owner into each `create_record`
 *      payload, so a lead is never born ownerless, and
 *   2. `reassign --assign-unowned` applies the SAME policy to backfill existing
 *      ownerless records.
 *
 * Pure + zero-dep: `resolveAssignment` takes plain data (the record's routing
 * attributes + the candidate owners + the within-run index) and returns an
 * ownerId or null. Round-robin distributes by the within-run index, so it needs
 * no persisted rotation cursor — the same plan always resolves the same way
 * (deterministic apply). Every result is gated by the set of KNOWN active
 * owners: a policy that points at an unknown or inactive owner yields null, and
 * the caller leaves that record unassigned + surfaces it — never a bad write.
 */
const STRATEGIES = ["fixed", "round-robin", "territory", "account-owner"];
function asStringArray(value, label) {
    if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string" || !v.trim())) {
        throw new Error(`assign: ${label} must be a non-empty array of strings`);
    }
    return value.map((v) => v.trim());
}
/**
 * Validate + normalize a raw assignment policy (from enrich.config.json or a
 * CLI flag). Throws on shape errors so a misconfigured policy fails loud at
 * plan time, never silently mis-routes.
 */
export function parseAssignmentPolicy(raw) {
    if (!raw || typeof raw !== "object")
        throw new Error("assign: expected a policy object");
    const p = raw;
    const strategy = p.strategy;
    if (typeof strategy !== "string" || !STRATEGIES.includes(strategy)) {
        throw new Error(`assign: "strategy" must be one of ${STRATEGIES.join(" | ")}`);
    }
    switch (strategy) {
        case "fixed": {
            if (typeof p.ownerId !== "string" || !p.ownerId.trim()) {
                throw new Error('assign: fixed strategy needs a non-empty "ownerId"');
            }
            return { strategy, ownerId: p.ownerId.trim() };
        }
        case "round-robin": {
            const ownerIds = asStringArray(p.ownerIds, "round-robin ownerIds");
            return { strategy, ownerIds };
        }
        case "territory": {
            if (!Array.isArray(p.rules) || p.rules.length === 0) {
                throw new Error('assign: territory strategy needs a non-empty "rules" array');
            }
            const rules = p.rules.map((r, i) => {
                if (!r || typeof r !== "object")
                    throw new Error(`assign: territory rule ${i} must be an object`);
                const rule = r;
                if (typeof rule.ownerId !== "string" || !rule.ownerId.trim()) {
                    throw new Error(`assign: territory rule ${i} needs a non-empty "ownerId"`);
                }
                const whenRaw = (rule.when ?? {});
                const when = {};
                for (const key of ["geo", "industry", "employeeBand", "department", "titleKeywords"]) {
                    if (whenRaw[key] !== undefined)
                        when[key] = asStringArray(whenRaw[key], `territory rule ${i} when.${key}`);
                }
                if (Object.keys(when).length === 0) {
                    throw new Error(`assign: territory rule ${i} "when" needs at least one clause (else it matches everything — use a fallbackOwnerId instead)`);
                }
                return { when, ownerId: rule.ownerId.trim() };
            });
            const fallbackOwnerId = typeof p.fallbackOwnerId === "string" && p.fallbackOwnerId.trim() ? p.fallbackOwnerId.trim() : undefined;
            return { strategy, rules, ...(fallbackOwnerId ? { fallbackOwnerId } : {}) };
        }
        case "account-owner": {
            const fallbackOwnerId = typeof p.fallbackOwnerId === "string" && p.fallbackOwnerId.trim() ? p.fallbackOwnerId.trim() : undefined;
            return { strategy, ...(fallbackOwnerId ? { fallbackOwnerId } : {}) };
        }
        default:
            throw new Error(`assign: unsupported strategy "${strategy}"`);
    }
}
function clauseMatches(values, candidate) {
    if (candidate === undefined)
        return false;
    return values.some((v) => v.toLowerCase() === candidate.toLowerCase());
}
function titleMatches(keywords, title) {
    if (!title)
        return false;
    const lower = title.toLowerCase();
    return keywords.some((k) => lower.includes(k.toLowerCase()));
}
/** Does the context satisfy every present clause of a territory rule? */
export function matchesTerritory(rule, ctx) {
    const { when } = rule;
    if (when.geo && !clauseMatches(when.geo, ctx.geo))
        return false;
    if (when.industry && !clauseMatches(when.industry, ctx.industry))
        return false;
    if (when.employeeBand && !clauseMatches(when.employeeBand, ctx.employeeBand))
        return false;
    if (when.department && !clauseMatches(when.department, ctx.department))
        return false;
    if (when.titleKeywords && !titleMatches(when.titleKeywords, ctx.title))
        return false;
    return true;
}
/** Gate a candidate ownerId by the known-active set: returns it, or null. */
function known(ownerId, knownOwnerIds) {
    return ownerId && knownOwnerIds.has(ownerId) ? ownerId : null;
}
/**
 * Resolve the owner for one record. `index` is the record's 0-based position
 * within the run (used by round-robin for deterministic, even within-run
 * distribution without persisted state). `knownOwnerIds` is the set of active
 * owners from the snapshot; any result outside it collapses to null so callers
 * never write an owner the CRM won't accept.
 */
export function resolveAssignment(policy, ctx, index, knownOwnerIds) {
    switch (policy.strategy) {
        case "fixed":
            return { ownerId: known(policy.ownerId, knownOwnerIds), rule: "fixed" };
        case "round-robin": {
            const pool = policy.ownerIds.filter((id) => knownOwnerIds.has(id));
            if (pool.length === 0)
                return { ownerId: null, rule: "round-robin" };
            const safeIndex = ((index % pool.length) + pool.length) % pool.length;
            return { ownerId: pool[safeIndex], rule: "round-robin" };
        }
        case "territory": {
            for (let i = 0; i < policy.rules.length; i++) {
                if (matchesTerritory(policy.rules[i], ctx)) {
                    const hit = known(policy.rules[i].ownerId, knownOwnerIds);
                    if (hit)
                        return { ownerId: hit, rule: `territory:${i}` };
                }
            }
            return { ownerId: known(policy.fallbackOwnerId, knownOwnerIds), rule: "fallback" };
        }
        case "account-owner": {
            const inherited = known(ctx.accountOwnerId, knownOwnerIds);
            if (inherited)
                return { ownerId: inherited, rule: "account-owner" };
            return { ownerId: known(policy.fallbackOwnerId, knownOwnerIds), rule: "fallback" };
        }
    }
}
