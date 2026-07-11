// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCredential } from "../credentials.ts";
import { appendCoverage, computeCoverage, coverageCountsFromSnapshot, classifyCoverage, coverageToText, deriveAcvFromClosedWon, deriveBuyersPerAccount, estimateTam, loadTamModel, projectEta, readCoverageTimeline, saveTamModel, tamReportToMarkdown, type AcvBasis, type TamCrossCheck } from "../tam.ts";
import { probeExploriumBusinessCount } from "../connectors/prospectSources.ts";
import { theirStackCountCompanies, theirStackPullCost, theirStackSearchCompanies } from "../connectors/theirstack.ts";
import { clayApiKey } from "../connectors/clay.ts";
import { icpToExploriumBusinessFilters, icpToTheirStackFilters } from "../icp.ts";
import { scheduleCommand } from "./schedule.ts";
import { loadIcp, numericOption, option, readSnapshot, saveRequested } from "./shared.ts";
import { unknownSubcommandError } from "./suggest.ts";


/** Best-effort enrich-config load for apply-time acquire-budget enforcement. */
/** Provider API key: env override first, then the credential store (`login`). */
export function providerKey(provider: "explorium" | "pipe0" | "clay" | "heyreach" | "theirstack"): string {
  if (provider === "clay") return clayApiKey();
  const envName =
    provider === "explorium"
      ? "EXPLORIUM_API_KEY"
      : provider === "pipe0"
        ? "PIPE0_API_KEY"
        : provider === "theirstack"
          ? "THEIRSTACK_API_KEY"
          : "HEYREACH_API_KEY";
  if (process.env[envName]) return process.env[envName] as string;
  const stored = getCredential(provider);
  if (stored) return stored.accessToken;
  throw new Error(`No ${provider} credentials. Run \`echo "$KEY" | fullstackgtm login ${provider}\`, or set ${envName}.`);
}

/**
 * `tam` — Total Addressable Market mapping. Estimate a defensible universe from
 * the ICP, then iteratively populate it via scheduled governed acquire runs and
 * track coverage over time. Subcommands: estimate, status, report, populate.
 */
