import { chmodSync, existsSync, mkdirSync, readdirSync, unlinkSync, } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshHubspotToken } from "./connectors/hubspotAuth.js";
import { refreshSalesforceToken, validateSalesforceOrigin } from "./connectors/salesforceAuth.js";
import { detectKeychainBackend } from "./keychain.js";
import { assertNoSymlinkComponents, readSecureRegularFile, UnsafeManagedPathError, writeSecureFileAtomic, } from "./secureFile.js";
/**
 * Local CLI credential store: ~/.fullstackgtm/credentials.json (0600), or
 * $FSGTM_HOME/credentials.json when set. Environment tokens always win over
 * stored credentials so CI and agent sandboxes never touch the filesystem.
 *
 * Profiles let one operator hold credentials for several organizations at
 * once (a consultant working across client CRMs). The default profile keeps
 * the historical layout; a named profile scopes the entire home — credentials
 * AND stored plans — under `profiles/<name>/`, so a patch plan proposed
 * against one client's CRM can never be applied through another client's
 * credentials.
 */
export const DEFAULT_PROFILE = "default";
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
let explicitProfile = null;
export function validateProfileName(name) {
    if (!PROFILE_NAME_PATTERN.test(name) || name === "." || name === "..") {
        throw new Error(`Invalid profile name: ${JSON.stringify(name)}. Use letters, numbers, dots, dashes, ` +
            "or underscores (must start with a letter or number, max 64 characters).");
    }
    return name;
}
/** Select the profile for this process; wins over $FULLSTACKGTM_PROFILE. */
export function setActiveProfile(name) {
    explicitProfile = validateProfileName(name);
}
export function activeProfile() {
    if (explicitProfile)
        return explicitProfile;
    const fromEnv = process.env.FULLSTACKGTM_PROFILE;
    return fromEnv ? validateProfileName(fromEnv) : DEFAULT_PROFILE;
}
/** Base home directory, shared by every profile. */
export function baseHomeDir() {
    return process.env.FSGTM_HOME ?? join(homedir(), ".fullstackgtm");
}
/**
 * Profiles that exist on disk (have a directory), always including the
 * default profile. Existence does not imply stored credentials.
 */
export function listProfiles() {
    const names = new Set([DEFAULT_PROFILE]);
    try {
        for (const entry of readdirSync(join(baseHomeDir(), "profiles"), { withFileTypes: true })) {
            if (entry.isDirectory() && PROFILE_NAME_PATTERN.test(entry.name))
                names.add(entry.name);
        }
    }
    catch {
        // No profiles directory yet.
    }
    return Array.from(names).sort();
}
export function credentialsDir() {
    const base = baseHomeDir();
    const profile = activeProfile();
    return profile === DEFAULT_PROFILE ? base : join(base, "profiles", profile);
}
export function credentialsPath() {
    return join(credentialsDir(), "credentials.json");
}
/**
 * Create the fullstackgtm home directory and force it to 0700 even if it
 * already existed at looser permissions (mkdirSync's `mode` is ignored for
 * existing directories, and is subject to umask for new ones). All writers of
 * sensitive data under the home — credentials and plan files — go through
 * this so directory permissions are actually enforced, not merely requested.
 */
export function ensureSecureHomeDir() {
    const dir = credentialsDir();
    // A named profile nests under base/profiles/<name>; lock down every level
    // we create, not just the leaf — recursive mkdir applies `mode` (less
    // umask) only to directories it creates, and never to pre-existing ones.
    const levels = dir === baseHomeDir() ? [dir] : [baseHomeDir(), join(baseHomeDir(), "profiles"), dir];
    for (const level of levels) {
        assertNoSymlinkComponents(level);
        mkdirSync(level, { recursive: true, mode: 0o700 });
        assertNoSymlinkComponents(level);
        try {
            chmodSync(level, 0o700);
        }
        catch {
            // Non-POSIX filesystems (e.g. Windows) ignore chmod; nothing to enforce.
        }
    }
    return dir;
}
/** Write a 0600 file under the home, enforcing the mode even on rewrite. */
export function writeSecureFile(path, contents) {
    writeSecureFileAtomic(path, contents);
}
/**
 * The 0600/0700 guarantee was write-only: a credentials.json inherited at
 * looser permissions (a restored backup, a file created by another tool, a
 * cloned home) was read and trusted regardless of its actual mode. Enforce the
 * mode on read too — re-tighten to 0600 and warn once — so a world-readable
 * credential store can't sit there silently leaking the token to other users.
 */
