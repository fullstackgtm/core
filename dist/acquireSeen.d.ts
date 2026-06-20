export declare function acquireSeenPath(baseDir?: string): string;
/** Load the set of seen keys (empty if none/corrupt). */
export declare function loadSeen(baseDir?: string): Set<string>;
/** Merge keys into the cache with a `now` timestamp, prune to cap, persist. */
export declare function recordSeen(keys: string[], now: Date, baseDir?: string): void;
