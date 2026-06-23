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
export type AssignmentStrategy = "fixed" | "round-robin" | "territory" | "account-owner";
/** The attributes a territory rule can route on, lifted from a record/prospect. */
export type AssignmentContext = {
    /** ISO country code, lowercased (e.g. "us"). */
    geo?: string;
    /** human industry label, lowercased (e.g. "software"). */
    industry?: string;
    /** provider-agnostic employee band (e.g. "11-50"). */
    employeeBand?: string;
    /** department, lowercased (e.g. "sales"). */
    department?: string;
    /** raw job title, lowercased — matched against rule titleKeywords as substrings. */
    title?: string;
    /** owner of the associated account, if any — enables "account-owner" inherit. */
    accountOwnerId?: string;
};
/**
 * One territory clause. Every present key must match (AND across keys); within a
 * key the candidate value must be one of the listed values (OR). `titleKeywords`
 * matches when the context title CONTAINS any keyword as a substring.
 */
export type TerritoryRule = {
    when: Partial<{
        geo: string[];
        industry: string[];
        employeeBand: string[];
        department: string[];
        titleKeywords: string[];
    }>;
    ownerId: string;
};
export type AssignmentPolicy = {
    strategy: "fixed";
    ownerId: string;
} | {
    strategy: "round-robin";
    ownerIds: string[];
} | {
    strategy: "territory";
    rules: TerritoryRule[];
    fallbackOwnerId?: string;
} | {
    strategy: "account-owner";
    fallbackOwnerId?: string;
};
export type AssignmentResult = {
    /** the resolved owner, or null when the policy can't place this record. */
    ownerId: string | null;
    /** short human label for why (audit trail): "fixed", "round-robin", "territory:0", "account-owner", "fallback". */
    rule?: string;
};
/**
 * Validate + normalize a raw assignment policy (from enrich.config.json or a
 * CLI flag). Throws on shape errors so a misconfigured policy fails loud at
 * plan time, never silently mis-routes.
 */
export declare function parseAssignmentPolicy(raw: unknown): AssignmentPolicy;
/** Does the context satisfy every present clause of a territory rule? */
export declare function matchesTerritory(rule: TerritoryRule, ctx: AssignmentContext): boolean;
/**
 * Resolve the owner for one record. `index` is the record's 0-based position
 * within the run (used by round-robin for deterministic, even within-run
 * distribution without persisted state). `knownOwnerIds` is the set of active
 * owners from the snapshot; any result outside it collapses to null so callers
 * never write an owner the CRM won't accept.
 */
export declare function resolveAssignment(policy: AssignmentPolicy, ctx: AssignmentContext, index: number, knownOwnerIds: ReadonlySet<string>): AssignmentResult;