function readCredentialFile(path) {
    return readSecureRegularFile(path, {
        tightenMode: 0o600,
        onModeTightened: (mode) => console.error(`fullstackgtm: tightened ${path} from ${mode.toString(8).padStart(3, "0")} to 600 ` +
            "(it was readable or writable by other users)."),
    });
}
/**
 * Persistence backend for the credential blob: the OS keychain when
 * FSGTM_KEYCHAIN=1 and one is available, otherwise the 0600 file. The keychain
 * account is derived from the credential file path so distinct homes/profiles
 * never collide in the machine-wide store.
 */
function activeKeychain() {
    if (process.env.FSGTM_KEYCHAIN !== "1")
        return null;
    const backend = detectKeychainBackend();
    if (!backend)
        return null;
    return { account: createHash("sha256").update(credentialsPath()).digest("hex").slice(0, 24), backend };
}
/**
 * When keychain is enabled on an install that previously wrote a plaintext
 * credentials.json, that file would otherwise sit on disk forever (readFile only
 * looks at the keychain). Import it into the keychain and remove it — the whole
 * point of keychain mode is that no plaintext credential remains at rest.
 */
function migratePlaintextToKeychain(keychain) {
    if (!existsSync(credentialsPath()))
        return;
    try {
        const fileParsed = JSON.parse(readCredentialFile(credentialsPath()));
        if (fileParsed && fileParsed.version === 1 && fileParsed.providers) {
            const current = keychain.backend.get(keychain.account);
            const existing = current ? (JSON.parse(current).providers ?? {}) : {};
            // Keychain entries win over the file on conflict (the file is the older copy).
            const merged = { version: 1, providers: { ...fileParsed.providers, ...existing } };
            keychain.backend.set(keychain.account, `${JSON.stringify(merged, null, 2)}\n`);
        }
        unlinkSync(credentialsPath());
        console.error("fullstackgtm: migrated credentials.json into the OS keychain and removed the plaintext file.");
    }
    catch {
        // Best effort: a malformed/locked file is left in place rather than lost.
    }
}
function readFile() {
    const keychain = activeKeychain();
    if (keychain)
        migratePlaintextToKeychain(keychain);
    try {
        const raw = keychain ? keychain.backend.get(keychain.account) : readCredentialFile(credentialsPath());
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.providers) {
                return parsed;
            }
        }
    }
    catch (error) {
        if (error instanceof UnsafeManagedPathError)
            throw error;
        // Missing or unreadable store falls through to an empty one.
    }
    return { version: 1, providers: {} };
}
function persist(file) {
    const keychain = activeKeychain();
    const blob = `${JSON.stringify(file, null, 2)}\n`;
    if (keychain) {
        keychain.backend.set(keychain.account, blob);
    }
    else {
        ensureSecureHomeDir();
        writeSecureFile(credentialsPath(), blob);
    }
}
export function getCredential(provider) {
    return readFile().providers[provider] ?? null;
}
export function storeCredential(provider, credential) {
    if (provider === "salesforce") {
        if (!credential.instanceUrl) {
            throw new Error("Salesforce credentials require an instance URL.");
        }
        credential = {
            ...credential,
            instanceUrl: validateSalesforceOrigin(credential.instanceUrl, "Salesforce credential instance URL"),
            ...(credential.loginUrl
                ? { loginUrl: validateSalesforceOrigin(credential.loginUrl, "Salesforce credential login URL") }
                : {}),
        };
    }
    const file = readFile();
    file.providers[provider] = credential;
    persist(file);
}
export function deleteCredential(provider) {
    const file = readFile();
    if (!file.providers[provider])
        return false;
    delete file.providers[provider];
    const keychain = activeKeychain();
    if (Object.keys(file.providers).length === 0) {
        if (keychain) {
            keychain.backend.delete(keychain.account);
            // Defensive: remove any leftover plaintext file too (migration normally
            // already did, but never leave a credential blob on disk after logout).
            if (existsSync(credentialsPath()))
                unlinkSync(credentialsPath());
            return true;
        }
        if (existsSync(credentialsPath())) {
            unlinkSync(credentialsPath());
            return true;
        }
    }
    persist(file);
    return true;
}
const REFRESH_SKEW_MS = 2 * 60 * 1000;
/**
 * Resolve HubSpot access from stored credentials. Direct logins win over the
 * broker so an operator can always override the team default:
 * 1. stored hubspot login (private app token, or OAuth with silent refresh)
 * 2. stored broker pairing — exchanges the CLI token for a short-lived
 *    provider token minted by the hosted deployment from the org's stored
 *    sync credentials (and inherits the org's field mappings)
 */
export async function resolveHubspotConnection(options = {}) {
    const credential = getCredential("hubspot");
    if (credential) {
        return { accessToken: await directHubspotToken(credential, options) };
    }
    const minted = await brokerMint("hubspot", options);
    if (!minted)
        return null;
    return { accessToken: minted.accessToken, fieldMappings: minted.fieldMappings };
}
/**
 * Resolve Salesforce access from stored credentials, same ladder shape as
 * HubSpot: direct login (with silent device-flow refresh) wins over broker.
 */
