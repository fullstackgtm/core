export function normalizeClayCompany(value) {
    const row = record(value);
    return {
        name: stringValue(row.name),
        domain: bareDomain(stringValue(row.domain)),
        linkedin: normalizeLinkedin(stringValue(row.linkedin_url)),
        description: stringValue(row.description),
        industry: stringValue(row.industry),
        size: stringValue(row.size),
        location: stringValue(row.location),
        fundingAmountRange: stringValue(row.total_funding_amount_range_usd),
    };
}
export function normalizeClayPerson(value) {
    const row = record(value);
    const location = record(row.structured_location);
    const fullName = stringValue(row.name);
    return {
        firstName: stringValue(row.first_name),
        lastName: stringValue(row.last_name),
        fullName,
        jobTitle: stringValue(row.latest_experience_title),
        headline: stringValue(row.headline),
        jobLevel: stringValue(row.job_level),
        jobDepartment: stringValue(row.job_department),
        companyName: stringValue(row.latest_experience_company),
        companyDomain: bareDomain(stringValue(row.domain)),
        linkedin: normalizeLinkedin(stringValue(row.url)),
        email: stringValue(row.email),
        sourceId: normalizeLinkedin(stringValue(row.url)) ?? fullName,
        location: {
            city: stringValue(location.city),
            state: stringValue(location.state),
            region: stringValue(location.region),
            country: stringValue(location.country),
            countryCode: stringValue(location.country_iso),
        },
    };
}
function record(value) {
    return value && typeof value === "object" ? value : {};
}
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function bareDomain(value) {
    return value?.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase() || undefined;
}
function normalizeLinkedin(value) {
    if (!value)
        return undefined;
    const normalized = value.startsWith("http") ? value : `https://${value.replace(/^\/+/, "")}`;
    return normalized.replace(/\/$/, "");
}
