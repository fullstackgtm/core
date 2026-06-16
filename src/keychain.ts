import { execFileSync } from "node:child_process";
import { platform } from "node:os";

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

const SERVICE = "fullstackgtm";

function hasBinary(bin: string): boolean {
  try {
    execFileSync("/usr/bin/env", ["which", bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const macosBackend: KeychainBackend = {
  name: "macos-keychain",
  get(account) {
    try {
      return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).replace(/\n$/, "");
    } catch {
      return null; // not found → non-zero exit
    }
  },
  set(account, secret) {
    // -U updates if present. NOTE: the secret is in argv for the duration of
    // this call (see the module comment); `security` has no stdin path.
    execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", secret], {
      stdio: "ignore",
    });
  },
  delete(account) {
    try {
      execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { stdio: "ignore" });
    } catch {
      // already absent
    }
  },
};

const secretToolBackend: KeychainBackend = {
  name: "linux-secret-tool",
  get(account) {
    try {
      return execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", account], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  },
  set(account, secret) {
    // secret-tool reads the secret from STDIN — no argv exposure.
    execFileSync("secret-tool", ["store", "--label", `${SERVICE} ${account}`, "service", SERVICE, "account", account], {
      input: secret,
      stdio: ["pipe", "ignore", "ignore"],
    });
  },
  delete(account) {
    try {
      execFileSync("secret-tool", ["clear", "service", SERVICE, "account", account], { stdio: "ignore" });
    } catch {
      // already absent
    }
  },
};

let override: KeychainBackend | null | undefined;

/** Test seam: force a backend (or null to force "none"). undefined = re-detect. */
export function setKeychainBackendForTests(backend: KeychainBackend | null | undefined): void {
  override = backend;
}

/** The active backend for this platform, or null if none is available. */
export function detectKeychainBackend(): KeychainBackend | null {
  if (override !== undefined) return override;
  if (platform() === "darwin" && hasBinary("security")) return macosBackend;
  if (platform() === "linux" && hasBinary("secret-tool")) return secretToolBackend;
  return null;
}
