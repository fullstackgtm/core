import { execFile } from "node:child_process";
import type { EnrichObjectType, EnrichSourceRecord } from "./enrich.ts";
import type { ApolloPullKey as EnrichPullKey, ApolloPullOptions as EnrichPullOptions, ApolloPullResult as EnrichPullResult } from "./enrichApollo.ts";

/**
 * ZoomInfo source adapter for governed enrichment.
 *
 * ZoomInfo owns authentication and credit accounting in its official `gtm`
 * CLI. fullstackgtm invokes that CLI as a read-only source, normalizes the
 * JSON response, then sends proposed CRM changes through the normal
 * diff → patch plan → approval → apply lifecycle. No ZoomInfo credential is
 * copied into fullstackgtm and this adapter never writes to the CRM directly.
 */

export type ZoomInfoCommandResult = {
  stdout: string;
  stderr: string;
};

export type ZoomInfoCommandRunner = (
  executable: string,
  args: string[],
) => Promise<ZoomInfoCommandResult>;

export type ZoomInfoClientOptions = {
  /** Official ZoomInfo CLI executable. Defaults to `gtm`. */
  executable?: string;
  /** Injectable command runner for tests. */
  run?: ZoomInfoCommandRunner;
};

export type ZoomInfoClient = {
  enrichCompany(domain: string): Promise<unknown>;
  enrichContact(email: string): Promise<unknown>;
};

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

const runCommand: ZoomInfoCommandRunner = (executable, args) =>
  new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: "utf8", maxBuffer: DEFAULT_MAX_BUFFER }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          reject(
            new Error(
              "ZoomInfo CLI not found. Install it with `brew install zoominfo/gtm-ai/gtm-ai-cli` " +
                "or `npm install -g @zoominfo/gtm-ai-cli`, then run `gtm auth login`.",
            ),
          );
          return;
        }
        // Do not echo stdout/stderr: provider errors can contain submitted
        // company domains, contact emails, or tenant-specific data and this
        // message may be persisted in a scheduled-run record.
        reject(
          new Error(
            `ZoomInfo CLI failed${typeof code === "string" || typeof code === "number" ? ` (${code})` : ""}. ` +
              "Run `gtm auth whoami`, then retry the same `gtm ... enrich` command directly if needed.",
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });

function parseOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      "ZoomInfo CLI returned non-JSON output. Upgrade `gtm` and verify that `gtm ... enrich -f json` works directly.",
    );
  }
}

export function createZoomInfoClient(options: ZoomInfoClientOptions = {}): ZoomInfoClient {
  const executable = options.executable ?? process.env.ZOOMINFO_GTM_BIN ?? "gtm";
  const run = options.run ?? runCommand;

  async function invoke(args: string[]): Promise<unknown> {
    const result = await run(executable, [...args, "-f", "json"]);
    return parseOutput(result.stdout);
  }

  return {
    enrichCompany(domain) {
      return invoke(["companies", "enrich", "--domain", domain]);
    },
    enrichContact(email) {
      return invoke(["contacts", "enrich", "--email", email]);
    },
  };
}

function recordCandidates(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  }
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.data)) return recordCandidates(object.data);
  if (object.data && typeof object.data === "object") return recordCandidates(object.data);
  if (Array.isArray(object.companies)) return recordCandidates(object.companies);
  if (Array.isArray(object.contacts)) return recordCandidates(object.contacts);
  return [object];
}

function valueAt(record: Record<string, unknown>, paths: string[]): string | undefined {
  for (const path of paths) {
    let current: unknown = record;
    for (const segment of path.split(".")) {
      if (!current || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    if (typeof current === "string" && current.trim()) return current.trim();
    if (typeof current === "number" && Number.isFinite(current)) return String(current);
  }
  return undefined;
}

function normalizeRecord(payload: unknown, key: EnrichPullKey): EnrichSourceRecord | undefined {
  const record = recordCandidates(payload)[0];
  if (!record) return undefined;
  const id = valueAt(record, ["id", "attributes.id", "companyId", "personId", "attributes.companyId", "attributes.personId"]);
  if (key.objectType === "company") {
    return {
      id: `zoominfo:company_${id ?? key.value}`,
      objectType: "company",
      keys: {
        domain: valueAt(record, [
          "attributes.domain",
          "attributes.website",
          "attributes.companyWebsite",
          "domain",
          "website",
          "companyWebsite",
        ]) ?? key.value,
        name: valueAt(record, ["attributes.name", "attributes.companyName", "name", "companyName"]),
      },
      payload: record,
    };
  }
  return {
    id: `zoominfo:contact_${id ?? key.value}`,
    objectType: "contact",
    keys: {
      email: valueAt(record, [
        "attributes.email",
        "attributes.emailAddress",
        "attributes.contactEmail",
        "email",
        "emailAddress",
        "contactEmail",
      ]) ?? key.value,
      name: valueAt(record, ["attributes.fullName", "attributes.name", "fullName", "name"]),
    },
    payload: record,
  };
}

/** Pull snapshot-driven enrichment keys through ZoomInfo's official CLI. */
export async function pullZoomInfoRecords(
  client: ZoomInfoClient,
  keys: EnrichPullKey[],
  options: EnrichPullOptions = {},
): Promise<EnrichPullResult> {
  const records: EnrichSourceRecord[] = [];
  const misses: EnrichPullKey[] = [];
  const resumeIndex = options.resumeAfter ? keys.findIndex((key) => key.value === options.resumeAfter) : -1;

  for (const key of keys.slice(resumeIndex + 1)) {
    const payload = key.objectType === "company"
      ? await client.enrichCompany(key.value)
      : await client.enrichContact(key.value);
    const record = normalizeRecord(payload, key);
    if (record) records.push(record);
    else misses.push(key);
    await options.onProgress?.({
      lastKeyValue: key.value,
      record,
      miss: record ? undefined : key,
    });
  }
  return { records, misses };
}

export type ZoomInfoPullKey = EnrichPullKey;
export type ZoomInfoPullOptions = EnrichPullOptions;
export type ZoomInfoPullResult = EnrichPullResult;
export type ZoomInfoObjectType = EnrichObjectType;
