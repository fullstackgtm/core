import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseIcp } from "./icp.js";
import { readSecureRegularFile, writeSecureFileAtomic } from "./secureFile.js";
import { readHostedArtifact, writeHostedArtifact } from "./hostedArtifacts.js";
export function classifyIcpSync(localHash, hostedRevision, hostedHash, tracked) {
    if (!tracked)
        return localHash === hostedHash ? "in_sync" : "untracked";
    const localChanged = localHash !== tracked.localIcpSha256;
    const hostedChanged = hostedRevision !== tracked.revision;
    return localChanged && hostedChanged ? "conflict" : localChanged ? "local_changed" : hostedChanged ? "hosted_changed" : "in_sync";
}
export function canonicalJson(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    const object = value;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
export const icpSha256 = (icp) => createHash("sha256").update(canonicalJson(icp)).digest("hex");
export function artifactKeyForDomain(domain) {
    const candidate = /^https?:\/\//i.test(domain.trim()) ? domain.trim() : `https://${domain.trim()}`;
    let parsed;
    try {
        parsed = new URL(candidate);
    }
    catch {
        throw new Error(`Invalid company domain: ${domain}`);
    }
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    if (!hostname.includes("."))
        throw new Error(`Invalid public company domain: ${domain}`);
    return `icp:${hostname}`;
}
export const sidecarPathFor = (icpPath) => resolve(dirname(resolve(icpPath)), ".fullstackgtm", `${resolve(icpPath).split(/[\\/]/).pop()}.sync.json`);
export function readLocalIcp(path) { return parseIcp(readSecureRegularFile(resolve(path))); }
export function extractHostedIcp(state) {
    const root = state.document && typeof state.document === "object" && !Array.isArray(state.document) ? state.document : {};
    return parseIcp(JSON.stringify(root.icp ?? state.document));
}
export function readIcpSyncState(icpPath) {
    const path = sidecarPathFor(icpPath);
    if (!existsSync(path))
        return null;
    try {
        const value = JSON.parse(readSecureRegularFile(path));
        return value?.version === 1 ? value : null;
    }
    catch {
        return null;
    }
}
export function writeIcpSyncState(icpPath, state) {
    const path = sidecarPathFor(icpPath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeSecureFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}
export async function getIcpSyncStatus(icpPath, domain) {
    const local = readLocalIcp(icpPath);
    const localHash = icpSha256(local);
    const tracked = readIcpSyncState(icpPath);
    const read = await readHostedArtifact("icp", artifactKeyForDomain(domain));
    if (read.status === "unpaired")
        return { local, status: { state: "unpaired", localIcpSha256: localHash } };
    if (read.status === "missing")
        return { local, status: { state: "missing_hosted", localIcpSha256: localHash } };
    if (read.status === "unavailable")
        return { local, status: { state: "unavailable", localIcpSha256: localHash, reason: read.reason } };
    const hostedHash = icpSha256(extractHostedIcp(read.state));
    const state = classifyIcpSync(localHash, read.state.revision, hostedHash, tracked);
    return { local, hosted: read.state, status: { state, localIcpSha256: localHash, hostedRevision: read.state.revision, trackedRevision: tracked?.revision } };
}
export function markIcpSynced(icpPath, domain, hosted, icp) {
    const key = artifactKeyForDomain(domain);
    const normalizedDomain = key.slice("icp:".length);
    writeIcpSyncState(icpPath, { version: 1, artifactId: hosted.artifactId, key, domain: normalizedDomain, revision: hosted.revision, localIcpSha256: icpSha256(icp), hostedDocumentSha256: hosted.documentSha256, syncedAt: new Date().toISOString() });
}
export async function pushIcp(icpPath, domain, changeSummary) {
    const checked = await getIcpSyncStatus(icpPath, domain);
    if (checked.status.state === "conflict" || checked.status.state === "hosted_changed" || checked.status.state === "untracked")
        return { status: "conflict", checked };
    const current = checked.hosted;
    const root = current?.document && typeof current.document === "object" && !Array.isArray(current.document) ? current.document : {};
    const key = artifactKeyForDomain(domain);
    const normalizedDomain = key.slice("icp:".length);
    const document = Object.keys(root).length ? { ...root, icp: checked.local, humanReview: { reviewedAt: new Date().toISOString(), source: "cli" } } : { company: { domain: normalizedDomain }, icp: checked.local, evidence: [], humanReview: { reviewedAt: new Date().toISOString(), source: "cli" } };
    const result = await writeHostedArtifact({ kind: "icp", key, label: checked.local.name, domain: normalizedDomain, document, expectedRevision: current?.revision ?? 0, changeSummary });
    if (result.status === "saved")
        markIcpSynced(icpPath, domain, { artifactId: result.artifactId, revision: result.revision, documentSha256: result.documentSha256 }, checked.local);
    return { status: result.status, result, checked };
}
