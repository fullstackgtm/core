var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { builtinAuditRules } from "./rules.js";
/**
 * Project-level configuration: `fullstackgtm.config.json` in the working
 * directory (or an explicit `--config` path). Policy thresholds, rule
 * selection, and rule packages — third-party modules exporting additional
 * `GtmAuditRule`s — all live here so a team's audit standard is reviewable
 * in version control.
 */
export const CONFIG_FILE_NAME = "fullstackgtm.config.json";
export function loadConfig(explicitPath, cwd = process.cwd()) {
    const path = explicitPath ? resolve(cwd, explicitPath) : resolve(cwd, CONFIG_FILE_NAME);
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        if (explicitPath)
            throw new Error(`Could not read config file: ${path}`);
        return null;
    }
    const config = JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error(`${path} must contain a JSON object.`);
    }
    return { config, path };
}
/** Overlay config policy values onto a base policy; defined values win. */
export function mergePolicy(base, config) {
    if (!config?.policy)
        return base;
    const merged = { ...base };
    for (const [key, value] of Object.entries(config.policy)) {
        if (value !== undefined) {
            merged[key] = value;
        }
    }
    return merged;
}
/**
 * Build the effective rule set: built-ins plus rule-package exports, then
 * `enabled` (allow-list) and `disabled` filters.
 */
export async function resolveConfiguredRules(loaded, baseRules = builtinAuditRules) {
    let rules = [...baseRules];
    for (const specifier of loaded?.config.rulePackages ?? []) {
        const resolvedSpecifier = specifier.startsWith(".") || isAbsolute(specifier)
            ? pathToFileURL(resolve(dirname(loaded.path), specifier)).href
            : specifier;
        const rulePackage = await import(__rewriteRelativeImportExtension(resolvedSpecifier));
        const imported = rulePackage.rules ?? rulePackage.default?.rules;
        if (!Array.isArray(imported)) {
            throw new Error(`Rule package ${specifier} must export \`rules: GtmAuditRule[]\`.`);
        }
        for (const rule of imported) {
            if (!rule?.id || typeof rule.evaluate !== "function") {
                throw new Error(`Rule package ${specifier} exported an invalid rule.`);
            }
            rules.push(rule);
        }
    }
    const enabled = loaded?.config.rules?.enabled;
    if (enabled?.length) {
        const known = new Map(rules.map((rule) => [rule.id, rule]));
        rules = enabled.map((id) => {
            const rule = known.get(id);
            if (!rule) {
                throw new Error(`Config enables unknown rule: ${id}. Known rules: ${Array.from(known.keys()).join(", ")}`);
            }
            return rule;
        });
    }
    const disabled = new Set(loaded?.config.rules?.disabled ?? []);
    return rules.filter((rule) => !disabled.has(rule.id));
}
