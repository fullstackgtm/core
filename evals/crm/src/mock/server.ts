/**
 * In-memory mock of the HubSpot CRM v3/v4 API surface used by the
 * fullstackgtm connector and by the eval's raw CRM tools.
 *
 * Deliberately reproduces three real HubSpot behaviors that act as
 * footgun traps for naive agents:
 *
 *  1. Pagination — list endpoints default to 10 records per page
 *     (HubSpot's actual default) and cap at 100. Reading only the first
 *     page silently truncates the dataset.
 *  2. Search eventual consistency — records created in the last
 *     `searchVisibilityLagOps` operations are invisible to the search
 *     API, exactly like HubSpot's indexing delay. Create-without-
 *     remembering produces duplicates.
 *  3. Drift — a scenario can schedule a concurrent edit that fires
 *     after N requests, simulating another rep changing a record
 *     between the agent's read and its write.
 *
 * Every mutation is recorded in `opLog` with a monotonic sequence
 * number; scoring reads the log, never the agent transcript.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type ObjectType = "companies" | "contacts" | "deals" | "tasks";

export type MockRecord = {
  id: string;
  properties: Record<string, string>;
  /** company ids this record is associated to */
  companyAssociations: Set<string>;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  /** op counter value when the record was created (drives search lag) */
  createdAtOp: number;
};

export type MockOwner = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  archived: boolean;
};

export type LoggedOp = {
  n: number;
  kind: "read" | "search" | "create" | "update" | "archive" | "merge" | "associate";
  method: string;
  path: string;
  objectType?: ObjectType;
  objectId?: string;
  body?: unknown;
};

export type DriftRule = {
  /**
   * Fire once the request counter reaches this value.
   * Special value -1: fire when the first MUTATING request arrives, before
   * it is processed — guarantees every agent write happens post-drift,
   * independent of how many reads the agent performed first.
   */
  afterRequests: number;
  mutate: (server: MockHubspot) => void;
  description: string;
  fired?: boolean;
  /** op counter value at the moment the drift fired (set automatically) */
  firedAtOp?: number;
};

const OBJECT_TYPES: ObjectType[] = ["companies", "contacts", "deals", "tasks"];
const BASE_TIME = Date.parse("2026-06-11T00:00:00.000Z");

export class MockHubspot {
  objects = new Map<ObjectType, Map<string, MockRecord>>();
  owners: MockOwner[] = [];
  opLog: LoggedOp[] = [];
  driftRules: DriftRule[] = [];
  /** records created fewer than this many ops ago are invisible to search */
  searchVisibilityLagOps = 8;
  private idCounter = 101;
  private opCounter = 0;
  private server: http.Server | null = null;

  constructor() {
    for (const t of OBJECT_TYPES) this.objects.set(t, new Map());
  }

  // ---- seeding -----------------------------------------------------------

  addOwner(firstName: string, lastName: string): string {
    const id = String(this.idCounter++);
    this.owners.push({
      id,
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
      archived: false,
    });
    return id;
  }

  seed(objectType: ObjectType, properties: Record<string, string | number | undefined>, companyId?: string): string {
    const id = String(this.idCounter++);
    const props: Record<string, string> = {};
    for (const [k, v] of Object.entries(properties)) {
      if (v !== undefined) props[k] = String(v);
    }
    const t = new Date(BASE_TIME - 86_400_000).toISOString(); // seeded a day before "today"
    this.objects.get(objectType)!.set(id, {
      id,
      properties: props,
      companyAssociations: new Set(companyId ? [companyId] : []),
      archived: false,
      createdAt: t,
      updatedAt: t,
      // seeded records are always old enough to be searchable
      createdAtOp: -1_000_000,
    });
    return id;
  }

  scheduleDrift(afterRequests: number, description: string, mutate: (server: MockHubspot) => void): void {
    this.driftRules.push({ afterRequests, description, mutate });
  }

  // ---- inspection (used by graders) --------------------------------------

