/** Only implemented adapters belong here; planned providers stay in the strategy document. */
export const CONTACT_PROVIDER_CAPABILITIES = {
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
export function validateContactWaterfall(steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
        throw new Error("contact waterfall must contain at least one provider step");
    }
    return steps.map((step, index) => {
        if (!step || typeof step.provider !== "string" || !step.provider.trim()) {
            throw new Error(`contact waterfall step ${index + 1}: provider must be a non-empty string`);
        }
        const capabilities = CONTACT_PROVIDER_CAPABILITIES[step.provider];
        if (!capabilities) {
            throw new Error(`contact waterfall step ${index + 1}: unsupported provider "${step.provider}" ` +
                `(implemented: ${Object.keys(CONTACT_PROVIDER_CAPABILITIES).join(", ")})`);
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
                throw new Error(`contact waterfall step ${index + 1}: ${step.provider} does not implement "${field}" ` +
                    `(available: ${available.join(", ")})`);
            }
        }
        return { provider: step.provider, fields };
    });
}
/** Run providers in order. Later steps receive only records still missing a requested field. */
export async function runContactWaterfall(opts) {
    const steps = validateContactWaterfall(opts.steps);
    const prospects = opts.prospects.map((prospect) => ({ ...prospect }));
    const attempts = [];
    for (const step of steps) {
        const adapter = opts.adapters[step.provider];
        if (!adapter)
            throw new Error(`contact waterfall: adapter "${step.provider}" is not configured`);
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
        const added = {};
        outputs.forEach((output, outputIndex) => {
            const prospectIndex = indexes[outputIndex];
            const current = prospects[prospectIndex];
            let merged = current;
            for (const field of step.fields) {
                if (fieldValue(current, field))
                    continue;
                const value = fieldValue(output, field);
                if (!value)
                    continue;
                merged = setFieldValue(merged, field, value);
                added[field] = (added[field] ?? 0) + 1;
            }
            prospects[prospectIndex] = merged;
        });
        attempts.push({ provider: step.provider, fields: step.fields, attempted: inputs.length, added });
    }
    return { prospects, attempts };
}
function fieldValue(prospect, field) {
    if (field === "work_email")
        return prospect.email;
    if (field === "mobile")
        return prospect.mobile;
    return prospect.directDial;
}
function setFieldValue(prospect, field, value) {
    if (field === "work_email")
        return { ...prospect, email: value };
    if (field === "mobile")
        return { ...prospect, mobile: value };
    return { ...prospect, directDial: value };
}
