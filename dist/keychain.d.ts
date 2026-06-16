/**
 * Optional OS-keychain backing for the credential store. Off by default;
 * enabled with FSGTM_KEYCHAIN=1. When on, the credential blob is stored in the
 * OS secret store instead of a 0600 file, so a cloned home, a restored backup,
 * or another tool reading `~/.fullstackgtm/credentials.json` finds nothing.
 *
 * Backends shell out to the OS tool — no native dependency, so the package
 * stays zero-dep:
 *  - Linux: `secret-tool` (libsecret) — reads the secret from STDIN (no argv leak).
 *  - macOS: `security` — `add-generic-password` only accepts the secret via the
 *    `-w` argv flag, so it is briefly visible to same-user `ps` during the call.
 *    That transient, same-user exposure is strictly smaller than a persistent
 *    plaintext file (which the same processes can read at any time), but it is a
 *    real caveat, documented in SECURITY.md.
 *
 * Keychain entries are NOT scoped by $FSGTM_HOME (the OS store is machine-wide),
 * so the account name is derived from the credential file path to keep distinct
 * homes/profiles from colliding. This is also why keychain is opt-in: defaulting
 * it on would make throwaway-home test/eval runs write to the machine keychain.
 */
export type KeychainBackend = {
    readonly name: string;
    get(account: string): string | null;
    set(account: string, secret: string): void;
    delete(account: string): void;
};
/** Test seam: force a backend (or null to force "none"). undefined = re-detect. */
export declare function setKeychainBackendForTests(backend: KeychainBackend | null | undefined): void;
/** The active backend for this platform, or null if none is available. */
export declare function detectKeychainBackend(): KeychainBackend | null;
