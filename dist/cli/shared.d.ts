import { type LlmProvider } from "../llm.ts";
import { type Icp } from "../icp.ts";
import type { CanonicalGtmSnapshot, GtmConnector } from "../types.ts";
import { type ProgressEmitter } from "../progress.ts";
export declare function option(args: string[], name: string): string | null;
export declare function repeatedOption(args: string[], name: string): string[];
/**
 * Additive alias: `--dry-run` asserts the preview default. Every verb that
 * honors it is already preview-by-default (plans are dry-run; nothing writes
 * to a CRM without approve → apply) — the flag additionally suppresses
 * `--save` (and the `fix --yes` write stage) so the invocation can never
 * persist a plan/run record or reach a write. Omitting it changes nothing:
 * defaults stay exactly as before.
 */
export declare function dryRunRequested(args: string[]): boolean;
/** `--save`, unless `--dry-run` locks the preview default (see dryRunRequested). */
export declare function saveRequested(args: string[]): boolean;
/**
 * Additive alias: `--confirm` is accepted wherever an ad-hoc confirmation
 * flag already gates a write stage (e.g. `fix --yes`). The old flags keep
 * working; `--dry-run` wins over both.
 */
export declare function confirmRequested(args: string[], ...legacyAliases: string[]): boolean;
export declare function numericOption(args: string[], name: string): number | undefined;
export declare function connectorFor(provider: string, args: string[], progress?: ProgressEmitter): Promise<GtmConnector>;
export declare function readSnapshot(args: string[], progress?: ProgressEmitter, options?: {
    persistProgress?: boolean;
}): Promise<CanonicalGtmSnapshot>;
/**
 * Validate that an --input file actually has the canonical snapshot shape
 * (the JSON `snapshot --out` writes) instead of blindly casting — a plan or
 * arbitrary JSON passed here used to surface as a confusing crash deep in a
 * rule, or worse, an empty "clean" audit.
 */
export declare function assertCanonicalSnapshot(parsed: unknown, source: string): CanonicalGtmSnapshot;
export declare function selectedRules(args: string[], baseRules?: import("../types.ts").GtmAuditRule[]): import("../types.ts").GtmAuditRule[];
/**
 * First-touch key onboarding: env vars win, then the credential store; on a
 * TTY a missing key is captured once (validated, stored 0600 like provider
 * logins). Non-interactive contexts get an actionable error instead.
 */
export declare function requireLlmCredential(command?: "parse" | "score" | "market classify"): Promise<{
    provider: LlmProvider;
    apiKey: string;
    anthropicBaseUrl?: string;
    openaiBaseUrl?: string;
}>;
/**
 * Read optional LLM base-URL overrides from env so the package can run against
 * an Anthropic/OpenAI-compatible gateway (GLM-5.2, z.ai, Ollama) without code
 * changes. Returns only the keys that are set; an empty object when neither is,
 * so spreading into LlmCallOptions is a no-op by default.
 */
export declare function resolveLlmBaseUrls(env?: Record<string, string | undefined>): {
    anthropicBaseUrl?: string;
    openaiBaseUrl?: string;
};
/** Load the active ICP: --icp <path>, else ./icp.json. Undefined if none. */
export declare function loadIcp(args: string[]): Icp | undefined;
/**
 * Read a secret without exposing it on the command line. Secrets passed as
 * argv leak through the process list (`ps`), `/proc`, and shell history, so
 * the CLI never accepts them as flags. Instead:
 *   - non-interactive: pipe it on stdin (docker `--password-stdin` style),
 *     e.g. `echo "$TOKEN" | fullstackgtm login hubspot`
 *   - interactive: prompted on the TTY with the input muted
 */
export declare function readSecret(label: string): Promise<string>;
export declare function isOptionValue(args: string[], arg: string): boolean;
export declare function readPackageInfo(): {
    name: string;
    version: string;
};
