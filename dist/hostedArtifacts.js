/** Best-effort artifact mirroring for a human-paired CLI profile. */
import { getCredential } from "./credentials.js";
const ENDPOINT = "/api/cli/artifact";
const DEFAULT_TIMEOUT_MS = 4000;
function broker() {
    const credential = getCredential("broker");
    if (!credential?.baseUrl || !credential.accessToken)
        return null;
    try {
        const url = new URL(credential.baseUrl);
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
            return null;
        return { baseUrl: url.href.replace(/\/+$/, ""), accessToken: credential.accessToken };
    }
    catch {
        return null;
    }
}
export async function writeHostedArtifact(artifact, options = {}) {
    if (!artifact.key || artifact.key.length > 256 || !artifact.label || artifact.label.length > 200) {
        throw new Error("Hosted artifact key/label is invalid.");
    }
    const paired = broker();
    if (!paired)
        return { status: "unpaired" };
    try {
        const response = await (options.fetchImpl ?? fetch)(`${paired.baseUrl}${ENDPOINT}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${paired.accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(artifact),
            signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (!response.ok)
            return { status: "unavailable", reason: `hosted artifact request failed (HTTP ${response.status})` };
        const body = await response.json();
        if (typeof body.created !== "boolean" || typeof body.updatedAt !== "number") {
            return { status: "unavailable", reason: "hosted artifact response was invalid" };
        }
        return { status: "saved", created: body.created, updatedAt: body.updatedAt };
    }
    catch {
        return { status: "unavailable", reason: "hosted artifact request was unavailable" };
    }
}
