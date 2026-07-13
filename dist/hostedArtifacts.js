/** Version-aware hosted artifact transport for a human-paired CLI profile. */
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
function requestOptions(accessToken, timeoutMs) {
    return { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(timeoutMs) };
}
export async function readHostedArtifact(kind, key, options = {}) {
    const paired = broker();
    if (!paired)
        return { status: "unpaired" };
    try {
        const url = new URL(`${paired.baseUrl}${ENDPOINT}`);
        url.searchParams.set("kind", kind);
        url.searchParams.set("key", key);
        const response = await (options.fetchImpl ?? fetch)(url, requestOptions(paired.accessToken, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
        if (response.status === 404)
            return { status: "missing" };
        if (!response.ok)
            return { status: "unavailable", reason: `hosted artifact request failed (HTTP ${response.status})` };
        const state = await response.json();
        if (!state.artifactId || !Number.isSafeInteger(state.revision) || !state.document)
            return { status: "unavailable", reason: "hosted artifact response was invalid" };
        return { status: "found", state };
    }
    catch {
        return { status: "unavailable", reason: "hosted artifact request was unavailable" };
    }
}
export async function writeHostedArtifact(artifact, options = {}) {
    if (!artifact.key || artifact.key.length > 256 || !artifact.label || artifact.label.length > 200)
        throw new Error("Hosted artifact key/label is invalid.");
    const paired = broker();
    if (!paired)
        return { status: "unpaired" };
    try {
        const response = await (options.fetchImpl ?? fetch)(`${paired.baseUrl}${ENDPOINT}`, {
            method: "POST", ...requestOptions(paired.accessToken, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
            headers: { Authorization: `Bearer ${paired.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(artifact),
        });
        if (response.status === 409) {
            const body = await response.json();
            return { status: "conflict", reason: "hosted ICP changed since the last sync", currentRevision: body.currentRevision, documentSha256: body.documentSha256 };
        }
        if (!response.ok)
            return { status: "unavailable", reason: `hosted artifact request failed (HTTP ${response.status})` };
        const body = await response.json();
        if (typeof body.artifactId !== "string" || typeof body.created !== "boolean" || typeof body.updatedAt !== "number" || typeof body.revision !== "number" || typeof body.documentSha256 !== "string")
            return { status: "unavailable", reason: "hosted artifact response was invalid" };
        return { status: "saved", artifactId: body.artifactId, created: body.created, updatedAt: body.updatedAt, revision: body.revision, documentSha256: body.documentSha256, unchanged: body.unchanged === true };
    }
    catch {
        return { status: "unavailable", reason: "hosted artifact request was unavailable" };
    }
}
