/**
 * The schedule layer: declarative cadences for read/plan-side commands,
 * materialized through a provider (MVP: the user crontab), with an
 * append-only run history. The governance invariant — scheduling never
 * auto-approves — is enforced at `add` time and re-checked at `run` time.
 * Spec: docs/schedule.md (monorepo).
 */
export declare function scheduleCommand(args: string[]): Promise<void>;
