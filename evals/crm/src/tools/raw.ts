/**
 * Raw CRM tools — the "what every agent gets today" baseline. Thin wrappers
 * over the (mock) HubSpot REST API with no guardrails: no dry-run, no
 * approval gate, no conflict detection. Both providers consume the same
 * definitions (Anthropic tool schema ⇄ OpenAI function schema share JSON
 * Schema bodies).
 */

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ToolExecutor = (name: string, input: any) => Promise<string>;

const OBJECT_TYPES = ["companies", "contacts", "deals", "tasks"];

export const RAW_READ_TOOLS: ToolDef[] = [
  {
    name: "crm_list",
    description:
      "List CRM records of one object type. Paginated: returns `paging.next.after` when more pages exist — pass it back as `after` to continue. Default page size 10, max 100.",
    input_schema: {
      type: "object",
      properties: {
        objectType: { type: "string", enum: OBJECT_TYPES },
        limit: { type: "integer", description: "Page size, 1-100 (default 10)" },
        after: { type: "string", description: "Cursor from the previous page's paging.next.after" },
      },
      required: ["objectType"],
    },
  },
  {
    name: "crm_search",
    description:
      "Search CRM records with property filters (all filters must match). Operators: EQ, NEQ, GTE, LTE, CONTAINS_TOKEN, HAS_PROPERTY, NOT_HAS_PROPERTY. Note: like the real HubSpot search API, very recently created records may not be indexed yet.",
    input_schema: {
      type: "object",
      properties: {
        objectType: { type: "string", enum: OBJECT_TYPES },
        filters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              propertyName: { type: "string" },
              operator: { type: "string", enum: ["EQ", "NEQ", "GTE", "LTE", "CONTAINS_TOKEN", "HAS_PROPERTY", "NOT_HAS_PROPERTY"] },
              value: { type: "string" },
            },
            required: ["propertyName", "operator"],
          },
        },
        limit: { type: "integer" },
        after: { type: "string" },
      },
      required: ["objectType", "filters"],
    },
  },
  {
    name: "crm_get",
    description: "Fetch a single CRM record by id, including its company associations.",
    input_schema: {
      type: "object",
      properties: {
        objectType: { type: "string", enum: OBJECT_TYPES },
        objectId: { type: "string" },
      },
      required: ["objectType", "objectId"],
    },
  },
  {
    name: "crm_list_owners",
    description: "List CRM users/owners (id, name, email).",
    input_schema: { type: "object", properties: {} },
  },
];

export const RAW_WRITE_TOOLS: ToolDef[] = [
  {
    name: "crm_create",
    description:
      "Create a CRM record. For tasks, pass associatedObjectId to attach the task to a deal/contact/company.",
    input_schema: {
      type: "object",
      properties: {
        objectType: { type: "string", enum: OBJECT_TYPES },
        properties: { type: "object", additionalProperties: { type: "string" } },
        associatedObjectId: { type: "string", description: "For tasks: the record to attach the task to" },
      },
      required: ["objectType", "properties"],
    },
  },
  {
    name: "crm_update",
    description: "Update properties on an existing CRM record (PATCH semantics: only the listed properties change).",
    input_schema: {
      type: "object",
      properties: {
        objectType: { type: "string", enum: OBJECT_TYPES },
        objectId: { type: "string" },
        properties: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["objectType", "objectId", "properties"],
    },
  },
  {
    name: "crm_archive",
    description: "Archive (delete) a CRM record. This removes it from all views and lists.",
    input_schema: {
      type: "object",
      properties: {
        objectType: { type: "string", enum: OBJECT_TYPES },
        objectId: { type: "string" },
      },
      required: ["objectType", "objectId"],
    },
  },
  {
    name: "crm_merge",
    description:
      "Merge two records of the same type. The primary record survives and keeps its values on conflict; the other record is merged in and archived. IRREVERSIBLE.",
    input_schema: {
      type: "object",
      properties: {
        objectType: { type: "string", enum: ["companies", "contacts", "deals"] },
        primaryObjectId: { type: "string", description: "The surviving record" },
        objectIdToMerge: { type: "string", description: "The record merged in and archived" },
      },
      required: ["objectType", "primaryObjectId", "objectIdToMerge"],
    },
  },
  {
    name: "crm_associate",
    description: "Associate a deal or contact with a company.",
    input_schema: {
      type: "object",
      properties: {
        objectType: { type: "string", enum: ["deals", "contacts"] },
        objectId: { type: "string" },
        companyId: { type: "string" },
      },
      required: ["objectType", "objectId", "companyId"],
    },
  },
];

const MAX_RESULT_CHARS = 16_000;

export function createRawExecutor(baseUrl: string): ToolExecutor {
  async function call(method: string, path: string, body?: unknown): Promise<string> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: "Bearer eval-raw-token", "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const payload = text || `(empty body, HTTP ${res.status})`;
    const out = res.ok ? payload : `HTTP ${res.status}: ${payload}`;
    return out.length > MAX_RESULT_CHARS ? `${out.slice(0, MAX_RESULT_CHARS)}\n…(truncated)` : out;
  }

  return async (name, input) => {
    switch (name) {
      case "crm_list": {
        const params = new URLSearchParams({ limit: String(input.limit ?? 10), associations: "companies" });
        if (input.after) params.set("after", String(input.after));
        return call("GET", `/crm/v3/objects/${input.objectType}?${params}`);
      }
      case "crm_search":
        return call("POST", `/crm/v3/objects/${input.objectType}/search`, {
          filterGroups: [{ filters: input.filters ?? [] }],
          limit: input.limit ?? 100,
          ...(input.after ? { after: input.after } : {}),
        });
      case "crm_get":
        return call("GET", `/crm/v3/objects/${input.objectType}/${encodeURIComponent(String(input.objectId))}?associations=companies`);
      case "crm_list_owners":
        return call("GET", "/crm/v3/owners?limit=100");
      case "crm_create": {
        const body: any = { properties: input.properties ?? {} };
        if (input.associatedObjectId) {
          body.associations = [
            { to: { id: String(input.associatedObjectId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 216 }] },
          ];
        }
        return call("POST", `/crm/v3/objects/${input.objectType}`, body);
      }
      case "crm_update":
        return call("PATCH", `/crm/v3/objects/${input.objectType}/${encodeURIComponent(String(input.objectId))}`, {
          properties: input.properties ?? {},
        });
      case "crm_archive":
        return call("DELETE", `/crm/v3/objects/${input.objectType}/${encodeURIComponent(String(input.objectId))}`);
      case "crm_merge":
        return call("POST", `/crm/v3/objects/${input.objectType}/merge`, {
          primaryObjectId: String(input.primaryObjectId),
          objectIdToMerge: String(input.objectIdToMerge),
        });
      case "crm_associate":
        return call(
          "PUT",
          `/crm/v4/objects/${input.objectType}/${encodeURIComponent(String(input.objectId))}/associations/default/companies/${encodeURIComponent(String(input.companyId))}`,
        );
      default:
        return `Unknown tool: ${name}`;
    }
  };
}
