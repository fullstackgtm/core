import type { GtmAuditRule, GtmPolicy } from "./types.ts";
/**
 * Project-level configuration: `fullstackgtm.config.json` in the working
 * directory (or an explicit `--config` path). Policy thresholds, rule
 * selection, and rule packages — third-party modules exporting additional
 * `GtmAuditRule`s — all live here so a team's audit standard is reviewable
 * in version control.
 */
export declare const CONFIG_FILE_NAME = "fullstackgtm.config.json";
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
export type RulePackageTrust = {
    /** Execute rule-package modules. Only set after an explicit trust decision. */
    allowRulePackages?: boolean;
    /** Deliberately ignore rule packages while still applying declarative config. */
    disableRulePackages?: boolean;
};
/**
 * Translate the CLI's explicit trust flags into the library trust contract.
 * Plugin execution requires both an explicit config path and --allow-plugins;
 * discovering a config in the current directory is never a trust decision.
 */
export declare function rulePackageTrustFromCli(args: string[], explicitConfigPath?: string): RulePackageTrust;
export declare function loadConfig(explicitPath?: string, cwd?: string): LoadedConfig | null;
/** Overlay config policy values onto a base policy; defined values win. */
export declare function mergePolicy(base: GtmPolicy, config?: FullstackgtmConfig): GtmPolicy;
/**
 * Build the effective rule set: built-ins plus rule-package exports, then
 * `enabled` (allow-list) and `disabled` filters.
 */
export declare function resolveConfiguredRules(loaded?: LoadedConfig | null, baseRules?: GtmAuditRule[], trust?: RulePackageTrust): Promise<GtmAuditRule[]>;
