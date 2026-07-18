export type CrmObjectType = "owners" | "accounts" | "contacts" | "deals";

export type FieldMappings = Partial<
  Record<CrmObjectType | string, Record<string, string>>
>;

export const HUBSPOT_DEFAULT_FIELD_MAPPINGS: Record<
  Exclude<CrmObjectType, "owners">,
  Record<string, string>
> = {
  accounts: {
    name: "name",
    domain: "domain",
    parentAccountId: "hs_parent_company_id",
    industry: "industry",
    employeeCount: "numberofemployees",
    annualRevenue: "annualrevenue",
    ownerId: "hubspot_owner_id",
  },
  contacts: {
    firstName: "firstname",
    lastName: "lastname",
    email: "email",
    phone: "phone",
    title: "jobtitle",
    // HubSpot-standard "LinkedIn URL"; safe to request everywhere (HubSpot
    // ignores unknown properties rather than erroring). Powers strong dedup.
    linkedin: "hs_linkedin_url",
    ownerId: "hubspot_owner_id",
  },
  deals: {
    name: "dealname",
    amount: "amount",
    closeDate: "closedate",
    stage: "dealstage",
    dealType: "dealtype",
    ownerId: "hubspot_owner_id",
    probability: "hs_deal_stage_probability",
    lastActivityAt: "hs_last_sales_activity_timestamp",
    nextStep: "hs_next_step",
  },
};

export const SALESFORCE_DEFAULT_FIELD_MAPPINGS: Record<
  CrmObjectType,
  Record<string, string>
> = {
  owners: {
    id: "Id",
    name: "Name",
    email: "Email",
    title: "Title",
    isActive: "IsActive",
  },
  accounts: {
    id: "Id",
    name: "Name",
    domain: "Website",
    parentAccountId: "ParentId",
    industry: "Industry",
    employeeCount: "NumberOfEmployees",
    annualRevenue: "AnnualRevenue",
    ownerId: "OwnerId",
  },
  contacts: {
    id: "Id",
    firstName: "FirstName",
    lastName: "LastName",
    email: "Email",
    phone: "Phone",
    title: "Title",
    accountId: "AccountId",
    ownerId: "OwnerId",
  },
  deals: {
    id: "Id",
    name: "Name",
    amount: "Amount",
    closeDate: "CloseDate",
    stage: "StageName",
    dealType: "Type",
    probability: "Probability",
    isClosed: "IsClosed",
    isWon: "IsWon",
    ownerId: "OwnerId",
    accountId: "AccountId",
    lastActivityAt: "LastActivityDate",
    forecastCategoryName: "ForecastCategory",
    nextStep: "NextStep",
  },
};

const OBJECT_ALIASES: Record<CrmObjectType, string[]> = {
  owners: ["owners", "users"],
  accounts: ["accounts", "companies"],
  contacts: ["contacts"],
  deals: ["deals", "opportunities"],
};

export function normalizeFieldMappings(value: unknown): FieldMappings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: FieldMappings = {};
  for (const [objectName, mapping] of Object.entries(value)) {
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      continue;
    }
    const clean: Record<string, string> = {};
    for (const [targetField, providerField] of Object.entries(mapping)) {
      if (typeof providerField === "string" && providerField.trim()) {
        clean[targetField] = providerField.trim();
      }
    }
    if (Object.keys(clean).length > 0) normalized[objectName] = clean;
  }
  return normalized;
}

export function mappedField(
  mappings: FieldMappings | undefined,
  objectType: CrmObjectType,
  targetField: string,
  fallbackField: string,
): string {
  const normalized = normalizeFieldMappings(mappings);
  for (const alias of OBJECT_ALIASES[objectType]) {
    const mapped = normalized[alias]?.[targetField];
    if (mapped) return mapped;
  }
  return fallbackField;
}

export function mappedFields(
  mappings: FieldMappings | undefined,
  objectType: CrmObjectType,
  defaults: Record<string, string>,
): string[] {
  const fields = Object.entries(defaults).map(([targetField, fallbackField]) =>
    mappedField(mappings, objectType, targetField, fallbackField),
  );
  return Array.from(new Set(fields)).filter(Boolean);
}

export function readMappedValue(
  source: Record<string, unknown>,
  mappings: FieldMappings | undefined,
  objectType: CrmObjectType,
  targetField: string,
  fallbackField: string,
): unknown {
  return readPath(
    source,
    mappedField(mappings, objectType, targetField, fallbackField),
  );
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(source, path)) return source[path];
  return path.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, source);
}
