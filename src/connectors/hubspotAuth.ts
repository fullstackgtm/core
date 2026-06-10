import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

/**
 * HubSpot CLI authentication.
 *
 * Two paths, ordered by how little web they need:
 * 1. Private app token — no OAuth at all; created once in HubSpot settings.
 * 2. Bring-your-own-app OAuth with an RFC 8252 loopback redirect — the
 *    browser is used for exactly one thing (the consent grant); the CLI
 *    captures the code on 127.0.0.1 and performs the exchange itself.
 *
 * HubSpot does not support the device-authorization grant or PKCE-only
 * public clients, so the loopback flow requires the user's own app client
 * id/secret, which are kept locally for silent refresh.
 */

const HS_AUTH_URL = "https://app.hubspot.com/oauth/authorize";
const HS_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const HS_API_URL = "https://api.hubapi.com";

export const DEFAULT_OAUTH_SCOPES = [
  "crm.objects.deals.read",
  "crm.objects.owners.read",
  "crm.objects.companies.read",
  "crm.objects.contacts.read",
  "crm.objects.deals.write",
];

export const DEFAULT_LOOPBACK_PORT = 8763;

/**
 * OAuth error responses can echo request parameters (client_secret, code).
 * Surface only the standard `error`/`error_description` fields, never the raw
 * body, so secrets never reach logs.
 */
async function safeTokenError(response: Response): Promise<string> {
  let description: string | undefined;
  try {
    const data = await response.json();
    description = data?.error_description ?? data?.error ?? data?.message;
  } catch {
    // Non-JSON body — withhold it entirely.
  }
  return description
    ? `${response.status} (${String(description).slice(0, 200)})`
    : `HTTP ${response.status} ${response.statusText}`.trim();
}

export type HubspotTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
};

export async function validateHubspotToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string }> {
  const response = await fetchImpl(`${HS_API_URL}/crm/v3/owners?limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.ok) {
    return { ok: true, detail: "Token accepted by the HubSpot CRM API." };
  }
  const body = await response.text();
  return { ok: false, detail: `HubSpot rejected the token (${response.status}): ${body}` };
}

async function tokenRequest(
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<HubspotTokenSet> {
  const response = await fetchImpl(HS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    throw new Error(`HubSpot token request failed: ${await safeTokenError(response)}`);
  }
  const data = await response.json();
  if (!data.access_token) throw new Error("HubSpot token response had no access_token.");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 1800) * 1000,
  };
}

export async function exchangeHubspotCode(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<HubspotTokenSet> {
  return tokenRequest(
    {
      grant_type: "authorization_code",
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      code: options.code,
    },
    options.fetchImpl ?? fetch,
  );
}

export async function refreshHubspotToken(options: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<HubspotTokenSet> {
  return tokenRequest(
    {
      grant_type: "refresh_token",
      client_id: options.clientId,
      client_secret: options.clientSecret,
      refresh_token: options.refreshToken,
    },
    options.fetchImpl ?? fetch,
  );
}

export type LoopbackLoginOptions = {
  clientId: string;
  clientSecret: string;
  /** Must match a redirect URL registered on the HubSpot app: http://localhost:<port>/callback */
  port?: number;
  scopes?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Receives the authorize URL; default prints it and best-effort opens a browser. */
  openUrl?: (url: string) => void | Promise<void>;
  log?: (message: string) => void;
};

/**
 * RFC 8252 loopback OAuth: serve one request on 127.0.0.1, send the user to
 * the provider consent page, capture the code locally, exchange it directly.
 */
export async function runHubspotLoopbackLogin(
  options: LoopbackLoginOptions,
): Promise<HubspotTokenSet> {
  const port = options.port ?? DEFAULT_LOOPBACK_PORT;
  const scopes = options.scopes ?? DEFAULT_OAUTH_SCOPES;
  const log = options.log ?? ((message: string) => console.error(message));
  const redirectUri = `http://localhost:${port}/callback`;
  const state = randomBytes(16).toString("hex");

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const receivedState = url.searchParams.get("state");
      const receivedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        "<html><body><p>FullStackGTM CLI login complete. You can close this tab.</p></body></html>",
      );
      server.close();
      clearTimeout(timer);
      if (error) {
        reject(new Error(`HubSpot authorization failed: ${error}`));
      } else if (receivedState !== state) {
        reject(new Error("OAuth state mismatch; aborting login."));
      } else if (!receivedCode) {
        reject(new Error("HubSpot redirected without an authorization code."));
      } else {
        resolve(receivedCode);
      }
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the OAuth redirect."));
    }, options.timeoutMs ?? 5 * 60 * 1000);

    server.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    server.listen(port, "127.0.0.1", () => {
      const authorizeUrl =
        `${HS_AUTH_URL}?` +
        new URLSearchParams({
          response_type: "code",
          client_id: options.clientId,
          redirect_uri: redirectUri,
          scope: scopes.join(" "),
          state,
        }).toString();
      log(`Open this URL to authorize (waiting on ${redirectUri}):\n\n  ${authorizeUrl}\n`);
      void (options.openUrl ?? openInBrowser)(authorizeUrl);
    });
  });

  return exchangeHubspotCode({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri,
    code,
    fetchImpl: options.fetchImpl,
  });
}

export async function openInBrowser(url: string) {
  // The URL may come from an external source (e.g. a broker deployment's
  // verification URL). Only ever hand a well-formed http(s) URL to the OS
  // opener — this prevents a leading `-` from being read as a flag by
  // xdg-open and refuses non-web schemes outright.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  const safeUrl = parsed.toString();

  const { spawn } = await import("node:child_process");
  try {
    if (process.platform === "darwin") {
      spawn("open", [safeUrl], { stdio: "ignore", detached: true }).on("error", () => {});
    } else if (process.platform === "win32") {
      // `start` is a cmd builtin, not an executable; the empty "" is the
      // window title so a URL with characters isn't mis-parsed as the title.
      spawn("cmd", ["/c", "start", "", safeUrl], { stdio: "ignore", detached: true }).on(
        "error",
        () => {},
      );
    } else {
      // `--` ends option parsing so the URL is never treated as a flag.
      spawn("xdg-open", ["--", safeUrl], { stdio: "ignore", detached: true }).on("error", () => {});
    }
  } catch {
    // Printing the URL is the contract; opening a browser is best-effort.
  }
}
