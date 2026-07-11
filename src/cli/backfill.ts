// `backfill stripe` — paid Stripe invoices → closed-won deal proposals through
// the governed plan/apply flow. This command NEVER writes to a CRM: it reads
// paid invoices (Stripe, read-only), reads a CRM snapshot, and builds a
// dry-run create_record plan. --save persists the plan for the normal
// plans approve → apply spine, where the HubSpot connector re-resolves each
// invoice id (resolve-first) and creates only on a confirmed miss.

import { buildStripeBackfillPlan, DEFAULT_BACKFILL_MATCH_PROPERTY } from "../backfill.ts";
import { fetchStripePaidInvoices } from "../connectors/stripe.ts";
import { getCredential } from "../credentials.ts";
import { patchPlanToMarkdown } from "../format.ts";
import { createFilePlanStore } from "../planStore.ts";
import { BACKFILL_STRIPE_STAGES, composeListeners, createProgressEmitter } from "../progress.ts";
import { progressReporter } from "../runReport.ts";
import { unknownSubcommandError } from "./suggest.ts";
import { option, readSnapshot, saveRequested } from "./shared.ts";
import { colorEnabled, createProgressRenderer, paint, stylizePlanMarkdown, table } from "./ui.ts";
import { compactPlan, verbosePlanRequested } from "./planOutput.ts";

/** STRIPE_SECRET_KEY env ∨ stored `login stripe` credential (same ladder as `--provider stripe`). */
function resolveStripeKey(): string {
  const key = process.env.STRIPE_SECRET_KEY ?? getCredential("stripe")?.accessToken;
  if (!key) {
    throw new Error(
      "No Stripe credentials. Run `echo \"$STRIPE_KEY\" | fullstackgtm login stripe` or set STRIPE_SECRET_KEY. " +
        "A restricted key with read access to Invoices and Customers is enough. (`fullstackgtm doctor` shows credential status.)",
    );
  }
  return key;
}

export async function backfillCommand(args: string[]) {
  const [subcommand, ...rest] = args;
  if (subcommand === "runs") {
    const { backfillRunsCommand } = await import("./backfillRuns.ts");
    await backfillRunsCommand(rest);
    return;
  }
  if (subcommand !== "stripe") {
    throw unknownSubcommandError("backfill", subcommand ?? "", ["stripe", "runs"]);
  }

  const since = option(rest, "--since");
  const pipeline = option(rest, "--pipeline") ?? undefined;
  const matchProperty = option(rest, "--match-property") ?? undefined;
  const skipUnmatched = rest.includes("--skip-unmatched");
  const save = saveRequested(rest);

  // Shared progress: the BACKFILL_STRIPE_STAGES tick on an interactive stderr
  // board (inert when piped) and heartbeat to a paired hosted app on long runs.
  const renderer = createProgressRenderer(BACKFILL_STRIPE_STAGES);
  const progress = createProgressEmitter(
    composeListeners(renderer.listener, progressReporter()),
  );
  const stage = (name: (typeof BACKFILL_STRIPE_STAGES)[number]) =>
    progress.stage(name, BACKFILL_STRIPE_STAGES.indexOf(name), BACKFILL_STRIPE_STAGES.length);
  let result: ReturnType<typeof buildStripeBackfillPlan>;
  try {
    // 1. Revenue truth: paid invoices from Stripe (read-only).
    stage("invoices");
    const stripeKey = resolveStripeKey();
    const invoices = await fetchStripePaidInvoices(
      { getApiKey: () => stripeKey },
      { ...(since ? { sinceIso: since } : {}), onPage: (fetched) => progress.items(fetched) },
    );

    // 2. The CRM as it stands (same source options as audit: --provider <crm>,
    //    --input <snapshot.json>, --demo, --sample). The pull's own stage/items
    //    events ride the same emitter (the board ignores the nested stages).
    stage("snapshot");
    const snapshot = await readSnapshot(rest, progress);

    // 3. Dry-run plan: one closed-won create_record deal per invoice with no
    //    deal yet; unmatched customers also get a proposed account (unless
    //    --skip-unmatched restores report-only behavior).
    stage("matching");
    result = buildStripeBackfillPlan(invoices, snapshot, {
      pipeline,
      matchProperty,
      source: "stripe:invoices",
      createMissingAccounts: !skipUnmatched,
    });
    stage("plan");
    progress.flush();
  } finally {
    renderer.done();
  }

  if (rest.includes("--json")) {
    console.log(
      JSON.stringify(
        { plan: result.plan, counts: result.counts, unmatched: result.unmatched, proposedAccounts: result.proposedAccounts },
        null,
        2,
      ),
    );
  } else if (!verbosePlanRequested(rest)) {
    console.log(compactPlan(result.plan, { saved: save && result.plan.operations.length > 0 }));
  } else {
    // TTY-only styling; piped output stays byte-identical plain text.
    console.log(
      stylizePlanMarkdown(patchPlanToMarkdown(result.plan), paint(colorEnabled(process.stdout))),
    );
    if (result.proposedAccounts.length > 0) {
      console.log(
        `\nProposed new accounts (${result.proposedAccounts.length}) — Stripe customers the CRM doesn't know; ` +
          "created only if this plan is approved and applied:",
      );
      const accountRows = [
        ["account", "domain", "invoices"],
        ...result.proposedAccounts.map((entry) => [
          entry.name,
          entry.domain ?? "—",
          String(entry.invoiceCount),
        ]),
      ];
      for (const line of table(accountRows)) console.log(`  ${line}`);
    }
    if (result.unmatched.length > 0) {
      console.log(
        `\nUnmatched invoices (${result.unmatched.length}) — ${
          skipUnmatched
            ? "customer matched no CRM account by domain or name; reported only (--skip-unmatched)"
            : "customer has no usable name or company domain; reported only"
        }:`,
      );
      const rows = [
        ["invoice", "customer", "domain", "amount", "paid"],
        ...result.unmatched.map((entry) => [
          entry.invoiceNumber ?? entry.invoiceId,
          entry.customerName ?? "—",
          entry.customerDomain ?? "—",
          `${entry.amountPaid}${entry.currency ? ` ${entry.currency}` : ""}`,
          entry.paidAt ?? "—",
        ]),
      ];
      for (const line of table(rows)) console.log(`  ${line}`);
    }
  }

  if (!save) {
    console.error(
      "\nDry run — nothing written. Re-run with --save to persist the plan, then approve + apply.",
    );
    return;
  }
  if (result.plan.operations.length === 0) {
    console.error("No deals to backfill (every paid invoice already matched a deal or its customer was unmatched); nothing saved.");
    return;
  }
  await createFilePlanStore().save(result.plan);
  console.error(
    `Saved plan ${result.plan.id} — ${result.counts.planned} closed-won deal(s)` +
      `${result.counts.accountsProposed > 0 ? ` + ${result.counts.accountsProposed} new account(s)` : ""} from ${result.counts.invoices} paid invoice(s). ` +
      `Review \`fullstackgtm plans show ${result.plan.id}\`, approve \`fullstackgtm plans approve ${result.plan.id} --operations all\`, ` +
      `then \`fullstackgtm apply --plan-id ${result.plan.id} --provider hubspot\`. ` +
      `Apply re-checks ${result.plan.operations.length ? `the ${matchProperty ?? DEFAULT_BACKFILL_MATCH_PROPERTY} dedupe key` : "resolve-first"} before creating.`,
  );
}
