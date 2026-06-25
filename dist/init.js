/**
 * `fullstackgtm init` — scaffold a GTM workspace from cold scratch.
 *
 * The product thesis (see docs/recipes.md): the CLI ships governed PRIMITIVES;
 * the user's coding agent is the orchestrator. There is deliberately no
 * `outbound` mega-verb. `init` is the one piece of scaffolding that earns its
 * keep — it writes the three files a workspace needs so the very first
 * `enrich acquire` / `signals` / `judge` / `draft` commands work, plus a
 * PLAYBOOK that points at the recipes wired with THIS workspace's source and
 * provider.
 *
 * It is a pure file-writer: no network, no credentials, never overwrites
 * without `--force`. The starter ICP is a valid (editable) example so
 * `icp show` / `enrich acquire` run immediately; re-run `icp interview` to
 * replace it with a real one.
 */
import { builtinAcquirePreset, ENRICH_CONFIG_FILE_NAME } from "./enrich.js";
import { DEFAULT_FIT_THRESHOLD } from "./icp.js";
/** A placeholder owner id that can never match a real one, so the assign block
 *  is VISIBLE (leads route through it) yet safe: an unknown owner resolves to
 *  unassigned with a warning, never a wrong owner. Replace before acquiring. */
const PLACEHOLDER_OWNER = "REPLACE_WITH_OWNER_ID";
/** A generic, valid starter ICP. Edit it, or replace via `icp interview`. */
export function starterIcp() {
    return {
        name: "Example ICP — edit me (or rebuild with `fullstackgtm icp interview`)",
        firmographics: {
            industries: ["software", "saas"],
            employeeBands: ["51-200", "201-500", "501-1000"],
            geos: ["us"],
        },
        persona: {
            jobLevels: ["vp", "director", "manager"],
            departments: ["sales", "operations"],
            titleKeywords: ["revenue operations", "revops", "sales operations", "gtm operations"],
        },
        scoring: { threshold: DEFAULT_FIT_THRESHOLD },
    };
}
/** The acquire preset for the chosen source, with an explicit (placeholder)
 *  assign policy so the seam is visible — leads are never silently ownerless. */
export function starterEnrichConfig(source) {
    const preset = builtinAcquirePreset(source);
    if (!preset?.acquire) {
        // builtinAcquirePreset covers pipe0/explorium/linkedin, so this is unreachable
        // for the typed InitSource set — guard anyway rather than emit a broken file.
        throw new Error(`init: no acquire preset for source "${source}"`);
    }
    return {
        ...preset,
        acquire: { ...preset.acquire, assign: { strategy: "fixed", ownerId: PLACEHOLDER_OWNER } },
    };
}
function profileFlag(profile) {
    return profile ? ` --profile ${profile}` : "";
}
/** The workspace PLAYBOOK: the cold-start + outbound-loop recipes wired with the
 *  chosen source/provider/profile, pointing at docs/recipes.md for the rest. */
export function starterPlaybook(opts) {
    const { source, provider, profile } = opts;
    const p = profileFlag(profile);
    const loginSource = source === "linkedin" ? "heyreach" : source;
    return `# Workspace playbook

Scaffolded by \`fullstackgtm init\` for **${provider}**, discovery via **${source}**${profile ? `, profile **${profile}**` : ""}.

This CLI ships governed **primitives** — there is no \`outbound\` command. **You
(the coding agent) are the orchestrator:** chain the verbs into the play the
operator wants, surface the one approve gate, and bridge the last mile to the
sender. **The package never sends** — \`draft\` produces an approved task/opener;
the actual send happens in the operator's own channel tool.

Full recipe set: **docs/recipes.md** (cold-start, the trigger→judge→draft
outbound loop, scheduled-continuous, ABM-from-companies, hygiene-gated).

## 0. Connect (secrets via stdin/env, never argv)

\`\`\`bash
echo "$${provider === "hubspot" ? "HUBSPOT_TOKEN" : "SALESFORCE_ACCESS_TOKEN"}" | fullstackgtm login ${provider}${p}
echo "$${loginSource.toUpperCase()}_API_KEY" | fullstackgtm login ${loginSource}${p}
\`\`\`

## 1. Edit your targeting + assignment

- \`icp.json\` — the starter ICP. Edit it, or rebuild: \`fullstackgtm icp interview\`
  (an agent drives the questions) → \`fullstackgtm icp set answers.json\`.
- \`${ENRICH_CONFIG_FILE_NAME}\` — set \`acquire.assign.ownerId\` (currently
  \`${PLACEHOLDER_OWNER}\`) so acquired leads are never ownerless, or pass
  \`--assign-owner <id>\` per run. Tune \`acquire.budget\` (records + spend caps).

## 2. Cold start — fill the CRM with targeted, owned, emailed leads

\`\`\`bash
fullstackgtm enrich acquire --source ${source} --provider ${provider}${p} --json   # dry-run plan, writes NOTHING
fullstackgtm enrich acquire --source ${source} --provider ${provider}${p} --save    # persist as needs_approval
fullstackgtm plans approve <plan-id>${p} --operations all
fullstackgtm apply --plan-id <plan-id> --provider ${provider}${p}
\`\`\`

Each lead lands owner-stamped and linked to a domain-stamped **account**, so the
signals/judge layer can watch it.

## 3. Outbound loop — reach an account the week something changes

\`\`\`bash
fullstackgtm signals fetch --bucket job,funding --watchlist crm:<segment>${p} --save
fullstackgtm icp judge --signals-from latest --provider ${provider}${p} --save --json   # pass the snapshot → resolves accountId + contact
fullstackgtm draft --from-judge latest --channel email${p} --save --json                # one grounded opener per hot account, as a create_task
fullstackgtm plans approve <plan-id>${p} --operations all
fullstackgtm apply --plan-id <plan-id> --provider ${provider}${p}
# → the agent sends the approved opener via the operator's channel tool, then:
fullstackgtm signals outcome --account <domain> --contact <contactId> --result replied${p}
\`\`\`

A domain-only judge decision (account not yet in the CRM) is rejected by \`draft\`
with "acquire it first" — run step 2 for that account, then re-judge.

## The boundary

- **Read freely. Write only through \`plans approve → apply\`.**
- **The package never sends.** \`draft\` is the last governed step.
- **You are the orchestrator.** These are starting points — compose them.
`;
}
/**
 * Build the set of files `init` would write (pure — no IO). The caller decides
 * which to actually write (skipping existing files unless --force).
 */
export function scaffoldWorkspace(opts = {}) {
    const source = opts.source ?? "pipe0";
    const provider = opts.provider ?? "hubspot";
    return [
        { path: "icp.json", content: `${JSON.stringify(starterIcp(), null, 2)}\n` },
        {
            path: ENRICH_CONFIG_FILE_NAME,
            content: `${JSON.stringify(starterEnrichConfig(source), null, 2)}\n`,
        },
        { path: "PLAYBOOK.md", content: starterPlaybook({ source, provider, profile: opts.profile }) },
    ];
}
