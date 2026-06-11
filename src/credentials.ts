import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshHubspotToken } from "./connectors/hubspotAuth.ts";
import { refreshSalesforceToken } from "./connectors/salesforceAuth.ts";

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

let explicitProfile: string | null = null;

export function validateProfileName(name: string): string {
  if (!PROFILE_NAME_PATTERN.test(name) || name === "." || name === "..") {
    throw new Error(
      `Invalid profile name: ${JSON.stringify(name)}. Use letters, numbers, dots, dashes, ` +
        "or underscores (must start with a letter or number, max 64 characters).",
    );
  }
  return name;
}

/** Select the profile for this process; wins over $FULLSTACKGTM_PROFILE. */
export function setActiveProfile(name: string) {
  explicitProfile = validateProfileName(name);
}

export function activeProfile(): string {
  if (explicitProfile) return explicitProfile;
  const fromEnv = process.env.FULLSTACKGTM_PROFILE;
  return fromEnv ? validateProfileName(fromEnv) : DEFAULT_PROFILE;
}

/** Base home directory, shared by every profile. */
export function baseHomeDir(): string {
  return process.env.FSGTM_HOME ?? join(homedir(), ".fullstackgtm");
}

/**
 * Profiles that exist on disk (have a directory), always including the
 * default profile. Existence does not imply stored credentials.
 */
export function listProfiles(): string[] {
  const names = new Set([DEFAULT_PROFILE]);
  try {
    for (const entry of readdirSync(join(baseHomeDir(), "profiles"), { withFileTypes: true })) {
      if (entry.isDirectory() && PROFILE_NAME_PATTERN.test(entry.name)) names.add(entry.name);
    }
  } catch {
    // No profiles directory yet.
  }
  return Array.from(names).sort();
}

export type StoredCredential = {
  kind: "private_app" | "oauth" | "broker";
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires (oauth only). */
  expiresAt?: number;
  /** Client credentials kept for refresh when the user brings their own app. */
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  /** Hosted FullStackGTM deployment the broker token belongs to. */
  baseUrl?: string;
  /** Salesforce instance URL the access token belongs to. */
  instanceUrl?: string;
  /** Salesforce login host used for device flow refresh. */
  loginUrl?: string;
  createdAt: string;
  updatedAt: string;
};

type CredentialsFile = {
  version: 1;
  providers: Record<string, StoredCredential>;
};

export function credentialsDir(): string {
  const base = baseHomeDir();
  const profile = activeProfile();
  return profile === DEFAULT_PROFILE ? base : join(base, "profiles", profile);
}

export function credentialsPath(): string {
  return join(credentialsDir(), "credentials.json");
}

/**
 * Create the fullstackgtm home directory and force it to 0700 even if it
 * already existed at looser permissions (mkdirSync's `mode` is ignored for
 * existing directories, and is subject to umask for new ones). All writers of
 * sensitive data under the home — credentials and plan files — go through
 * this so directory permissions are actually enforced, not merely requested.
 */
export function ensureSecureHomeDir(): string {
  const dir = credentialsDir();
  // A named profile nests under base/profiles/<name>; lock down every level
  // we create, not just the leaf — recursive mkdir applies `mode` (less
  // umask) only to directories it creates, and never to pre-existing ones.
  const levels =
    dir === baseHomeDir() ? [dir] : [baseHomeDir(), join(baseHomeDir(), "profiles"), dir];
  for (const level of levels) {
    mkdirSync(level, { recursive: true, mode: 0o700 });
    try {
      chmodSync(level, 0o700);
    } catch {
      // Non-POSIX filesystems (e.g. Windows) ignore chmod; nothing to enforce.
    }
  }
  return dir;
}

/** Write a 0600 file under the home, enforcing the mode even on rewrite. */
export function writeSecureFile(path: string, contents: string) {
  writeFileSync(path, contents, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-POSIX filesystems ignore chmod.
  }
}

function readFile(): CredentialsFile {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath(), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.providers) {
      return parsed as CredentialsFile;
    }
  } catch {
    // Missing or unreadable file falls through to an empty store.
  }
  return { version: 1, providers: {} };
}

export function getCredential(provider: string): StoredCredential | null {
  return readFile().providers[provider] ?? null;
}

export function storeCredential(provider: string, credential: StoredCredential) {
  const file = readFile();
  file.providers[provider] = credential;
  ensureSecureHomeDir();
  writeSecureFile(credentialsPath(), `${JSON.stringify(file, null, 2)}\n`);
}

