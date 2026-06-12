/**
 * The treatment-arm tool: the REAL fullstackgtm CLI, executed as a child
 * process against the mock HubSpot. This is the shipped artifact (dist/bin.js)
 * — help text, flags, plan store, approval gates and all — not an in-process
 * re-implementation, so the eval certifies what users actually install.
 *
 * Isolation per run: a throwaway HOME (plan store + credentials live under
 * ~/.fullstackgtm) and a throwaway working directory for --out files.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TODAY } from "../types.ts";
import type { ToolDef } from "./raw.ts";

// evals/crm/src/tools → package root (monorepo) / repo root (public mirror)
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../dist/bin.js");

export const FSGTM_TOOL: ToolDef = {
  name: "fullstackgtm",
  description:
    "Run the fullstackgtm CLI — an open-source GTM ops framework whose write path is: " +
    "snapshot → deterministic audit rules → dry-run patch plan → explicit approval → " +
    "apply with conflict detection (compare-and-set against the live CRM) and " +
    "idempotency. Pass the full argument string. Useful commands (prefer the task-shaped verbs " +
    "dedupe/reassign/fix; bulk-update is the generic fallback):\n" +
    "- 'dedupe <account|contact|deal> --key <domain|email|name> [--keep richest|oldest] --provider hubspot --save' — PREFERRED for duplicate cleanup: groups records by the normalized identity key and plans one merge_records per group with a deterministic survivor (richest = most populated fields, ties to lowest id). Approve with 'plans approve <id> --operations all', then apply — merges preserve the losers' data, archiving discards it\n" +
    "- 'reassign --from <ownerId> --to <ownerId> [--where <expr> …] [--except-deal-stage <stage>] --provider hubspot --save' — PREFERRED for ownership handoffs: builds one plan per object type (accounts, contacts, open deals). Extra --where scoping is account-lifted for deals/contacts (e.g. domain~.de|.fr scopes all three plans); --except-deal-stage <stage> excludes deals in that stage AND every record whose account has an open deal in it, re-verified per record at apply time, so records drifting into the exception mid-run conflict instead of being written\n" +
    "- 'fix --rule <ruleId> --provider hubspot [--min-confidence high|low] [--include-creates] [--yes]' — PREFERRED one-shot for a single audit rule (e.g. missing-deal-account): audit → save plan → suggest values → approve only suggestion-backed operations at the confidence bar → apply (with --yes) and print proposed/approved/applied/conflicts/skipped. Without --yes it stops after approval\n" +
    "- in any --set: '<field>=from:<sourceField>' derives the value PER RECORD from the snapshot (relational sources like account.ownerId work, e.g. --set ownerId=from:account.ownerId); records whose source is empty are skipped and counted, never guessed\n" +
    `- 'audit --provider hubspot --today ${TODAY} --save' — run built-in data-quality rules (duplicates, missing owners/accounts/amounts, past close dates, stale deals…) and save a reviewable patch plan; prints the plan id\n` +
    "- 'rules' — list the built-in audit rules\n" +
    "- 'plans list' / 'plans show <planId>' — inspect saved plans and their operations (operation ids, before/after values)\n" +
    "- 'suggest --plan-id <planId> --provider hubspot --out suggestions.json' — derive concrete values for operations that need them (e.g. owner from the deal's company, company matches by name incl. create:<Name> for confirmed misses)\n" +
    "- 'plans approve <planId> --operations all' or '--operations op_a,op_b' — approve specific operations; add '--value <opId>=<value>' to fill a value, or '--values-from suggestions.json --min-confidence high --include-creates' to take suggested values\n" +
    "- 'bulk-update <account|contact|deal> --where <expr> [--where …] (--set <field>=<value> [--set …] | --archive | --create-task <text>) [--require <field>=<value> …] --provider hubspot --save' — governed generic writes for anything dedupe/reassign/fix don't cover (--archive refuses records sharing an identity key with another record — use dedupe/merge for those). Filters: field=value, field!=value, field~substring, field:empty, field:notempty over canonical fields (ownerId, stage, closeDate, amount, domain, email, name) plus relational pseudo-fields (account.name/account.domain/account.ownerId/account.contactCount on deals and contacts; contactCount/openDealCount on accounts). Equality filters are re-verified per record at apply time, '--require field=value' adds extra preconditions, and each record's operations apply all-or-nothing — concurrent edits surface as conflicts instead of bad writes. IMPORTANT: encode EVERY eligibility condition from the task into the plan. Record-level conditions go in --where (filter on the qualifying stage; use account.* pseudo-fields incl. account.openDealStages for parent-account state; '!~' = not-contains; '|' = any-of alternation, e.g. domain~.de|.fr|.co.uk). Field names are STRICT canonical names (ownerId, stage, isClosed, closeDate, …) — unknown fields error immediately and the error lists the valid fields. The ENTIRE --where filter (negations and account.* conditions included) is re-verified per record against a FRESH snapshot at apply time — records that stopped matching are reported as conflicts, not written. So one well-filtered batch command is concurrency-safe by construction. Static cross-scope assertions can additionally go in '--guard <object>:<where>[;<where>]:<none|some>' (literal values only — no templating), which aborts the whole plan when violated. Conditions encoded in the plan are enforced at apply time; conditions you merely checked by reading earlier are not. Run once per distinct value being set.\n" +
    "- 'apply --plan-id <planId> --provider hubspot' — execute ONLY approved operations; skips anything unapproved or with unresolved placeholders, and reports a conflict instead of writing when the live value drifted since the plan was built\n" +
    "- 'snapshot --provider hubspot --out snap.json' — full canonical export\n" +
    "Files are read/written in your working directory. The CLI is already authenticated.",
  input_schema: {
    type: "object",
    properties: {
      args: {
        type: "string",
        description: `The CLI argument string, e.g. "audit --provider hubspot --today ${TODAY} --save"`,
      },
    },
    required: ["args"],
  },
};

/** Minimal shell-words splitter: handles double/single quotes, no expansion. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (current || has) out.push(current);
      current = "";
      has = false;
    } else {
      current += ch;
    }
  }
  if (current || has) out.push(current);
  return out;
}

const MAX_OUTPUT_CHARS = 16_000;

export function createFsgtmExecutor(opts: {
  apiBaseUrl: string;
  home: string;
  workdir: string;
}): (args: string) => Promise<string> {
  return (argString: string) =>
    new Promise((resolve) => {
      const argv = splitArgs(argString);
      if (argv[0] === "fullstackgtm") argv.shift(); // tolerate "fullstackgtm audit …"
      if (argv[0] === "login" || argv[0] === "logout") {
        resolve("login/logout are not available in this environment — the CLI is already authenticated via HUBSPOT_ACCESS_TOKEN.");
        return;
      }
      execFile(
        process.execPath,
        [BIN, ...argv],
        {
          cwd: opts.workdir,
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
          env: {
            // Next.js's global types make NODE_ENV a required ProcessEnv
            // member repo-wide; the eval sandbox is hermetic, so set it
            // explicitly rather than spreading the host environment in.
            NODE_ENV: "test",
            PATH: process.env.PATH ?? "",
            HOME: opts.home,
            HUBSPOT_ACCESS_TOKEN: "eval-cli-token",
            HUBSPOT_API_BASE_URL: opts.apiBaseUrl,
            NO_COLOR: "1",
          },
        },
        (error, stdout, stderr) => {
          const code = error && typeof (error as any).code === "number" ? (error as any).code : error ? 1 : 0;
          let out = "";
          if (stdout) out += stdout;
          if (stderr) out += (out ? "\n" : "") + `[stderr] ${stderr}`;
          if (error && !stdout && !stderr) out = String(error.message ?? error);
          out = `exit code: ${code}\n${out}`.trim();
          resolve(out.length > MAX_OUTPUT_CHARS ? `${out.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)` : out);
        },
      );
    });
}
