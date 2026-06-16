import { execFileSync } from "node:child_process";
import { platform } from "node:os";
const SERVICE = "fullstackgtm";
function hasBinary(bin) {
    try {
        execFileSync("/usr/bin/env", ["which", bin], { stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
const macosBackend = {
    name: "macos-keychain",
    get(account) {
        try {
            return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).replace(/\n$/, "");
        }
        catch {
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
        }
        catch {
            // already absent
        }
    },
};
const secretToolBackend = {
    name: "linux-secret-tool",
    get(account) {
        try {
            return execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", account], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            });
        }
        catch {
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
        }
        catch {
            // already absent
        }
    },
};
let override;
/** Test seam: force a backend (or null to force "none"). undefined = re-detect. */
export function setKeychainBackendForTests(backend) {
    override = backend;
}
/** The active backend for this platform, or null if none is available. */
export function detectKeychainBackend() {
    if (override !== undefined)
        return override;
    if (platform() === "darwin" && hasBinary("security"))
        return macosBackend;
    if (platform() === "linux" && hasBinary("secret-tool"))
        return secretToolBackend;
    return null;
}