export function deleteCredential(provider: string): boolean {
  const file = readFile();
  if (!file.providers[provider]) return false;
  delete file.providers[provider];
  if (Object.keys(file.providers).length === 0 && existsSync(credentialsPath())) {
    unlinkSync(credentialsPath());
    return true;
  }
  writeSecureFile(credentialsPath(), `${JSON.stringify(file, null, 2)}\n`);
  return true;
}

const REFRESH_SKEW_MS = 2 * 60 * 1000;

export type HubspotConnection = {
  accessToken: string;
  /** Org-level field mapping overrides, supplied by broker deployments. */
  fieldMappings?: unknown;
};

/**
 * Resolve HubSpot access from stored credentials. Direct logins win over the
 * broker so an operator can always override the team default:
 * 1. stored hubspot login (private app token, or OAuth with silent refresh)
 * 2. stored broker pairing — exchanges the CLI token for a short-lived
 *    provider token minted by the hosted deployment from the org's stored
 *    sync credentials (and inherits the org's field mappings)
 */
export async function resolveHubspotConnection(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<HubspotConnection | null> {
  const credential = getCredential("hubspot");
  if (credential) {
    return { accessToken: await directHubspotToken(credential, options) };
  }

  const minted = await brokerMint("hubspot", options);
  if (!minted) return null;
  return { accessToken: minted.accessToken, fieldMappings: minted.fieldMappings };
}

export type SalesforceStoredConnection = {
  accessToken: string;
  instanceUrl: string;
  /** Org-level field mapping overrides, supplied by broker deployments. */
  fieldMappings?: unknown;
};

/**
 * Resolve Salesforce access from stored credentials, same ladder shape as
 * HubSpot: direct login (with silent device-flow refresh) wins over broker.
 */
export async function resolveSalesforceConnection(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<SalesforceStoredConnection | null> {
  const credential = getCredential("salesforce");
  if (credential) {
    if (!credential.instanceUrl) {
      throw new Error(
        "Stored Salesforce credential has no instance URL. Run `fullstackgtm login salesforce` again.",
      );
    }
    const needsRefresh =
      credential.kind === "oauth" &&
      credential.expiresAt !== undefined &&
      Date.now() > credential.expiresAt - REFRESH_SKEW_MS;
    if (!needsRefresh) {
      return { accessToken: credential.accessToken, instanceUrl: credential.instanceUrl };
    }
    if (!credential.refreshToken || !credential.clientId) {
      throw new Error(
        "Stored Salesforce token is expired and cannot be refreshed. Run `fullstackgtm login salesforce` again.",
      );
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
  if (!minted) return null;
  if (!minted.instanceUrl) {
    throw new Error("The hosted deployment returned no Salesforce instance URL.");
  }
  return {
    accessToken: minted.accessToken,
    instanceUrl: minted.instanceUrl,
    fieldMappings: minted.fieldMappings,
  };
}

async function brokerMint(
  provider: "hubspot" | "salesforce",
  options: { fetchImpl?: typeof fetch },
): Promise<{ accessToken: string; instanceUrl?: string; fieldMappings?: unknown } | null> {
  const broker = getCredential("broker");
  if (!broker?.baseUrl) return null;
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
    throw new Error(
      `The hosted deployment rejected this CLI's broker token. Run \`fullstackgtm login --via ${broker.baseUrl}\` again.`,
    );
  }
  if (!response.ok) {
    // Withhold the deployment's raw response body from the error.
    throw new Error(
      `Broker token exchange failed: HTTP ${response.status} ${response.statusText}`.trim(),
    );
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
export async function resolveHubspotAccessToken(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const connection = await resolveHubspotConnection(options);
  return connection?.accessToken ?? null;
}

async function directHubspotToken(
  credential: StoredCredential,
  options: { fetchImpl?: typeof fetch },
): Promise<string> {
  const needsRefresh =
    credential.kind === "oauth" &&
    credential.expiresAt !== undefined &&
    Date.now() > credential.expiresAt - REFRESH_SKEW_MS;

  if (!needsRefresh) return credential.accessToken;
  if (!credential.refreshToken || !credential.clientId || !credential.clientSecret) {
    throw new Error(
      "Stored HubSpot OAuth token is expired and cannot be refreshed. Run `fullstackgtm login hubspot` again.",
    );
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
