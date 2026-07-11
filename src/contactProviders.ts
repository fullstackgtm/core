import type { Prospect } from "./connectors/prospectSources.ts";

export type ContactField = "work_email" | "mobile" | "direct_dial";
export type ContactInputShape = "linkedin" | "name_domain" | "email" | "phone" | "company_domain";
export type ContactProviderExecution = "sync" | "poll" | "webhook" | "batch";
export type ContactProviderBilling = "per_attempt" | "per_match" | "per_field" | "subscription" | "unknown";

export type ContactProviderCapability = {
  provider: string;
  operation: string;
  inputShapes: ContactInputShape[];
  outputFields: ContactField[];
  execution: ContactProviderExecution;
  billing: ContactProviderBilling;
  chargesOn: Array<"request" | "match" | "valid" | "accept_all" | "unknown">;
  supportsBalance: boolean;
  supportsIdempotency: boolean;
  maxBatchSize?: number;
};

/** Only implemented adapters belong here; planned providers stay in the strategy document. */
export const CONTACT_PROVIDER_CAPABILITIES: Readonly<Record<string, readonly ContactProviderCapability[]>> = {
  pipe0: [{
    provider: "pipe0",
    operation: "person:workemail:waterfall@1",
    inputShapes: ["name_domain"],
    outputFields: ["work_email"],
    execution: "batch",
    billing: "per_attempt",
    chargesOn: ["request"],
    supportsBalance: false,
    supportsIdempotency: false,
    maxBatchSize: 100,
  }],
};

export type ContactWaterfallStep = { provider: string; fields: ContactField[] };

export type ContactProviderAdapter = {
  provider: string;
  resolve(prospects: Prospect[], fields: ContactField[]): Promise<Prospect[]>;
};

export type ContactWaterfallAttempt = {
  provider: string;
  fields: ContactField[];
  attempted: number;
  added: Partial<Record<ContactField, number>>;
};

export type ContactWaterfallResult = { prospects: Prospect[]; attempts: ContactWaterfallAttempt[] };

export function validateContactWaterfall(steps: ContactWaterfallStep[]): ContactWaterfallStep[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("contact waterfall must contain at least one provider step");
  }
  return steps.map((step, index) => {
    if (!step || typeof step.provider !== "string" || !step.provider.trim()) {
      throw new Error(`contact waterfall step ${index + 1}: provider must be a non-empty string`);
    }
    const capabilities = CONTACT_PROVIDER_CAPABILITIES[step.provider];
    if (!capabilities) {
      throw new Error(
        `contact waterfall step ${index + 1}: unsupported provider "${step.provider}" ` +
          `(implemented: ${Object.keys(CONTACT_PROVIDER_CAPABILITIES).join(", ")})`,
      );
    }
    if (!Array.isArray(step.fields) || step.fields.length === 0) {
      throw new Error(`contact waterfall step ${index + 1}: fields must be a non-empty array`);
    }
    const fields = [...new Set(step.fields)];
    for (const field of fields) {
      if (field !== "work_email" && field !== "mobile" && field !== "direct_dial") {
        throw new Error(`contact waterfall step ${index + 1}: unsupported field "${String(field)}"`);
      }
      if (!capabilities.some((capability) => capability.outputFields.includes(field))) {
        const available = [...new Set(capabilities.flatMap((capability) => capability.outputFields))];
        throw new Error(
          `contact waterfall step ${index + 1}: ${step.provider} does not implement "${field}" ` +
            `(available: ${available.join(", ")})`,
        );
      }
    }
    return { provider: step.provider, fields };
  });
}

/** Run providers in order. Later steps receive only records still missing a requested field. */
export async function runContactWaterfall(opts: {
  prospects: Prospect[];
  steps: ContactWaterfallStep[];
  adapters: Readonly<Record<string, ContactProviderAdapter>>;
}): Promise<ContactWaterfallResult> {
  const steps = validateContactWaterfall(opts.steps);
  const prospects = opts.prospects.map((prospect) => ({ ...prospect }));
  const attempts: ContactWaterfallAttempt[] = [];
  for (const step of steps) {
    const adapter = opts.adapters[step.provider];
    if (!adapter) throw new Error(`contact waterfall: adapter "${step.provider}" is not configured`);
    const indexes = prospects
      .map((prospect, index) => step.fields.some((field) => !fieldValue(prospect, field)) ? index : -1)
      .filter((index) => index >= 0);
    if (indexes.length === 0) {
      attempts.push({ provider: step.provider, fields: step.fields, attempted: 0, added: {} });
      continue;
    }
    const inputs = indexes.map((index) => prospects[index]);
    const outputs = await adapter.resolve(inputs, step.fields);
    if (outputs.length !== inputs.length) {
      throw new Error(`contact waterfall: ${step.provider} returned ${outputs.length} result(s) for ${inputs.length} input(s)`);
    }
    const added: Partial<Record<ContactField, number>> = {};
    outputs.forEach((output, outputIndex) => {
      const prospectIndex = indexes[outputIndex];
      const current = prospects[prospectIndex];
      let merged = current;
      for (const field of step.fields) {
        if (fieldValue(current, field)) continue;
        const value = fieldValue(output, field);
        if (!value) continue;
        merged = setFieldValue(merged, field, value);
        added[field] = (added[field] ?? 0) + 1;
      }
      prospects[prospectIndex] = merged;
    });
    attempts.push({ provider: step.provider, fields: step.fields, attempted: inputs.length, added });
  }
  return { prospects, attempts };
}

function fieldValue(prospect: Prospect, field: ContactField): string | undefined {
  if (field === "work_email") return prospect.email;
  if (field === "mobile") return prospect.mobile;
  return prospect.directDial;
}

function setFieldValue(prospect: Prospect, field: ContactField, value: string): Prospect {
  if (field === "work_email") return { ...prospect, email: value };
  if (field === "mobile") return { ...prospect, mobile: value };
  return { ...prospect, directDial: value };
}
