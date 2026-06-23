import type { CanonicalGtmSnapshot, PatchPlan } from "./types.ts";
export type ReassignObjectType = "account" | "contact" | "deal";
export type ReassignOptions = {
    /**
     * the owner whose records are being handed off. Ignored (and not required)
     * when `assignUnowned` is set — that mode targets ownerless records instead.
     */
    fromOwnerId?: string;
    /** the receiving owner — must be a known user in the snapshot */
    toOwnerId: string;
    /**
     * Backfill mode: instead of moving records from one owner to another, claim
     * every OWNERLESS record (ownerId:empty) for `toOwnerId`. Shares the create-
     * time assignment intent with `enrich acquire`, applied to existing debt.
     */
    assignUnowned?: boolean;
    /** which object types to compile plans for (default all three) */
    objects?: ReassignObjectType[];
    /** extra --where scoping, AND-ed into every plan (account fields lifted) */
    where?: string[];
    /** exclude records tied to an open deal in this stage (see module doc) */
    exceptDealStage?: string;
    /** also reassign closed deals (default false: history keeps its owner) */
    includeClosedDeals?: boolean;
    reason?: string;
    maxOperations?: number;
};
export declare function buildReassignPlans(snapshot: CanonicalGtmSnapshot, options: ReassignOptions): PatchPlan[];
