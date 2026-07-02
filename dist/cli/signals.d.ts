/**
 * `signals` — detect fresh buying triggers (ATS job-board scrapes + staged
 * funding/company/social ingest), rank them, and persist a local signal ledger.
 * READ-ONLY re: CRM: NEVER emits a PatchPlan, never calls a recording connector.
 * `--save` persists only to the signal store, not a plan.
 */
export declare function signalsCommand(args: string[]): Promise<void>;