  get(objectType: ObjectType, id: string): MockRecord | undefined {
    return this.objects.get(objectType)!.get(id);
  }

  active(objectType: ObjectType): MockRecord[] {
    return [...this.objects.get(objectType)!.values()].filter((r) => !r.archived);
  }

  mutations(): LoggedOp[] {
    return this.opLog.filter((o) => o.kind !== "read" && o.kind !== "search");
  }

  requestCount(): number {
    return this.opCounter;
  }

  // ---- lifecycle ----------------------------------------------------------

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((err) => (err ? reject(err) : resolve())),
    );
    this.server = null;
  }

  // ---- internals -----------------------------------------------------------

  private now(): string {
    return new Date(BASE_TIME + this.opCounter * 1000).toISOString();
  }

  private nextId(): string {
    return String(this.idCounter++);
  }

  private log(op: Omit<LoggedOp, "n">): void {
    this.opLog.push({ n: this.opCounter, ...op });
  }

  private applyDrift(isMutation: boolean): void {
    for (const rule of this.driftRules) {
      if (rule.fired) continue;
      const due =
        rule.afterRequests === -1 ? isMutation : this.opCounter >= rule.afterRequests;
      if (due) {
        rule.fired = true;
        rule.firedAtOp = this.opCounter;
        rule.mutate(this);
      }
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.opCounter += 1;
    const isMutation =
      req.method === "PATCH" ||
      req.method === "DELETE" ||
      req.method === "PUT" ||
      (req.method === "POST" && !(req.url ?? "").endsWith("/search"));
    this.applyDrift(isMutation);

    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || auth.length < 10) {
      return json(res, 401, { status: "error", message: "Authentication credentials not found." });
    }

    let body: any = null;
    if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          return json(res, 400, { status: "error", message: "Invalid JSON body." });
        }
      }
    }

    const url = new URL(req.url ?? "/", "http://mock");
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      // owners
      if (method === "GET" && path === "/crm/v3/owners") {
        this.log({ kind: "read", method, path });
        return json(res, 200, { results: this.owners.map((o) => ({ ...o })) });
      }

      // v4 associations
      const assocPut = path.match(
        /^\/crm\/v4\/objects\/(companies|contacts|deals|tasks)\/([^/]+)\/associations\/default\/companies\/([^/]+)$/,
      );
      if (method === "PUT" && assocPut) {
        const [, type, id, companyId] = assocPut;
        const rec = this.requireActive(type as ObjectType, id, res);
        if (!rec) return;
        if (!this.objects.get("companies")!.get(companyId) || this.objects.get("companies")!.get(companyId)!.archived) {
          return json(res, 404, { status: "error", message: `Company ${companyId} not found.` });
        }
        rec.companyAssociations.add(companyId);
        rec.updatedAt = this.now();
        this.log({ kind: "associate", method, path, objectType: type as ObjectType, objectId: id, body: { companyId } });
        res.writeHead(204).end();
        return;
      }

      const assocTasks = path.match(
        /^\/crm\/v4\/objects\/(companies|contacts|deals)\/([^/]+)\/associations\/tasks$/,
      );
      if (method === "GET" && assocTasks) {
        const [, type, id] = assocTasks;
        const rec = this.requireActive(type as ObjectType, id, res);
        if (!rec) return;
        this.log({ kind: "read", method, path, objectType: type as ObjectType, objectId: id });
        const tasks = this.active("tasks").filter((t) => t.properties.__associated_object_id === id);
        return json(res, 200, { results: tasks.map((t) => ({ toObjectId: Number(t.id) })) });
      }

      const assocGet = path.match(
        /^\/crm\/v4\/objects\/(companies|contacts|deals|tasks)\/([^/]+)\/associations\/companies$/,
      );
      if (method === "GET" && assocGet) {
        const [, type, id] = assocGet;
        const rec = this.requireActive(type as ObjectType, id, res);
        if (!rec) return;
        this.log({ kind: "read", method, path, objectType: type as ObjectType, objectId: id });
        return json(res, 200, {
          results: [...rec.companyAssociations].map((cid) => ({ toObjectId: Number(cid) })),
        });
      }

      // v3 objects
      const m = path.match(/^\/crm\/v3\/objects\/(companies|contacts|deals|tasks)(?:\/([^/]+))?(?:\/([^/]+))?$/);
      if (!m) return json(res, 404, { status: "error", message: `No route for ${method} ${path}` });
      const objectType = m[1] as ObjectType;
      const second = m[2];
      const third = m[3];
      const table = this.objects.get(objectType)!;

      // search
      if (method === "POST" && second === "search" && !third) {
        this.log({ kind: "search", method, path, objectType, body });
        return json(res, 200, this.search(objectType, body ?? {}));
      }

      // merge
      if (method === "POST" && second === "merge" && !third) {
        const primary = table.get(String(body?.primaryObjectId ?? ""));
        const loser = table.get(String(body?.objectIdToMerge ?? ""));
        if (!primary || primary.archived) {
          return json(res, 404, { status: "error", message: "Primary object not found." });
        }
        if (!loser || loser.archived) {
          return json(res, 404, { status: "error", message: "Object to merge not found." });
        }
        // survivor's values win; loser fills gaps, then is archived
        for (const [k, v] of Object.entries(loser.properties)) {
          if (primary.properties[k] === undefined || primary.properties[k] === "") {
            primary.properties[k] = v;
          }
        }
        for (const cid of loser.companyAssociations) primary.companyAssociations.add(cid);
        loser.archived = true;
        primary.updatedAt = this.now();
        this.log({
          kind: "merge",
          method,
          path,
          objectType,
          objectId: primary.id,
          body: { primaryObjectId: primary.id, objectIdToMerge: loser.id },
        });
        return json(res, 200, { id: primary.id, properties: { ...primary.properties } });
      }

      // create
      if (method === "POST" && !second) {
        const id = this.nextId();
        const props: Record<string, string> = {};
        for (const [k, v] of Object.entries((body?.properties ?? {}) as Record<string, unknown>)) {
          if (v !== undefined && v !== null) props[k] = String(v);
        }
        const assoc = new Set<string>();
        // tasks-style association payload: [{to:{id}, types:[...]}]
        if (Array.isArray(body?.associations)) {
          for (const a of body.associations) {
            const toId = String(a?.to?.id ?? "");
            if (toId) props.__associated_object_id = toId;
          }
        }
        const t = this.now();
        table.set(id, {
          id,
          properties: props,
          companyAssociations: assoc,
          archived: false,
          createdAt: t,
          updatedAt: t,
          createdAtOp: this.opCounter,
        });
        this.log({ kind: "create", method, path, objectType, objectId: id, body });
        return json(res, 201, { id, properties: { ...props }, createdAt: t, updatedAt: t });
      }

      // single-record routes
      if (second && !third) {
        if (method === "GET") {
          const rec = this.requireActive(objectType, second, res);
          if (!rec) return;
          this.log({ kind: "read", method, path, objectType, objectId: second });
          return json(res, 200, serialize(rec, true));
        }
        if (method === "PATCH") {
          const rec = this.requireActive(objectType, second, res);
          if (!rec) return;
          for (const [k, v] of Object.entries((body?.properties ?? {}) as Record<string, unknown>)) {
            rec.properties[k] = v === null ? "" : String(v);
          }
          rec.updatedAt = this.now();
          this.log({ kind: "update", method, path, objectType, objectId: second, body });
          return json(res, 200, serialize(rec, false));
        }
        if (method === "DELETE") {
          const rec = table.get(second);
          if (!rec || rec.archived) {
            return json(res, 404, { status: "error", message: `${objectType}/${second} not found.` });
          }
          rec.archived = true;
          rec.updatedAt = this.now();
          this.log({ kind: "archive", method, path, objectType, objectId: second });
          res.writeHead(204).end();
          return;
        }
      }

      // list
      if (method === "GET" && !second) {
        this.log({ kind: "read", method, path: req.url ?? path, objectType });
        const limit = clamp(Number(url.searchParams.get("limit") ?? "10"), 1, 100);
        const after = Number(url.searchParams.get("after") ?? "0");
        const all = this.active(objectType).sort((a, b) => Number(a.id) - Number(b.id));
        const page = all.slice(after, after + limit);
        const next = after + limit < all.length ? String(after + limit) : undefined;
        return json(res, 200, {
          results: page.map((r) => serialize(r, url.searchParams.has("associations"))),
          ...(next ? { paging: { next: { after: next } } } : {}),
        });
      }

      return json(res, 404, { status: "error", message: `No route for ${method} ${path}` });
    } catch (error) {
      return json(res, 500, { status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private requireActive(objectType: ObjectType, id: string, res: http.ServerResponse): MockRecord | null {
    const rec = this.objects.get(objectType)!.get(id);
    if (!rec || rec.archived) {
      json(res, 404, { status: "error", message: `${objectType}/${id} not found.` });
      return null;
    }
    return rec;
  }

  private search(objectType: ObjectType, body: any): { results: unknown[]; paging?: unknown } {
    const groups: any[] = Array.isArray(body.filterGroups) ? body.filterGroups : [];
    const limit = clamp(Number(body.limit ?? 10), 1, 100);
    const after = Number(body.after ?? 0);
    const candidates = this.active(objectType)
      // HubSpot's search index lags writes; freshly created records are invisible
      .filter((r) => this.opCounter - r.createdAtOp >= this.searchVisibilityLagOps)
      .filter((r) => groups.length === 0 || groups.some((g) => matchGroup(r, g)))
      .sort((a, b) => Number(a.id) - Number(b.id));
    const page = candidates.slice(after, after + limit);
    const next = after + limit < candidates.length ? String(after + limit) : undefined;
    return {
      results: page.map((r) => serialize(r, false)),
      ...(next ? { paging: { next: { after: next } } } : {}),
      total: candidates.length,
    } as any;
  }
}

function matchGroup(rec: MockRecord, group: any): boolean {
  const filters: any[] = Array.isArray(group?.filters) ? group.filters : [];
  return filters.every((f) => matchFilter(rec, f));
}

function matchFilter(rec: MockRecord, f: any): boolean {
  const prop = String(f?.propertyName ?? "");
  const op = String(f?.operator ?? "EQ");
  let actual: string | undefined;
  if (prop === "hs_lastmodifieddate" || prop === "lastmodifieddate") {
    actual = String(Date.parse(rec.updatedAt));
  } else {
    actual = rec.properties[prop];
  }
  const expected = f?.value !== undefined ? String(f.value) : undefined;
  switch (op) {
    case "EQ":
      return actual !== undefined && actual.toLowerCase() === (expected ?? "").toLowerCase();
    case "NEQ":
      return actual === undefined || actual.toLowerCase() !== (expected ?? "").toLowerCase();
    case "GTE":
      return actual !== undefined && Number(actual) >= Number(expected);
    case "LTE":
      return actual !== undefined && Number(actual) <= Number(expected);
    case "CONTAINS_TOKEN":
      return actual !== undefined && actual.toLowerCase().includes((expected ?? "").toLowerCase());
    case "HAS_PROPERTY":
      return actual !== undefined && actual !== "";
    case "NOT_HAS_PROPERTY":
      return actual === undefined || actual === "";
    default:
      return false;
  }
}

function serialize(rec: MockRecord, withAssociations: boolean) {
  return {
    id: rec.id,
    properties: { ...rec.properties },
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    archived: false,
    ...(withAssociations && rec.companyAssociations.size > 0
      ? {
          associations: {
            companies: { results: [...rec.companyAssociations].map((id) => ({ id, type: "primary" })) },
          },
        }
      : {}),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}
