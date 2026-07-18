import type { CanonicalAccount } from "./types.ts";
export declare function accountParentId(account: CanonicalAccount): string | undefined;
/** A recorded family relationship is a merge blocker, never duplicate proof. */
export declare function accountsShareKnownFamily(accounts: CanonicalAccount[]): boolean;