export async function tamCommand(args: string[]) {
  const [sub, ...rest] = args;
  if (!sub || args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  fullstackgtm tam estimate [--name <n>] [--icp <path>] (--accounts <n> | --source theirstack|explorium)
                            (--acv <annual-usd> | --acv-from-crm --deal-period monthly|quarterly|annual) [--acv-basis account|buyer]
                            [--buyers-per-account <n>] [--cross-checks <file.json>] [source options for a baseline] [--json]
  fullstackgtm tam accounts [--name <n>] [--icp <path>] --source theirstack [--max <n>] [--dry-run | --confirm] [--max-credits <n>] [--usd-per-credit <r>] [--out <file.csv> | --json]
  fullstackgtm tam status   [--name <n>] <source options> [--save] [--json]
  fullstackgtm tam report   [--name <n>] [--out <path>]
  fullstackgtm tam populate [--name <n>] --cron "<expr>" [--source pipe0|explorium|clay|linkedin] [--provider hubspot|salesforce] [--label <l>]

Estimate the reachable market FROM your ICP: a real account count × a confirmed
ANNUAL ACV (--acv <annual-usd>, or --acv-from-crm --deal-period monthly|quarterly|
annual to derive+annualize from closed-won — no band defaults, a bare --provider
does NOT set ACV, refuses without one); buyers/account (explicit or CRM-derived).
Then populate it with scheduled \`enrich acquire --save\` runs (plan-only — apply
stays a separate human gate) and watch coverage close. \`status --save\` stamps the
timeline so \`report\`/ETA can project how long full coverage will take.

--source theirstack counts (and \`tam accounts\` LISTS) companies that actually USE a
CRM/MAP (set firmographics.technologies, e.g. ["salesforce","hubspot"]) — the real
RevOps universe, with real names. --source explorium is a firmographic count only
(NAICS/size/geo, no list). See docs/tam.md.`);
    return;
  }
  const name = option(rest, "--name") ?? "default";

  if (sub === "estimate") {
    const icp = loadIcp(rest);
    if (!icp) {
      throw new Error(
        "tam estimate derives the universe from your ICP — none found (icp.json in cwd, or --icp <path>). " +
          "Build one: `fullstackgtm icp interview`, or scaffold a workspace with `fullstackgtm init`.",
      );
    }
    // The account universe: an explicit --accounts assumption, or a live count of
    // matching COMPANIES. `theirstack` is technographic — it counts companies that
    // actually USE a CRM/MAP (the real RevOps buying signal) and can return the
    // list. `explorium` is a firmographic count only (NAICS/size/geo, no list).
    let accounts = numericOption(rest, "--accounts");
    let accountsSource = "assumption";
    let capped = false;
    const probeSource = option(rest, "--source");
    if (accounts === undefined && probeSource) {
      if (probeSource === "theirstack") {
        const total = await theirStackCountCompanies({
          apiKey: providerKey("theirstack"),
          filters: icpToTheirStackFilters(icp),
        });
        if (total === null) {
          throw new Error(
            "TheirStack returned no total for the ICP — check firmographics.technologies (e.g. [\"salesforce\",\"hubspot\"]) " +
              "and geos/employeeBands, or pass --accounts <n>.",
          );
        }
        accounts = total;
        accountsSource = "provider:theirstack (uses-CRM)";
      } else if (probeSource === "explorium") {
        const probe = await probeExploriumBusinessCount({
          apiKey: providerKey("explorium"),
          filters: icpToExploriumBusinessFilters(icp),
        });
        if (probe === null) {
          throw new Error(
            "Explorium /v1/businesses returned no total for the ICP firmographic — pass --accounts <n>. See docs/tam.md.",
          );
        }
        accounts = probe.total;
        capped = probe.capped;
        accountsSource = capped ? "provider:explorium (≥60k cap — floor)" : "provider:explorium";
      } else {
        throw new Error(
          `tam estimate --source must be theirstack (technographic, uses-CRM + a real list) or explorium ` +
            `(firmographic count only) — got "${probeSource}". pipe0 is a population source, not a count.`,
        );
      }
    }
    if (accounts === undefined) {
      throw new Error(
        "tam estimate needs the account universe size: --source theirstack (count companies that use a CRM), " +
          "--source explorium (firmographic count), or --accounts <n>.",
      );
    }
    const basis = (option(rest, "--acv-basis") ?? "account") as AcvBasis;
    if (basis !== "account" && basis !== "buyer") {
      throw new Error(`tam: --acv-basis must be account|buyer (got "${basis}")`);
    }
    const ccPath = option(rest, "--cross-checks");
    const crossChecks: TamCrossCheck[] = ccPath
      ? (JSON.parse(readFileSync(resolve(process.cwd(), ccPath), "utf8")) as TamCrossCheck[])
      : [];
    // Load the CRM snapshot ONCE if a source is given — reused for the coverage
    // baseline AND for deriving real ACV / buyers-per-account from the CRM.
    const hasSource =
      Boolean(option(rest, "--provider")) ||
      Boolean(option(rest, "--input")) ||
      rest.includes("--demo") ||
      rest.includes("--sample");
    const snapshot = hasSource ? await readSnapshot(rest) : undefined;
    const baseline = snapshot ? coverageCountsFromSnapshot(snapshot) : { accounts: 0, contacts: 0 };

    // ACV must be a REAL, ANNUAL figure that the operator confirms — never a band
    // default, and never silently lifted from the CRM. `--provider` is the
    // COVERAGE source, not the ACV: the TAM's economics aren't HubSpot's job.
    // Two confirmed paths: an explicit annual `--acv`, or an opt-in
    // `--acv-from-crm` that derives the median closed-won amount AND annualizes it
    // per a REQUIRED `--deal-period` (a monthly MRR deal × 12 = annual ACV).
    const acvExplicit = numericOption(rest, "--acv");
    const acvFromCrm = rest.includes("--acv-from-crm");
    let acvValue: number;
    let acvSource: string;
    if (acvExplicit !== undefined) {
      acvValue = acvExplicit;
      acvSource = "explicit (annual)";
    } else if (acvFromCrm) {
      if (!snapshot) {
        throw new Error("--acv-from-crm needs a CRM source — add --provider <crm> or --input <snapshot>.");
      }
      const period = option(rest, "--deal-period");
      const factor = period === "monthly" ? 12 : period === "quarterly" ? 4 : period === "annual" ? 1 : undefined;
      if (factor === undefined) {
        throw new Error(
          "--acv-from-crm requires --deal-period monthly|quarterly|annual — deal amounts can be MRR or annual " +
            "or one-time, and we won't guess (guessing the period is a 4–12× error). e.g. a $15k/mo deal needs " +
            "`--deal-period monthly` → $180k annual ACV.",
        );
      }
      const derived = deriveAcvFromClosedWon(snapshot);
      if (!derived) {
        throw new Error(
          "--acv-from-crm found no closed-won deals with amounts in the snapshot — pass --acv <annual-usd> instead.",
        );
      }
      acvValue = derived.valueUsd * factor;
      acvSource =
        `crm:closed-won (${derived.dealCount} deal${derived.dealCount === 1 ? "" : "s"}, ` +
        `median $${derived.valueUsd.toLocaleString()}/${period}${factor > 1 ? ` ×${factor}` : ""} = annual)`;
    } else {
      throw new Error(
        "tam estimate needs a real ANNUAL ACV — and it won't guess one. Pass --acv <annual-usd> (your " +
          "confirmed annualized ACV), or --acv-from-crm --deal-period monthly|quarterly|annual to derive it " +
          "from closed-won deals. (--provider is your coverage source, not your ACV — it no longer auto-sets it.)",
      );
    }

    // Buyers/account — real signal (avg CRM contacts/account) or an explicit
    // value; never a silent guess. With neither, a clearly-labeled minimal
    // assumption of 1 (so the contact target = accounts, not an inflated number).
    let buyersPerAccount = numericOption(rest, "--buyers-per-account");
    let buyersSource = "explicit";
    if (buyersPerAccount === undefined) {
      const db = snapshot ? deriveBuyersPerAccount(snapshot) : null;
      if (db) {
        buyersPerAccount = db.value;
        buyersSource = `crm:avg-contacts/account (${db.accountsSampled} accounts)`;
      } else {
        buyersPerAccount = 1;
        buyersSource = "assumption:1-buyer (no CRM signal)";
        console.error(
          "tam: buyers/account not given and no CRM contacts to derive from — assuming 1 buyer/account. " +
            "Set --buyers-per-account <n> or pass --provider for a real contacts-per-account average.",
        );
      }
    }
    const createdAt = option(rest, "--today") ?? new Date().toISOString();

    const model = estimateTam({
      name,
      icpName: icp.name,
      accounts,
      accountsSource,
      buyersPerAccount,
      buyersSource,
      // Capture the ICP filter so `tam status` can classify CRM accounts as
      // in/out of THIS TAM (not just count everything).
      targeting: {
        geos: icp.firmographics?.geos,
        employeeBands: icp.firmographics?.employeeBands,
        industries: icp.firmographics?.industries,
        technologies: icp.firmographics?.technologies,
      },
      acv: { basis, valueUsd: acvValue, source: acvSource },
      crossChecks,
      baseline,
      createdAt,
    });
    saveTamModel(model);
    if (rest.includes("--json")) {
      console.log(JSON.stringify(model, null, 2));
      return;
    }
    const coverage = computeCoverage(model, baseline, createdAt);
    console.log(coverageToText(model, coverage, null));
    if (capped) {
      console.log(
        `\n⚠ The account count hit Explorium's 60,000 ceiling — the true universe is LARGER. ` +
          "Treat this TAM as a floor, or narrow the ICP (tighter industry/geo/size) for an exact count.",
      );
    }
    console.log(
      `\nSaved TAM "${name}". Next: schedule population with ` +
        `\`fullstackgtm tam populate --name ${name} --cron "0 7 * * 1-5"\`, ` +
        `then track with \`fullstackgtm tam status --name ${name} --provider hubspot --save\`.`,
    );
    return;
  }

  if (sub === "status") {
    const model = loadTamModel(name);
    if (!model) throw new Error(`No TAM "${name}" — run \`fullstackgtm tam estimate\` first.`);
    const snapshot = await readSnapshot(rest);
    const at = option(rest, "--today") ?? new Date().toISOString();
    // Classify CRM accounts against THIS TAM's ICP — only in-TAM accounts count
    // toward coverage; off-ICP junk lands in out-of-TAM/unknown. Reconciles
    // bottom-up vs top-down (the in-TAM count is a floor on the real universe).
    const coverage = classifyCoverage(model, snapshot, at);
    const save = saveRequested(rest);
    if (save) appendCoverage(name, coverage);
    // Include the current reading in the ETA basis whether or not we persisted it.
    const timeline = save ? readCoverageTimeline(name) : [...readCoverageTimeline(name), coverage];
    const eta = projectEta(model, timeline);
    if (rest.includes("--json")) {
      console.log(JSON.stringify({ model, coverage, eta, saved: save }, null, 2));
      return;
    }
    console.log(coverageToText(model, coverage, eta));
    if (!save) console.log(`\n(reading not saved — add --save to stamp the timeline for ETA tracking)`);
    return;
  }

  if (sub === "report") {
    const model = loadTamModel(name);
    if (!model) throw new Error(`No TAM "${name}" — run \`fullstackgtm tam estimate\` first.`);
    const timeline = readCoverageTimeline(name);
    const eta = projectEta(model, timeline);
    const md = tamReportToMarkdown(model, timeline, eta);
    const out = option(rest, "--out");
    if (out) {
      writeFileSync(resolve(process.cwd(), out), md);
      console.log(`Wrote ${out}.`);
    } else if (rest.includes("--verbose")) {
      console.log(md);
    } else if (timeline.length > 0) {
      console.log(coverageToText(model, timeline.at(-1)!, eta));
      console.log("\nUse --verbose for assumptions, cross-checks, and the full coverage history.");
    } else {
      console.log(`TAM "${model.name}" · ${model.universe.accounts.toLocaleString()} accounts · ${model.universe.contacts.toLocaleString()} buyers · $${Math.round(model.tamUsd).toLocaleString()}`);
      console.log(`ICP ${model.icpName} · ${model.acv.basis}-basis ACV $${Math.round(model.acv.valueUsd).toLocaleString()} (${model.acv.source})`);
      console.log("No coverage readings yet. Run `fullstackgtm tam status --save` to establish one; use --verbose for the full assumptions report.");
    }
    return;
  }

  if (sub === "populate") {
    await tamPopulate(name, rest);
    return;
  }

  if (sub === "accounts") {
    await tamAccounts(rest);
    return;
  }

  throw unknownSubcommandError("tam", sub, ["estimate", "status", "report", "populate", "accounts"]);
}

