/**
 * The enrich layer: governed append/refresh of third-party data (Apollo or
 * ZoomInfo pull, Clay ingest) into the CRM through the normal dry-run → approval → apply
 * contract. State lives in the profile-scoped run store (checkpoint,
 * staleness ledger, observability in one); scheduling belongs to the
 * horizontal scheduler — enrich owns no cron logic.
 */
export declare function enrichCommand(args: string[]): Promise<void>;