export async function resolveSalesforceConnection(options = {}) {
    const credential = getCredential("salesforce");
    if (credential) {
        if (!credential.instanceUrl) {
            throw new Error("Stored Salesforce credential has no instance URL. Run `fullstackgtm login salesforce` again.");
        }
        const instanceUrl = validateSalesforceOrigin(credential.instanceUrl, "Stored Salesforce credential instance URL");
        if (credential.loginUrl) {
            validateSalesforceOrigin(credential.loginUrl, "Stored Salesforce credential login URL");
        }
        const needsRefresh = credential.kind === "oauth" &&
            credential.expiresAt !== undefined &&
            Date.now() > credential.expiresAt - REFRESH_SKEW_MS;
        if (!needsRefresh) {
            return { accessToken: credential.accessToken, instanceUrl };
        }
        if (!credential.refreshToken || !credential.clientId) {
            throw new Error("Stored Salesforce token is expired and cannot be refreshed. Run `fullstackgtm login salesforce` again.");
        }
        const refreshed = await refreshSalesforceToken({
            clientId: credential.clientId,
            refreshToken: credential.refreshToken,
            loginUrl: credential.loginUrl,
            fetchImpl: options.fetchImpl,
        });
        storeCredential("salesforce", {
            ...credential,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? credential.refreshToken,
            instanceUrl: refreshed.instanceUrl,
            expiresAt: refreshed.expiresAt,
            updatedAt: new Date().toISOString(),
        });
        return { accessToken: refreshed.accessToken, instanceUrl: refreshed.instanceUrl };
    }
    const minted = await brokerMint("salesforce", options);
    if (!minted)
        return null;
    if (!minted.instanceUrl) {
        throw new Error("The hosted deployment returned no Salesforce instance URL.");
    }
    const instanceUrl = validateSalesforceOrigin(minted.instanceUrl, "Hosted Salesforce credential instance URL");
    return {
        accessToken: minted.accessToken,
        instanceUrl,
        fieldMappings: minted.fieldMappings,
    };
}
async function brokerMint(provider, options) {
    const broker = getCredential("broker");
    if (!broker?.baseUrl)
        return null;
    // The mint replays the long-lived bearer and receives a live CRM token —
    // refuse to do so over cleartext even if a tampered store points us at http.
    const brokerUrl = new URL(broker.baseUrl);
    const localhost = brokerUrl.hostname === "localhost" || brokerUrl.hostname === "127.0.0.1" || brokerUrl.hostname === "::1" || brokerUrl.hostname === "[::1]";
    if (brokerUrl.protocol !== "https:" && !(brokerUrl.protocol === "http:" && localhost)) {
        throw new Error(`Refusing to mint a CRM token over ${brokerUrl.protocol}//${brokerUrl.host} — the broker must use https. Re-pair with an https deployment.`);
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${broker.baseUrl.replace(/\/$/, "")}/api/cli/token`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${broker.accessToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider }),
    });
    if (response.status === 401) {
        throw new Error(`The hosted deployment rejected this CLI's broker token. Run \`fullstackgtm login --via ${broker.baseUrl}\` again.`);
    }
    if (!response.ok) {
        // Withhold the deployment's raw response body from the error.
        throw new Error(`Broker token exchange failed: HTTP ${response.status} ${response.statusText}`.trim());
    }
    const connection = await response.json();
    return {
        accessToken: String(connection.accessToken),
        instanceUrl: connection.instanceUrl ? String(connection.instanceUrl) : undefined,
        fieldMappings: connection.fieldMappings ?? undefined,
    };
}
/**
 * Resolve a usable HubSpot access token (direct login or broker). Returns
 * null when nothing is stored (callers fall back to instructions).
 */
export async function resolveHubspotAccessToken(options = {}) {
    const connection = await resolveHubspotConnection(options);
    return connection?.accessToken ?? null;
}
async function directHubspotToken(credential, options) {
    const needsRefresh = credential.kind === "oauth" &&
        credential.expiresAt !== undefined &&
        Date.now() > credential.expiresAt - REFRESH_SKEW_MS;
    if (!needsRefresh)
        return credential.accessToken;
    if (!credential.refreshToken || !credential.clientId || !credential.clientSecret) {
        throw new Error("Stored HubSpot OAuth token is expired and cannot be refreshed. Run `fullstackgtm login hubspot` again.");
    }
    const refreshed = await refreshHubspotToken({
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
        refreshToken: credential.refreshToken,
        fetchImpl: options.fetchImpl,
    });
    storeCredential("hubspot", {
        ...credential,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? credential.refreshToken,
        expiresAt: refreshed.expiresAt,
        updatedAt: new Date().toISOString(),
    });
    return refreshed.accessToken;
}