/**
 * `tam accounts` — pull the REAL target-account list from a technographic source
 * (companies that actually use a CRM, matched to the ICP). This is the
 * materialized list the count can't give you: real names + domains you can
 * review, save, and acquire into the CRM. Read-only (no CRM write); each pulled
 * company costs provider credits, so `--max` caps the page.
 */
async function tamAccounts(rest: string[]) {
  const source = option(rest, "--source") ?? "theirstack";
  if (source !== "theirstack") {
    throw new Error(`tam accounts --source supports theirstack (only technographic list source wired) — got "${source}".`);
  }
  const icp = loadIcp(rest);
  if (!icp) {
    throw new Error("tam accounts needs an ICP (icp.json in cwd, or --icp <path>) — its technologies/firmographics are the filter.");
  }
  const max = Math.min(numericOption(rest, "--max") ?? 25, 100);

  // Pulling the list costs TheirStack credits (~3/company) — never spend by
  // surprise. Show the cost up front; --dry-run prices it without spending; a
  // pull above --max-credits (default 150 ≈ 50 companies) needs --confirm.
  const usdPerCredit = numericOption(rest, "--usd-per-credit") ?? undefined;
  const thisCost = theirStackPullCost(max, usdPerCredit);
  const usdStr = (c: { usd?: number }): string => (c.usd !== undefined ? ` (~$${c.usd.toLocaleString()})` : "");
  const model = loadTamModel(option(rest, "--name") ?? "default");
  const fullUniverse = model?.universe.accounts;
  const fullCost = fullUniverse ? theirStackPullCost(fullUniverse, usdPerCredit) : undefined;
  const costLine =
    `Pull cost: up to ${max} companies ≈ ${thisCost.credits.toLocaleString()} TheirStack credits${usdStr(thisCost)}` +
    (fullCost
      ? `. Full TAM (~${fullUniverse!.toLocaleString()} accounts) ≈ ${fullCost.credits.toLocaleString()} credits${usdStr(fullCost)} to materialize.`
      : ".");

  if (rest.includes("--dry-run")) {
    console.log(`${costLine}\n(dry run — nothing pulled, 0 credits spent. Add --usd-per-credit <rate> for a $ estimate.)`);
    return;
  }
  const maxCredits = numericOption(rest, "--max-credits") ?? 150;
  if (thisCost.credits > maxCredits && !rest.includes("--confirm")) {
    console.error(
      `${costLine}\nThis pull (${thisCost.credits.toLocaleString()} credits) exceeds the --max-credits guard (${maxCredits}). ` +
        "Re-run with --confirm to spend it, lower --max, or --dry-run to just price it.",
    );
    process.exitCode = 2;
    return;
  }
  console.error(costLine);

  const { companies: raw, total } = await theirStackSearchCompanies({
    apiKey: providerKey("theirstack"),
    filters: icpToTheirStackFilters(icp),
    limit: max,
  });
  // A company carries its WHOLE tech stack (often 200+ slugs) — noise. Keep only
  // the ICP-targeted technologies (the CRMs/MAPs that put it in the list).
  const targeted = new Set((icp.firmographics.technologies ?? []).map((t) => t.trim().toLowerCase()));
  const companies = raw.map((c) => ({
    ...c,
    technologies: (c.technologies ?? []).filter((t) => targeted.has(t.toLowerCase())),
  }));
  const out = option(rest, "--out");
  if (rest.includes("--json")) {
    console.log(JSON.stringify({ total, returned: companies.length, companies }, null, 2));
    return;
  }
  if (out) {
    const header = "name,domain,employee_count,country,linkedin_url,matched_technologies";
    const esc = (v: string | number | undefined): string => {
      const s = v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = companies.map((c) =>
      [c.name, c.domain, c.employeeCount, c.countryCode, c.linkedinUrl, (c.technologies ?? []).join("|")]
        .map(esc)
        .join(","),
    );
    writeFileSync(resolve(process.cwd(), out), `${[header, ...rows].join("\n")}\n`);
    console.log(`Wrote ${companies.length} companies to ${out}${total !== null ? ` (of ${total.toLocaleString()} matching)` : ""}.`);
    return;
  }
  console.log(
    `${companies.length} companies${total !== null ? ` of ${total.toLocaleString()} matching the ICP` : ""} ` +
      `(uses ${[...targeted].join("/")}):\n`,
  );
  for (const c of companies) {
    console.log(
      `  ${(c.name ?? "?").padEnd(32)} ${(c.domain ?? "").padEnd(28)} ${String(c.employeeCount ?? "?").padStart(6)} emp  ` +
        `[${(c.technologies ?? []).join(",")}]`,
    );
  }
  console.log(
    `\nNext: stage them with \`fullstackgtm enrich ingest <file.csv> --source clay --objects companies\` ` +
      "→ `enrich acquire` to create governed account records (or re-run with --out <file.csv>).",
  );
}

/**
 * `tam populate` — wire the scheduled population of a TAM: a recurring
 * `enrich acquire --source <s> --save` that queues a needs_approval lead plan
 * each firing (apply stays a separate human gate; the meter is charged only at
 * apply). Delegates to the scheduler so the cron + allowlist (incl. the --save
 * guard) are validated the same way as any `schedule add`.
 */
async function tamPopulate(name: string, rest: string[]) {
  const model = loadTamModel(name);
  if (!model) throw new Error(`No TAM "${name}" — run \`fullstackgtm tam estimate\` first.`);
  const cron = option(rest, "--cron");
  if (!cron) {
    throw new Error('tam populate requires --cron "<expr>" (e.g. "0 7 * * 1-5" = 7am on weekdays)');
  }
  const source = option(rest, "--source") ?? "pipe0";
  const provider = option(rest, "--provider") ?? "hubspot";
  const label = option(rest, "--label") ?? `tam-${name}`;

  const acquireCmd = `enrich acquire --source ${source} --provider ${provider} --save`;
  // Reuse the scheduler: validates the cron, the allowlist, and the --save guard.
  await scheduleCommand(["add", acquireCmd, "--cron", cron, "--label", label]);

  const remainingAccounts = Math.max(0, model.universe.accounts - model.baseline.accounts);
  console.log(
    `\nPopulating TAM "${name}": each firing queues a needs_approval lead plan — apply stays gated, the ` +
      `acquire meter is charged only at apply. ~${remainingAccounts.toLocaleString()} of ` +
      `${model.universe.accounts.toLocaleString()} accounts remain to reach the universe ` +
      `($${model.tamUsd.toLocaleString()} TAM).`,
  );
  console.log(
    "Next: `fullstackgtm schedule install` to activate, then each cycle " +
      "`fullstackgtm plans list` → `plans approve` → `apply`. Track progress with " +
      `\`fullstackgtm tam status --name ${name} --provider ${provider} --save\`.`,
  );
  // Cost lives in two separate places — be explicit so neither surprises.
  const ts = theirStackPullCost(model.universe.accounts);
  console.log(
    `\nCost: population spend is the acquire provider's (${source}), governed by the per-profile acquire meter ` +
      "(records + $/day caps in enrich.config.json) — not TheirStack. Separately, materializing the account LIST " +
      `from TheirStack (\`tam accounts\`) is ~${ts.credits.toLocaleString()} credits for the full ${model.universe.accounts.toLocaleString()}-account ` +
      "universe; `tam accounts --dry-run [--usd-per-credit <r>]` prices any pull without spending.",
  );
}
