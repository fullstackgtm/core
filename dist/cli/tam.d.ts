/** Best-effort enrich-config load for apply-time acquire-budget enforcement. */
/** Provider API key: env override first, then the credential store (`login`). */
export declare function providerKey(provider: "explorium" | "pipe0" | "heyreach" | "theirstack"): string;
/**
 * `tam` — Total Addressable Market mapping. Estimate a defensible universe from
 * the ICP, then iteratively populate it via scheduled governed acquire runs and
 * track coverage over time. Subcommands: estimate, status, report, populate.
 */
export declare function tamCommand(args: string[]): Promise<void>;
