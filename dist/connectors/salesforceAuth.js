/**
 * Salesforce CLI authentication.
 *
 * Salesforce supports the device-authorization grant natively, which is the
 * ideal CLI shape: no localhost server, no client secret — just a code the
 * user confirms on any device. Requires a Connected App with device flow
 * enabled; only its consumer key (client id) is needed.
 */
const DEFAULT_LOGIN_URL = "https://login.salesforce.com";
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
function tokenUrl(loginUrl) {
    return `${loginUrl.replace(/\/$/, "")}/services/oauth2/token`;
}
/**
 * OAuth error responses can echo request parameters. Surface only the
 * standard `error`/`error_description` fields, never the raw body.
 */
async function safeTokenError(response) {
    let description;
    try {
        const data = await response.json();
        description = data?.error_description ?? data?.error;
    }
    catch {
        // Non-JSON body — withhold it entirely.
    }
    return description
        ? `${response.status} (${String(description).slice(0, 200)})`
        : `HTTP ${response.status} ${response.statusText}`.trim();
}
export async function startSalesforceDeviceLogin(options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(tokenUrl(options.loginUrl ?? DEFAULT_LOGIN_URL), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            response_type: "device_code",
            client_id: options.clientId,
            scope: "api refresh_token",
        }).toString(),
    });
    if (!response.ok) {
        throw new Error(`Salesforce device authorization failed: ${await safeTokenError(response)}`);
    }
    const data = await response.json();
    return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        intervalSeconds: Number(data.interval ?? 5),
    };
}
export async function pollSalesforceDeviceLogin(options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const url = tokenUrl(options.loginUrl ?? DEFAULT_LOGIN_URL);
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60 * 1000);
    let intervalMs = Math.max(1, options.intervalSeconds) * 1000;
    while (Date.now() < deadline) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs));
        const response = await fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "device",
                client_id: options.clientId,
                code: options.deviceCode,
            }).toString(),
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data.access_token && data.instance_url) {
            return {
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
                instanceUrl: data.instance_url,
                expiresAt: Date.now() + SESSION_TTL_MS,
            };
        }
        if (data.error === "authorization_pending")
            continue;
        if (data.error === "slow_down") {
            intervalMs += 5000;
            continue;
        }
        throw new Error(`Salesforce device login failed: ${data.error_description ?? data.error ?? response.status}`);
    }
    throw new Error("Timed out waiting for Salesforce device authorization.");
}
export async function refreshSalesforceToken(options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(tokenUrl(options.loginUrl ?? DEFAULT_LOGIN_URL), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: options.clientId,
            refresh_token: options.refreshToken,
        }).toString(),
    });
    if (!response.ok) {
        throw new Error(`Salesforce token refresh failed: ${await safeTokenError(response)}`);
    }
    const data = await response.json();
    if (!data.access_token || !data.instance_url) {
        throw new Error("Salesforce refresh response had no access_token/instance_url.");
    }
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? options.refreshToken,
        instanceUrl: data.instance_url,
        expiresAt: Date.now() + SESSION_TTL_MS,
    };
}
export async function validateSalesforceToken(accessToken, instanceUrl, fetchImpl = fetch) {
    let response;
    try {
        response = await fetchImpl(`${instanceUrl.replace(/\/$/, "")}/services/oauth2/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` } });
    }
    catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
        return {
            ok: false,
            detail: `Cannot reach Salesforce at ${instanceUrl}${cause}. Check the --instance-url (your My Domain URL, e.g. https://yourco.my.salesforce.com) and network access.`,
        };
    }
    if (response.ok) {
        return { ok: true, detail: "Token accepted by the Salesforce API." };
    }
    // Never echo the response body: provider error payloads can reflect request
    // details and end up in logs or shell scrollback.
    return {
        ok: false,
        detail: `Salesforce rejected the token: HTTP ${response.status} ${response.statusText}`.trim(),
    };
}
