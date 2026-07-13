import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseIcp, type Icp } from "./icp.ts";
import { readSecureRegularFile, writeSecureFileAtomic } from "./secureFile.ts";
import { readHostedArtifact, writeHostedArtifact, type HostedArtifactState } from "./hostedArtifacts.ts";

export type IcpSyncState = { version: 1; artifactId: string; key: string; domain: string; revision: number; localIcpSha256: string; hostedDocumentSha256?: string; syncedAt: string };
export type IcpSyncStatus = { state: "unpaired" | "missing_hosted" | "in_sync" | "local_changed" | "hosted_changed" | "conflict" | "untracked" | "unavailable"; localIcpSha256: string; hostedRevision?: number; trackedRevision?: number; reason?: string };

export function classifyIcpSync(localHash: string, hostedRevision: number, hostedHash: string, tracked: IcpSyncState | null): IcpSyncStatus["state"] {
  if (!tracked) return localHash === hostedHash ? "in_sync" : "untracked";
  const localChanged = localHash !== tracked.localIcpSha256;
  const hostedChanged = hostedRevision !== tracked.revision;
  return localChanged && hostedChanged ? "conflict" : localChanged ? "local_changed" : hostedChanged ? "hosted_changed" : "in_sync";
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
export const icpSha256 = (icp: Icp) => createHash("sha256").update(canonicalJson(icp)).digest("hex");
export function artifactKeyForDomain(domain: string): string {
  const candidate = /^https?:\/\//i.test(domain.trim()) ? domain.trim() : `https://${domain.trim()}`;
  let parsed: URL; try { parsed = new URL(candidate); } catch { throw new Error(`Invalid company domain: ${domain}`); }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!hostname.includes(".")) throw new Error(`Invalid public company domain: ${domain}`);
  return `icp:${hostname}`;
}
export const sidecarPathFor = (icpPath: string) => resolve(dirname(resolve(icpPath)), ".fullstackgtm", `${resolve(icpPath).split(/[\\/]/).pop()}.sync.json`);

export function readLocalIcp(path: string): Icp { return parseIcp(readSecureRegularFile(resolve(path))); }
export function extractHostedIcp(state: HostedArtifactState): Icp {
  const root = state.document && typeof state.document === "object" && !Array.isArray(state.document) ? state.document as Record<string, unknown> : {};
  return parseIcp(JSON.stringify(root.icp ?? state.document));
}
export function readIcpSyncState(icpPath: string): IcpSyncState | null {
  const path = sidecarPathFor(icpPath); if (!existsSync(path)) return null;
  try { const value = JSON.parse(readSecureRegularFile(path)) as IcpSyncState; return value?.version === 1 ? value : null; } catch { return null; }
}
export function writeIcpSyncState(icpPath: string, state: IcpSyncState): void {
  const path = sidecarPathFor(icpPath); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeSecureFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

export async function getIcpSyncStatus(icpPath: string, domain: string): Promise<{ status: IcpSyncStatus; hosted?: HostedArtifactState; local: Icp }> {
  const local = readLocalIcp(icpPath); const localHash = icpSha256(local); const tracked = readIcpSyncState(icpPath);
  const read = await readHostedArtifact("icp", artifactKeyForDomain(domain));
  if (read.status === "unpaired") return { local, status: { state: "unpaired", localIcpSha256: localHash } };
  if (read.status === "missing") return { local, status: { state: "missing_hosted", localIcpSha256: localHash } };
  if (read.status === "unavailable") return { local, status: { state: "unavailable", localIcpSha256: localHash, reason: read.reason } };
  const hostedHash = icpSha256(extractHostedIcp(read.state));
  const state = classifyIcpSync(localHash, read.state.revision, hostedHash, tracked);
  return { local, hosted: read.state, status: { state, localIcpSha256: localHash, hostedRevision: read.state.revision, trackedRevision: tracked?.revision } };
}

export function markIcpSynced(icpPath: string, domain: string, hosted: HostedArtifactState | { artifactId: string; revision: number; documentSha256?: string }, icp: Icp): void {
  const key = artifactKeyForDomain(domain); const normalizedDomain = key.slice("icp:".length);
  writeIcpSyncState(icpPath, { version: 1, artifactId: hosted.artifactId, key, domain: normalizedDomain, revision: hosted.revision, localIcpSha256: icpSha256(icp), hostedDocumentSha256: hosted.documentSha256, syncedAt: new Date().toISOString() });
}

export async function pushIcp(icpPath: string, domain: string, changeSummary?: string) {
  const checked = await getIcpSyncStatus(icpPath, domain);
  if (checked.status.state === "conflict" || checked.status.state === "hosted_changed" || checked.status.state === "untracked") return { status: "conflict" as const, checked };
  const current = checked.hosted;
  const root = current?.document && typeof current.document === "object" && !Array.isArray(current.document) ? current.document as Record<string, unknown> : {};
  const key = artifactKeyForDomain(domain); const normalizedDomain = key.slice("icp:".length);
  const document = Object.keys(root).length ? { ...root, icp: checked.local, humanReview: { reviewedAt: new Date().toISOString(), source: "cli" } } : { company: { domain: normalizedDomain }, icp: checked.local, evidence: [], humanReview: { reviewedAt: new Date().toISOString(), source: "cli" } };
  const result = await writeHostedArtifact({ kind: "icp", key, label: checked.local.name, domain: normalizedDomain, document, expectedRevision: current?.revision ?? 0, changeSummary });
  if (result.status === "saved") markIcpSynced(icpPath, domain, { artifactId: result.artifactId, revision: result.revision, documentSha256: result.documentSha256 }, checked.local);
  return { status: result.status, result, checked };
}
