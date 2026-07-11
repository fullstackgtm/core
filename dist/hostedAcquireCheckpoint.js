/**
 * Authenticated acquisition-checkpoint transport for paired CLI installs.
 *
 * The local checkpoint remains authoritative for running a job. This module
 * only mirrors/query-scoped continuation state to the paired hosted app so a
 * different authenticated worker can resume it. Writes use compare-and-swap:
 * a stale client receives a conflict and must explicitly reconcile instead of
 * silently moving a provider cursor backwards or overwriting another worker.
 */
import { getCredential } from "./credentials.js";
const ENDPOINT = "/api/cli/acquisition-checkpoint";
const DEFAULT_TIMEOUT_MS = 4000;
const CHECKPOINT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
function validKey(key) {
    if (!CHECKPOINT_KEY.test(key)) {
        throw new Error("Acquisition checkpoint key must be 1-256 URL-safe characters.");
    }
    return key;
}
function broker() {
    const credential = getCredential("broker");
    if (!credential?.baseUrl || !credential.accessToken)
        return null;
    let url;
    try {
        url = new URL(credential.baseUrl);
    }
    catch {
        return null;
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
        return null;
    return { baseUrl: url.href.replace(/\/+$/, ""), accessToken: credential.accessToken };
}
function isCheckpoint(value) {
    if (!value || typeof value !== "object")
        return false;
    const item = value;
    return (typeof item.queryFingerprint === "string" &&
        item.queryFingerprint.length > 0 &&
        typeof item.exhausted === "boolean" &&
        (item.cursor === undefined || item.cursor === null || typeof item.cursor === "string") &&
        (item.offset === undefined || item.offset === null ||
            (typeof item.offset === "number" && Number.isSafeInteger(item.offset) && item.offset >= 0)));
}
function parseRecord(value) {
    if (!value || typeof value !== "object")
        return null;
    const body = value;
    if (!isCheckpoint(body.checkpoint) || !Number.isSafeInteger(body.version) || body.version < 1)
        return null;
    if (!Number.isSafeInteger(body.updatedAt) || body.updatedAt < 0)
        return null;
    return {
        checkpoint: body.checkpoint,
        version: body.version,
        updatedAt: body.updatedAt,
    };
}
function reasonFor(status) {
    if (status === 401 || status === 403)
        return "hosted authentication was rejected; pair the CLI again";
    return `hosted checkpoint request failed (HTTP ${status})`;
}
/** Read a query/list checkpoint. Inert unless this profile is paired. */
export async function readHostedAcquireCheckpoint(key, options = {}) {
    validKey(key);
    const paired = broker();
    if (!paired)
        return { status: "unpaired" };
    try {
        const response = await (options.fetchImpl ?? fetch)(`${paired.baseUrl}${ENDPOINT}?key=${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${paired.accessToken}`, Accept: "application/json" },
            signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (response.status === 404)
            return { status: "missing" };
        if (!response.ok)
            return { status: "unavailable", reason: reasonFor(response.status) };
        const record = parseRecord(await response.json());
        return record
            ? { status: "found", record }
            : { status: "unavailable", reason: "hosted checkpoint response was invalid" };
    }
    catch {
        return { status: "unavailable", reason: "hosted checkpoint request was unavailable" };
    }
}
/**
 * Mirror a local checkpoint using compare-and-swap. Pass null only when the
 * caller observed no hosted record (sent as version zero); pass the exact
 * positive version returned by read for an update.
 */
export async function writeHostedAcquireCheckpoint(key, checkpoint, expectedVersion, options = {}) {
    validKey(key);
    if (!isCheckpoint(checkpoint))
        throw new Error("Refusing to sync an invalid acquisition checkpoint.");
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
        throw new Error("expectedVersion must be null or a positive integer.");
    }
    const paired = broker();
    if (!paired)
        return { status: "unpaired" };
    try {
        const response = await (options.fetchImpl ?? fetch)(`${paired.baseUrl}${ENDPOINT}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${paired.accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ key, checkpoint, expectedVersion: expectedVersion ?? 0 }),
            signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (response.status === 409) {
            const body = await response.json().catch(() => null);
            const current = body && typeof body === "object"
                ? parseRecord(body.current)
                : null;
            return { status: "conflict", current };
        }
        if (!response.ok)
            return { status: "unavailable", reason: reasonFor(response.status) };
        const record = parseRecord(await response.json());
        return record
            ? { status: "saved", record }
            : { status: "unavailable", reason: "hosted checkpoint response was invalid" };
    }
    catch {
        return { status: "unavailable", reason: "hosted checkpoint request was unavailable" };
    }
}
