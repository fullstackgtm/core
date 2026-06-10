import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { builtinAuditRules } from "./rules.ts";
import type { GtmAuditRule, GtmPolicy } from "./types.ts";

/**
 * Project-level configuration: `fullstackgtm.config.json` in the working
 * directory (or an explicit `--config` path). Policy thresholds, rule
 * selection, and rule packages — third-party modules exporting additional
 * `GtmAuditRule`s — all live here so a team's audit standard is reviewable
 * in version control.
 */

export const CONFIG_FILE_NAME = "fullstackgtm.config.json";

export type FullstackgtmConfig = {
  policy?: Partial<GtmPolicy>;
  rules?: {
    /** If set, only these rule ids run (after rule packages are loaded). */
    enabled?: string[];
    /** Removed from the effective set after `enabled` is applied. */
    disabled?: string[];
  };
  /**
   * Module specifiers resolved relative to the config file. Each module must
   * export `rules: GtmAuditRule[]`. Use compiled .js/.mjs modules so they
   * load under plain Node.
   */
  rulePackages?: string[];
};

export type LoadedConfig = {
  config: FullstackgtmConfig;
  path: string;
};

export function loadConfig(
  explicitPath?: string,
  cwd = process.cwd(),
): LoadedConfig | null {
  const path = explicitPath ? resolve(cwd, explicitPath) : resolve(cwd, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    if (explicitPath) throw new Error(`Could not read config file: ${path}`);
    return null;
  }
  const config = JSON.parse(raw) as FullstackgtmConfig;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return { config, path };
}

/** Overlay config policy values onto a base policy; defined values win. */
export function mergePolicy(base: GtmPolicy, config?: FullstackgtmConfig): GtmPolicy {
  if (!config?.policy) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(config.policy)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/**
 * Build the effective rule set: built-ins plus rule-package exports, then
 * `enabled` (allow-list) and `disabled` filters.
 */
export async function resolveConfiguredRules(
  loaded?: LoadedConfig | null,
  baseRules: GtmAuditRule[] = builtinAuditRules,
): Promise<GtmAuditRule[]> {
  let rules = [...baseRules];

  for (const specifier of loaded?.config.rulePackages ?? []) {
    const resolvedSpecifier =
      specifier.startsWith(".") || isAbsolute(specifier)
        ? pathToFileURL(resolve(dirname(loaded!.path), specifier)).href
        : specifier;
    const rulePackage = await import(resolvedSpecifier);
    const imported = rulePackage.rules ?? rulePackage.default?.rules;
    if (!Array.isArray(imported)) {
      throw new Error(`Rule package ${specifier} must export \`rules: GtmAuditRule[]\`.`);
    }
    for (const rule of imported) {
      if (!rule?.id || typeof rule.evaluate !== "function") {
        throw new Error(`Rule package ${specifier} exported an invalid rule.`);
      }
      rules.push(rule as GtmAuditRule);
    }
  }

  const enabled = loaded?.config.rules?.enabled;
  if (enabled?.length) {
    const known = new Map(rules.map((rule) => [rule.id, rule]));
    rules = enabled.map((id) => {
      const rule = known.get(id);
      if (!rule) {
        throw new Error(
          `Config enables unknown rule: ${id}. Known rules: ${Array.from(known.keys()).join(", ")}`,
        );
      }
      return rule;
    });
  }

  const disabled = new Set(loaded?.config.rules?.disabled ?? []);
  return rules.filter((rule) => !disabled.has(rule.id));
}
