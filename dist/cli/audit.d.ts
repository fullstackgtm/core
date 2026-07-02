export declare function snapshotCommand(args: string[]): Promise<void>;
export declare function audit(args: string[]): Promise<void>;
/**
 * Roll up the active profile's health timeline (accrued by `audit --save`):
 * current deterministic score, change since the last audit, and per-rule
 * deltas. Read-only — it only reads `health.jsonl`, never re-audits.
 */
export declare function healthCommand(args: string[]): void;
/**
 * Render an audit as a client-facing deliverable. Same sources and audit
 * options as `audit`; `--plan` instead renders an existing plan JSON without
 * re-fetching (useful for a plan produced earlier or by another machine).
 */
export declare function reportCommand(args: string[]): Promise<void>;
export declare function rulesCommand(args: string[]): Promise<void>;
