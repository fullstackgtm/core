// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { getCredential } from "../credentials.ts";
import { patchPlanToMarkdown } from "../format.ts";
import { createFilePlanStore } from "../planStore.ts";
import { buildAcquirePlan, buildEnrichPlan, createFileEnrichRunStore, DEFAULT_STALE_DAYS, ENRICH_CONFIG_FILE_NAME, builtinAcquirePreset, builtinEnrichPreset, enrichRunId, inferIngestObjectType, latestStamps, loadEnrichConfig, parseCsv, resolveCrmField, selectStaleWork, stagedSourceRecords, staleDaysFor, type EnrichConfig, type EnrichCounts, type EnrichObjectType, type EnrichRun, type EnrichRunStore, type EnrichSourceRecord } from "../enrich.ts";
import { loadMeter, remaining, type AcquireRemaining } from "../acquireMeter.ts";
import { crmContactKeys, fetchExploriumProspects, fetchPipe0CrustdataProspectPage, partitionFreshProspects, pipe0ResolveCompanyDomains, pipe0ResolveProfileContacts, pipe0ResolveWorkEmails, prospectIdentityKeys, type Prospect } from "../connectors/prospectSources.ts";
import { createClaySearch, discoverClayInvestmentProspects, runClayPeopleSearchPage } from "../connectors/clay.ts";
import { runContactWaterfall, type ContactProviderAdapter, type ContactWaterfallStep } from "../contactProviders.ts";
import { loadSeen, recordSeen } from "../acquireSeen.ts";
import { acquireCheckpointId, createFileAcquireCheckpointStore, type AcquireCheckpointKey } from "../acquireCheckpoint.ts";
import { readHostedAcquireCheckpoint, writeHostedAcquireCheckpoint } from "../hostedAcquireCheckpoint.ts";
import { uploadHostedPatchPlan } from "../hostedPatchPlan.ts";
import { progressReporter, reportCounts, reportEvent } from "../runReport.ts";
import { ACQUIRE_STAGES, composeListeners, createProgressEmitter } from "../progress.ts";
import { createLinkedInProvider, discoverLinkedInProspects } from "../acquireLinkedIn.ts";
import { clayPeopleFilterRoutes, fitThreshold, icpToClayInvestmentCompanyFilters, icpToClayPeopleFilters, icpToCrustdataFilters, icpToExploriumFilters, scoreProspectAgainstIcp, type Icp } from "../icp.ts";
import { apolloPullKeysForAppend, apolloPullKeysForRefresh, createApolloClient, pullApolloRecords, type ApolloPullKey } from "../enrichApollo.ts";
import type { CanonicalGtmSnapshot, CreateRecordPayload } from "../types.ts";
import { isSpoolPath, readSpoolPath } from "../spoolFiles.ts";
import { isOptionValue, loadIcp, numericOption, option, readSnapshot, saveRequested } from "./shared.ts";
import { providerKey } from "./tam.ts";
import { unknownSubcommandError } from "./suggest.ts";
import { box, colorEnabled, createProgressRenderer, createStatusLine, formatBar, formatDuration, paint, scoreColor, truncateToWidth, type Paint } from "./ui.ts";
import { compactPlan, verbosePlanRequested } from "./planOutput.ts";
import type { AcquireBudget } from "../acquireMeter.ts";


/**
 * The enrich layer: governed append/refresh of third-party data (Apollo pull,
 * Clay ingest) into the CRM through the normal dry-run → approval → apply
 * contract. State lives in the profile-scoped run store (checkpoint,
 * staleness ledger, observability in one); scheduling belongs to the
 * horizontal scheduler — enrich owns no cron logic.
 */
export async function enrichCommand(args: string[]) {
  const [subcommand, ...rest] = args;

  // Catch --help BEFORE config load, credential resolution, or any network
  // call (the 0.14.1/0.18 bug class — `enrich append --help` executing a
  // paid Apollo pull would be its worst recurrence).
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(`Usage:
enrich append  [--source apollo] [--objects companies,contacts] [--save] [--config <path>]
               [source options] [--run-label <label>] [--json]
enrich refresh [--source apollo] [--stale-days <n>] [--save] [--config <path>]
               [source options] [--run-label <label>] [--json]
enrich ingest  <file.csv|payload.json|spool.jsonl|spool-dir> --source clay [--run-label <label>] [--objects companies|contacts] [--config <path>]
enrich acquire [--source <id>] [--max <new-leads>] [--scan-limit <candidates>] [--company-domain <domain>] [--list <id>] [--assign-owner <id>] [--save] [--config <path>] [--json]
enrich status  [--runs] [--source <id>] [--config <path>] [--json]

acquire creates NET-NEW leads from a staged prospect list (ingest first):
it dedupes each sourced row against the CRM, skips matches and ambiguities
(resolve-first never creates over a possible duplicate), and proposes a
\`create_record\` op per confirmed net-new row — capped by the acquire meter's
remaining budget (records + spend, per day and per month; whichever is hit
first). Approval-gated like every write: \`--save\` → plans approve → apply.
The meter is charged only when a create actually lands at apply.
\`--max\` controls the desired net-new plan size; \`--scan-limit\` separately
bounds raw candidates scanned after ICP and dedupe filtering. Continuation is
persisted per query so scheduled runs advance instead of rereading page one.
Discovery sources (zero-config presets): explorium | pipe0 (ICP-driven search),
and linkedin (reads a HeyReach lead list — pass --list <id>, key on the LinkedIn
URL, $0/record; \`login heyreach\` or HEYREACH_API_KEY).

Leads are never born ownerless: set an \`acquire.assign\` policy (fixed /
round-robin / territory / account-owner) to stamp an owner at create time, or
pass \`--assign-owner <id>\`. With a single-owner portal and no policy, acquire
defaults every lead to that owner; with several owners and no policy it warns
and leaves them unassigned. Backfill existing ownerless records with
\`reassign --assign-unowned --to <ownerId>\`.

append pulls from an api source (Apollo — BYO key via \`login apollo\` or
APOLLO_API_KEY) or reads data staged by \`enrich ingest\` (Clay CSV exports,
webhook payload JSON), matches source records to CRM records via the ordered
match keys in enrich.config.json (unique hit wins; zero hits falls through to
the next key; multiple hits skip or flow into the suggest chain, per
onAmbiguous), and emits a fill-blanks-only patch plan. Without --save it
prints the dry-run diff and writes NOTHING; with --save the plan lands in the
plan store as needs_approval and the run (counts, per-field enrichedAt stamps,
resume cursor) lands in the profile's enrich run store. From there the normal
chain takes over: plans approve → apply.

refresh computes its work set from the run-store stamps — fields enrich
itself wrote, opted in with "refresh": true, older than the staleness window
(--stale-days overrides per-field staleDays and policy.defaultStaleDays) —
re-fetches the source, and proposes updates only where the source value
actually changed. Every operation carries beforeValue, so apply-time
compare-and-set rejects writes over a CRM that moved underneath the plan.

Conflict policy (MVP): "never" — enrich only fills blank fields and only
re-touches fields its own ledger proves it stamped. system-only and always
are phase 2. Recurring execution is the scheduler's job; enrich has no cron.`);
    return;
  }

  if (!["append", "refresh", "ingest", "status", "acquire"].includes(subcommand)) {
    throw unknownSubcommandError("enrich", subcommand, ["append", "refresh", "ingest", "status", "acquire"]);
  }

  const configPath = () => resolve(process.cwd(), option(rest, "--config") ?? ENRICH_CONFIG_FILE_NAME);
  const store = createFileEnrichRunStore();

  if (subcommand === "status") {
    await enrichStatus(store, rest, configPath());
    return;
  }

  // Config resolution: an explicit --config or an on-disk default always wins
  // (and validates). Only when neither exists do we fall back to a built-in
  // preset for the source (e.g. `--source clay`), so the common Mode-A loop
  // needs no hand-authored config. A present-but-invalid config still errors.
  const explicitConfig = option(rest, "--config");
  const configFile = configPath();
  // No config file + no --config → fall back to a built-in preset so the common
  // paths need zero hand-authored config: `acquire` gets the zero-config acquire
  // preset (targeted/deduped/metered out the gate); other verbs get the source
  // preset (e.g. clay ingest). An explicit/on-disk config always wins.
  const presetFor = (src: string | undefined) =>
    subcommand === "acquire" ? builtinAcquirePreset(src) : builtinEnrichPreset(src);
  const config =
    !explicitConfig && !existsSync(configFile)
      ? (presetFor(option(rest, "--source") ?? undefined) ?? loadEnrichConfig(configFile))
      : loadEnrichConfig(configFile);

  // `enrich ingest` stages rows. If the same command also names a CRM source
  // (--input/--provider), collapse the two-step into one: stage, then run the
  // append against the just-staged data so `enrich ingest clay.csv --source clay
  // --input snap.json` returns the hygiene verdict end-to-end. Without a CRM
  // source it stays stage-only (the existing two-step is preserved).
  if (subcommand === "ingest") {
    const autoAppend = Boolean(option(rest, "--provider") || option(rest, "--input"));
    await enrichIngest(store, config, rest, autoAppend);
    if (!autoAppend) return;
  }

  if (subcommand === "acquire") {
    if (!config.acquire) {
      throw new Error(
        'enrich acquire: config has no "acquire" section. Add e.g. { "acquire": { "create": { "contact": { "matchKey": "email", "properties": { "email": "email", "firstname": "first_name", "lastname": "last_name" } } }, "budget": { "records": { "perDay": 50, "perMonth": 500 } }, "costPerRecord": { "clay": 0.10 } } } to enrich.config.json.',
      );
    }
    const source = resolveEnrichSource(config, rest);
    const sourceConfig = config.sources[source];
    const save = saveRequested(rest);
    const today = new Date().toISOString().slice(0, 10);

    // Prospects come from an API source (net-new discovery, e.g. Explorium +
    // pipe0 work-email) or a staged ingest list (Clay/CSV/webhook).
    const snapshot = await readSnapshot(rest, undefined, { persistProgress: true });
    const icp = loadIcp(rest);
    if (sourceConfig.kind === "api" && !icp) {
      console.error(
        "⚠ No ICP loaded — discovery will use the raw discovery.filters and skip fit scoring. " +
          "Develop one with `fullstackgtm icp interview` (or pass --icp <path>) so leads map to your ICP.",
      );
    }
    // Recommend the strong dedup key when the CRM carries no LinkedIn URLs:
    // without them, pre-email dedup falls back to the weaker name+domain match.
    if (sourceConfig.kind === "api" && !(snapshot.contacts ?? []).some((c) => c.linkedin)) {
      console.error(
        "⚠ No LinkedIn URLs found on your contacts — pre-email dedup falls back to name+domain (weaker). " +
          "Populate the HubSpot \"LinkedIn URL\" (hs_linkedin_url) property for exact dedup; " +
          "acquire writes it on every new contact it creates, so coverage grows automatically.",
      );
    }
    const seen = loadSeen();
    const now = new Date();
    const costPerRecord = config.acquire.costPerRecord?.[source] ?? 0;
    const headroom = remaining(loadMeter(now), config.acquire.budget, costPerRecord, now);
    const explicitMax = numericOption(rest, "--max");
    const desiredCreates = explicitMax ?? config.acquire.discovery?.[source]?.size ?? 25;
    const cap = headroom.maxRecords === null ? desiredCreates : Math.min(headroom.maxRecords, desiredCreates);
    let records: EnrichSourceRecord[];
    let apiSkippedCrm = 0;
    let apiSkippedSeen = 0;
    let apiProcessedKeys: string[] = [];
    let acquireTelemetry: NonNullable<EnrichRun["acquireTelemetry"]> | undefined;
    let acquireCheckpointSync: { key: AcquireCheckpointKey; hostedVersion: number | null } | undefined;
    const renderer = createProgressRenderer(ACQUIRE_STAGES);
    const acquireProgress = createProgressEmitter(
      composeListeners(renderer.listener, progressReporter()),
    );
    if (sourceConfig.kind === "api") {
      const priorRun = await store.latest({ source, mode: "acquire" });
      acquireProgress.stage(ACQUIRE_STAGES[0], 0, ACQUIRE_STAGES.length);
      acquireProgress.note("loading saved audience position");
      let api: Awaited<ReturnType<typeof acquireFromApi>>;
      try {
        api = await acquireFromApi(config, source, rest, icp, snapshot, seen, priorRun, cap, save, acquireProgress);
      } catch (error) {
        renderer.done({ persist: true });
        throw error;
      }
      records = api.records;
      apiSkippedCrm = api.skippedCrm;
      apiSkippedSeen = api.skippedSeen;
      apiProcessedKeys = api.processedKeys;
      acquireTelemetry = api.telemetry;
      acquireCheckpointSync = { key: api.checkpointKey, hostedVersion: api.hostedVersion };
    } else {
      const stagedLabel = option(rest, "--staged-run");
      const stagedRun = stagedLabel
        ? await store.get(stagedLabel)
        : await store.latest({ source, mode: "ingest" });
      if (!stagedRun || stagedRun.mode !== "ingest") {
        throw new Error(
          `No staged data for source "${source}". Stage prospects first: fullstackgtm enrich ingest <prospects.csv|payload.json> --source ${source}`,
        );
      }
      records = stagedSourceRecords(config, source, stagedRun);
    }

    // Meter: how many MORE leads may we create right now? --max is an
    // additional per-run ceiling, never a way to exceed the budget.
    if (apiSkippedCrm || apiSkippedSeen) {
      console.error(
        `Pre-enrichment dedup: skipped ${apiSkippedCrm} already-in-CRM + ${apiSkippedSeen} previously seen ` +
          `(≈$${((apiSkippedCrm + apiSkippedSeen) * costPerRecord).toFixed(2)} downstream spend avoided).`,
      );
    }
    // `cap` is the desired create count bounded by the persistent meter. Raw
    // discovery scanning has its own --scan-limit and may cross many duplicate-
    // heavy pages to fill this target.

    // Assignment: never create an ownerless lead. An explicit `acquire.assign`
    // policy wins; a `--assign-owner <id>` flag is a quick fixed override;
    // otherwise, when the portal has exactly one active owner, default every
    // lead to them. With multiple owners and no policy we refuse to guess —
    // leads are left unassigned and the operator is told to configure a rule.
    const assignOwnerFlag = option(rest, "--assign-owner");
    if (!config.acquire.assign) {
      if (assignOwnerFlag) {
        config.acquire.assign = { strategy: "fixed", ownerId: assignOwnerFlag };
      } else {
        const activeOwners = (snapshot.users ?? []).filter((u) => u.active !== false);
        if (activeOwners.length === 1) {
          const sole = activeOwners[0].crmId ?? activeOwners[0].id;
          config.acquire.assign = { strategy: "fixed", ownerId: sole };
          console.error(
            `Assignment: no policy set — defaulting every lead to the portal's sole owner ` +
              `${activeOwners[0].name} (${sole}). Configure "acquire.assign" to route across reps.`,
          );
        } else if (activeOwners.length > 1) {
          console.error(
            `⚠ Assignment: ${activeOwners.length} active owners and no "acquire.assign" policy — ` +
              `leads will be created OWNERLESS. Add an acquire.assign rule (fixed / round-robin / territory) ` +
              `or pass --assign-owner <id> so every lead lands with an owner.`,
          );
        }
      }
    }

    // Progress: candidate rows tick on an interactive stderr board (inert when
    // piped) and, via the composed reporter, heartbeat to a paired hosted app.
    // The meter reading (creates vs headroom + budget burn) rides the same
    // emitter, feeding the dashboard's gauge without printing anything new.
    let result: ReturnType<typeof buildAcquirePlan>;
    try {
      acquireProgress.stage(ACQUIRE_STAGES[2], 2, ACQUIRE_STAGES.length);
      acquireProgress.note("building governed create plan");
      if (config.acquire.budget?.records?.perDay && headroom.records.day !== null) {
        acquireProgress.meter(
          config.acquire.budget.records.perDay - headroom.records.day,
          config.acquire.budget.records.perDay,
          "records/day",
        );
      }
      result = buildAcquirePlan({
        config,
        source,
        snapshot,
        records,
        runLabel: option(rest, "--run-label") ?? `acquire-${source}-${today}`,
        maxRecords: cap,
        progress: acquireProgress,
      });
    } finally {
      renderer.done({ persist: true });
    }

    if (result.counts.unassigned > 0 && result.counts.created > 0) {
      console.error(
        `⚠ ${result.counts.unassigned}/${result.counts.created} proposed lead(s) have no owner ` +
          `(policy could not place them). They will be created ownerless.`,
      );
    }

    // Observability: headline metrics for the web run timeline (paired users).
    reportCounts({
      sourced: result.counts.fetched,
      created: result.counts.created,
      withheldByMeter: result.counts.withheldByMeter,
      skippedInCrm: apiSkippedCrm,
      skippedSeen: apiSkippedSeen,
      estCostUsd: result.estCostUsd,
    });

    const meterLine = formatAcquireMeter(headroom, costPerRecord);
    const gaugeLine = acquireGaugeLine(headroom, config.acquire.budget ?? {}, paint(colorEnabled(process.stdout)));
    if (!save) {
      printAcquireOutput({
        args: rest,
        result,
        meter: headroom,
        meterLine,
        gaugeLine,
        saved: false,
        planSaved: false,
        hostedPlanUrl: null,
      });
      return;
    }

    const run = await openEnrichRun(store, source, "acquire", option(rest, "--run-label"), today);
    const planIds: string[] = [];
    let hostedPlanUrl: string | null = null;
    if (result.plan.operations.length > 0) {
      const storedPlan = await createFilePlanStore().save(result.plan);
      planIds.push(result.plan.id);
      reportEvent("plan_saved", result.plan.id);
      const mirror = await uploadHostedPatchPlan(storedPlan);
      if (mirror.status === "saved") {
        hostedPlanUrl = mirror.state.url;
        reportEvent("plan_mirrored", mirror.state.patchPlanId);
      } else if (mirror.status === "unavailable" || mirror.status === "conflict") {
        console.error(`Hosted plan sync pending: ${mirror.reason}. The local signed plan remains authoritative.`);
      }
    }
    if (acquireTelemetry) {
      acquireTelemetry.funnel.proposed = result.counts.created;
      acquireTelemetry.funnel.withheldByMeter = result.counts.withheldByMeter;
    }
    await store.update({
      ...run,
      completedAt: new Date().toISOString(),
      cursor: acquireTelemetry?.discovery.cursor ?? null,
      counts: acquireTelemetry
        ? {
            fetched: acquireTelemetry.funnel.discovered,
            matched: acquireTelemetry.funnel.skippedCrm + acquireTelemetry.funnel.skippedSeen,
            unmatched: acquireTelemetry.funnel.resolved,
            ambiguous: result.counts.ambiguous,
            opsEmitted: acquireTelemetry.funnel.proposed,
          }
        : run.counts,
      acquireTelemetry,
      planIds: [...(run.planIds ?? []), ...planIds],
    });
    // Remember everyone we email-resolved this run so the next run skips them
    // pre-email (cross-run credit saver). Committed (--save) runs only.
    if (apiProcessedKeys.length > 0) recordSeen(apiProcessedKeys, now);
    if (acquireTelemetry && acquireCheckpointSync) {
      await persistAcquireCheckpoint(
        acquireCheckpointSync.key,
        acquireTelemetry.discovery,
        acquireCheckpointSync.hostedVersion,
      );
    }
    printAcquireOutput({
      args: rest,
      result,
      meter: headroom,
      meterLine,
      gaugeLine,
      saved: true,
      planSaved: planIds.length > 0,
      hostedPlanUrl,
    });
    return;
  }

  const mode: "append" | "refresh" = subcommand === "refresh" ? "refresh" : "append";
  const source = resolveEnrichSource(config, rest);
  const sourceConfig = config.sources[source];
  const save = saveRequested(rest);
  const today = new Date().toISOString().slice(0, 10);

  // Refresh work set comes from the staleness ledger, before any fetch.
  const allRuns = await store.list();
  let workSet: ReturnType<typeof selectStaleWork> = [];
  if (mode === "refresh") {
    const staleDaysOverride = numericOption(rest, "--stale-days");
    workSet = selectStaleWork(config, allRuns, source, { staleDaysOverride });
    if (workSet.length === 0) {
      const stamped = latestStamps(allRuns, source).size;
      console.log(
        stamped === 0
          ? `Nothing to refresh: no ${source} enrichment stamps yet. Run \`enrich append --source ${source} --save\` first.`
          : `Nothing to refresh: all ${stamped} stamped field(s) from ${source} are within their staleness window.`,
      );
      return;
    }
  }

  const snapshot = await readSnapshot(rest);

  // Assemble source records: api pull (checkpointed when --save) or staged ingest data.
  let run: EnrichRun | null = null;
  let records: EnrichSourceRecord[];
  let missCount = 0;
  if (sourceConfig.kind === "api") {
    const objectTypes = parseEnrichObjects(rest, config, source);
    const fieldsFor = (objectType: EnrichObjectType) =>
      (config.fields[objectType] ?? []).filter((field) => field.from[source] !== undefined);
    const pullKeys: ApolloPullKey[] =
      mode === "append"
        ? apolloPullKeysForAppend(snapshot, objectTypes, (objectType, record) =>
            fieldsFor(objectType).some((field) => {
              const value = record[resolveCrmField(objectType, field.crm)];
              return value === undefined || value === null || String(value).trim() === "";
            }),
          )
        : apolloPullKeysForRefresh(snapshot, workSet);
    if (pullKeys.length === 0) {
      console.log(
        mode === "append"
          ? "Nothing to enrich: no records with a blank mapped field and a pull key (companies need a domain, contacts an email)."
          : "Nothing to refresh: no stale records carry a pull key (companies need a domain, contacts an email).",
      );
      return;
    }
    const client = createApolloClient({
      getApiKey: () => apolloApiKey(),
      apiBaseUrl: process.env.APOLLO_API_BASE_URL,
    });
    if (save) {
      run = await openEnrichRun(store, source, mode, option(rest, "--run-label"), today);
      if (run.cursor) {
        console.error(
          `Resuming interrupted run ${run.runLabel} from cursor ${run.cursor} (${run.pulled?.length ?? 0} record(s) already pulled).`,
        );
      }
    }
    // Interactive terminals get a stderr progress bar over the pull (rate +
    // ETA); the checkpointing callback below is unchanged. Inert otherwise.
    const pullBar = createStatusLine();
    const pullStarted = Date.now();
    let pullProcessed = 0;
    let result: Awaited<ReturnType<typeof pullApolloRecords>>;
    try {
      result = await pullApolloRecords(client, pullKeys, {
        resumeAfter: run?.cursor ?? null,
        onProgress: async (progress) => {
          if (pullBar.active) {
            pullProcessed += 1;
            const elapsed = Date.now() - pullStarted;
            const rate = pullProcessed / Math.max(1, elapsed / 1000);
            const left = Math.max(0, pullKeys.length - pullProcessed);
            pullBar.set(
              `Enriching via ${source}… ${formatBar(pullProcessed / pullKeys.length, 12)} ${pullProcessed}/${pullKeys.length} · ${rate.toFixed(1)}/s · ETA ${formatDuration((left / Math.max(rate, 0.01)) * 1000)}`,
            );
          }
          if (!run) return;
          run.cursor = progress.lastKeyValue;
          if (progress.record) run.pulled = [...(run.pulled ?? []), progress.record];
          if (progress.miss) run.missedKeys = [...(run.missedKeys ?? []), progress.miss.value];
          await store.update(run);
        },
      });
    } finally {
      pullBar.done();
    }
    records = run ? [...(run.pulled ?? [])] : result.records;
    missCount = run ? (run.missedKeys?.length ?? 0) : result.misses.length;
  } else {
    const stagedLabel = option(rest, "--staged-run");
    const stagedRun = stagedLabel
      ? await store.get(stagedLabel)
      : await store.latest({ source, mode: "ingest" });
    if (!stagedRun || stagedRun.mode !== "ingest") {
      throw new Error(
        `No staged data for source "${source}". Stage it first: fullstackgtm enrich ingest <file.csv|payload.json> --source ${source}`,
      );
    }
    records = stagedSourceRecords(config, source, stagedRun);
    if (save) run = await openEnrichRun(store, source, mode, option(rest, "--run-label"), today);
  }

  const result = buildEnrichPlan({
    config,
    source,
    mode,
    snapshot,
    records,
    workSet: mode === "refresh" ? workSet : undefined,
    runLabel: run?.runLabel ?? `${mode}-${source}-${today}`,
  });
  // Pull keys the source had no data for count as fetched-but-unmatched.
  result.counts.fetched += missCount;
  result.counts.unmatched += missCount;

  reportCounts({
    fetched: result.counts.fetched,
    matched: result.counts.matched,
    unmatched: result.counts.unmatched,
    opsEmitted: result.counts.opsEmitted,
  });

  if (!save) {
    if (rest.includes("--json")) {
      console.log(JSON.stringify(result.plan, null, 2));
    } else {
      console.log(verbosePlanRequested(rest) ? patchPlanToMarkdown(result.plan) : compactPlan(result.plan));
      console.log(formatEnrichCounts(result.counts, result.ambiguities.length));
      console.log("\nDry run — nothing written. Re-run with --save to persist the plan and the run record.");
    }
    return;
  }

  // --save: persist the plan (when it proposes anything) and finalize the run.
  const planIds: string[] = [];
  if (result.plan.operations.length > 0) {
    await createFilePlanStore().save(result.plan);
    planIds.push(result.plan.id);
  }
  const finalized: EnrichRun = {
    ...(run as EnrichRun),
    completedAt: new Date().toISOString(),
    cursor: null,
    counts: result.counts,
    planIds: [...((run as EnrichRun).planIds ?? []), ...planIds],
    stamps: [...((run as EnrichRun).stamps ?? []), ...result.stamps],
    ambiguities: result.ambiguities,
  };
  await store.update(finalized);
  console.log(formatEnrichCounts(result.counts, result.ambiguities.length));
  if (planIds.length > 0) {
    console.log(
      `Saved plan ${result.plan.id} (run ${finalized.runLabel}). Review with \`fullstackgtm plans show ${result.plan.id}\`, ` +
        `approve with \`fullstackgtm plans approve ${result.plan.id} --operations <ids|all>\`, then ` +
        `\`fullstackgtm apply --plan-id ${result.plan.id} --provider <name>\`.`,
    );
  } else {
    console.log(`Run ${finalized.runLabel} recorded; no operations to propose.`);
  }
}

function formatEnrichCounts(counts: EnrichCounts, ambiguities: number) {
  return (
    `Source records: ${counts.fetched} fetched · ${counts.matched} matched · ` +
    `${counts.unmatched} unmatched · ${counts.ambiguous} ambiguous (${ambiguities} collision(s) recorded) · ` +
    `${counts.opsEmitted} operation(s) proposed`
  );
}

/**
 * Pull net-new prospects from an API acquire source into source records the
 * acquire builder dedupes + turns into create_record ops. Explorium discovers;
 * A field-level provider waterfall fills missing contact data. Existing
 * email-keyed and resolveEmailsWith=pipe0 configs translate to an implicit
 * Pipe0 work-email step. Only rows that carry the configured dedupe key survive.
 */
async function acquireFromApi(
  config: EnrichConfig,
  source: string,
  rest: string[],
  icp: Icp | undefined,
  snapshot: CanonicalGtmSnapshot,
  seen: Set<string>,
  priorRun: EnrichRun | null,
  targetFresh: number,
  persistCheckpoint: boolean,
  progress: ReturnType<typeof createProgressEmitter>,
): Promise<{
  records: EnrichSourceRecord[];
  skippedCrm: number;
  skippedSeen: number;
  processedKeys: string[];
  telemetry: NonNullable<EnrichRun["acquireTelemetry"]>;
  checkpointKey: AcquireCheckpointKey;
  hostedVersion: number | null;
}> {
  const acquire = config.acquire!;
  const disc = acquire.discovery?.[source];
  if (!disc) {
    throw new Error(`enrich acquire: api source "${source}" needs an "acquire.discovery.${source}" config (provider + size).`);
  }
  const matchKey = acquire.create.contact?.matchKey ?? "email";
  const explicitScanLimit = numericOption(rest, "--scan-limit");
  const scanLimit = Math.max(targetFresh, Math.min(explicitScanLimit ?? disc.scanLimit ?? Math.max(100, targetFresh * 10), 5_000));
  const listId = disc.listId ?? option(rest, "--list") ?? undefined;
  if ((disc.provider === "linkedin" || disc.provider === "heyreach") && !listId) {
    throw new Error(
      "enrich acquire --source linkedin needs a HeyReach lead-list id: pass --list <id> or set acquire.discovery.linkedin.listId.",
    );
  }
  let filters = disc.provider === "explorium"
    ? (icp ? icpToExploriumFilters(icp) : (disc.filters ?? {}))
    : disc.provider === "pipe0"
      ? (icp ? icpToCrustdataFilters(icp) : (disc.filters ?? {}))
      : disc.provider === "clay"
        ? (icp ? icpToClayPeopleFilters(icp) : (disc.filters ?? {}))
        : {};
  const targetCompanyDomain = option(rest, "--company-domain")?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (targetCompanyDomain) {
    if (disc.provider !== "clay") throw new Error("enrich acquire: --company-domain currently requires --source clay");
    filters = { ...filters, company_identifier: [targetCompanyDomain] };
  }
  const queryFingerprint = createHash("sha256")
    .update(JSON.stringify({ source, provider: disc.provider, listId, filters, icp: icp ?? null, targetCompanyDomain: targetCompanyDomain ?? null }))
    .digest("hex");
  const checkpointKey: AcquireCheckpointKey = {
    provider: disc.provider,
    source,
    listId: listId ?? null,
    queryFingerprint,
  };
  const checkpointStore = createFileAcquireCheckpointStore();
  const localCheckpoint = await checkpointStore.get(checkpointKey);
  const hostedRead = await readHostedAcquireCheckpoint(acquireCheckpointId(checkpointKey));
  const hostedRecord = hostedRead.status === "found" ? hostedRead.record : null;
  const hostedVersion = hostedRecord?.version ?? null;
  // Once paired, hosted state lets another authenticated worker resume this
  // audience. A newer offline local checkpoint is still preserved and pushed
  // with CAS; otherwise hosted wins. Legacy run telemetry is a one-time
  // migration source only when neither dedicated store has this exact key.
  let persisted = localCheckpoint?.continuation;
  if (
    hostedRecord &&
    (!localCheckpoint || hostedRecord.updatedAt >= Date.parse(localCheckpoint.updatedAt))
  ) {
    persisted = hostedRecord.checkpoint;
    if (persistCheckpoint) {
      await checkpointStore.put(
        checkpointKey,
        {
          cursor: hostedRecord.checkpoint.cursor,
          offset: hostedRecord.checkpoint.offset,
          exhausted: hostedRecord.checkpoint.exhausted,
        },
        new Date(hostedRecord.updatedAt),
      );
    }
  }
  const prior = priorRun?.acquireTelemetry?.discovery;
  const resume = persisted ?? (
    prior?.queryFingerprint === queryFingerprint
      ? { cursor: prior.cursor, offset: prior.offset, exhausted: prior.exhausted }
      : undefined
  );
  let cursor = resume?.cursor ?? null;
  let offset = resume?.offset ?? 0;
  let exhausted = resume?.exhausted ?? false;
  let discovered = 0;
  let qualified = 0;
  let skippedCrm = 0;
  let skippedSeen = 0;
  const prospects: Prospect[] = [];
  const crmKeys = crmContactKeys(snapshot);
  const runSeen = new Set(seen);
  const clayRoutes = disc.provider === "clay" && icp ? clayPeopleFilterRoutes(icp) : [];
  let clayRouteIndex = 0;
  const allowClayFallback = !resume;

  // Pull successive pages until we have enough fresh candidates or hit the
  // bounded scan ceiling. Page size follows the remaining target, so advancing
  // a cursor never silently discards unused candidates from the final page.
  while (prospects.length < targetFresh && discovered < scanLimit && !exhausted) {
    // Cursor/offset providers can shrink the final request exactly. Explorium
    // uses page numbers, so keep page_size stable or page boundaries would
    // overlap/skip as the number of fresh candidates changes.
    const requestSize = Math.max(1, Math.min(
      100,
      disc.provider === "explorium" ? targetFresh : targetFresh - prospects.length,
      scanLimit - discovered,
    ));
    let page: Prospect[];
    let exploriumPage: number | null = null;
    if (disc.provider === "pipe0") {
      const result = await fetchPipe0CrustdataProspectPage({
        apiKey: providerKey("pipe0"), filters, limit: requestSize, cursor: cursor ?? undefined,
      });
      page = result.prospects;
      cursor = result.nextCursor;
      exhausted = result.nextCursor === null;
    } else if (disc.provider === "clay") {
      if (icp?.motion === "investment") {
        const companyFilters = icpToClayInvestmentCompanyFilters(icp);
        progress.note("searching Clay companies against the investment thesis");
        const result = await discoverClayInvestmentProspects({
          apiKey: providerKey("clay"), companyFilters,
          titleKeywords: icp.persona.titleKeywords ?? ["Founder", "Co-founder", "CEO", "CTO"],
          companyLimit: Math.min(scanLimit - discovered, 25), prospectLimit: requestSize,
        });
        page = result.prospects;
        progress.note(`${result.companiesScanned} target account(s) scanned · resolving founders`);
        exhausted = true;
        cursor = "investment-account-first";
      } else {
      while (true) {
        if (!cursor) {
          const route = clayRoutes[clayRouteIndex];
          if (route) filters = { ...route.filters, ...(targetCompanyDomain ? { company_identifier: [targetCompanyDomain] } : {}) };
          progress.note(`creating Clay people-search iterator · ${route?.id ?? "configured"}`);
          cursor = await createClaySearch({ apiKey: providerKey("clay"), sourceType: "people", filters });
        }
        const result = await runClayPeopleSearchPage({ apiKey: providerKey("clay"), searchId: cursor, limit: requestSize });
        page = result.prospects;
        offset += page.length;
        exhausted = !result.hasMore;
        if (page.length > 0 || !allowClayFallback || clayRouteIndex >= clayRoutes.length - 1) break;
        const failed = clayRoutes[clayRouteIndex]?.id ?? "configured";
        clayRouteIndex += 1;
        const next = clayRoutes[clayRouteIndex];
        progress.note(`Clay ${failed} route returned 0 · trying ${next.id}`);
        cursor = null;
        offset = 0;
        exhausted = false;
      }
      }
    } else if (disc.provider === "explorium") {
      const pageNumber = offset + 1;
      exploriumPage = pageNumber;
      page = await fetchExploriumProspects({
        apiKey: providerKey("explorium"),
        filters: filters as Record<string, { values?: string[]; value?: boolean }>,
        size: requestSize,
        page: pageNumber,
      });
      exhausted = page.length < requestSize;
    } else if (disc.provider === "linkedin" || disc.provider === "heyreach") {
      const provider = createLinkedInProvider(disc.provider, providerKey("heyreach"));
      page = await discoverLinkedInProspects(provider, {
        sourceId: listId, max: requestSize, cursor: String(offset),
      });
      offset += page.length;
      exhausted = page.length < requestSize;
    } else {
      throw new Error(`enrich acquire: unknown discovery provider "${disc.provider}" (clay | explorium | pipe0 | linkedin).`);
    }
    discovered += page.length;
    progress.items(discovered, scanLimit);
    if (targetCompanyDomain) page = page.filter((prospect) => normalizedCompanyDomain(prospect.companyDomain) === targetCompanyDomain);
    if (page.length === 0) {
      exhausted = true;
      break;
    }
    let fitted = page;
    if (icp) {
      const threshold = fitThreshold(icp);
      fitted = page
        .map((p) => ({ ...p, fitScore: scoreProspectAgainstIcp(p, icp).score }))
        .filter((p) => (p.fitScore ?? 0) >= threshold);
    }
    qualified += fitted.length;
    const partition = partitionFreshProspects(fitted, crmKeys, runSeen);
    skippedCrm += partition.skippedCrm;
    skippedSeen += partition.skippedSeen;
    const remainingTarget = targetFresh - prospects.length;
    for (const prospect of partition.fresh) {
      if (prospects.length >= targetFresh) break;
      prospects.push(prospect);
      for (const key of prospectIdentityKeys(prospect)) runSeen.add(key);
    }
    progress.note(
      `${discovered} scanned · ${qualified} qualified · ${prospects.length}/${targetFresh} fresh`,
    );
    if (
      disc.provider === "clay" && allowClayFallback && exhausted &&
      prospects.length < targetFresh && clayRouteIndex < clayRoutes.length - 1 && discovered < scanLimit
    ) {
      const failed = clayRoutes[clayRouteIndex]?.id ?? "configured";
      clayRouteIndex += 1;
      progress.note(`Clay ${failed} route did not fill the target · trying ${clayRoutes[clayRouteIndex].id}`);
      cursor = null;
      offset = 0;
      exhausted = false;
    }
    // Explorium is page-number based. Only advance after consuming every fresh
    // candidate on that page; otherwise the next run safely re-reads the page
    // and CRM/seen dedupe exposes the remainder instead of losing it.
    if (exploriumPage !== null && partition.fresh.length <= remainingTarget) offset = exploriumPage;
  }

  if (disc.provider === "clay" && clayRouteIndex > 0 && discovered > 0) {
    console.error(`Clay discovery relaxed to ${clayRoutes[clayRouteIndex].id} after narrower routes returned 0; all candidates still passed through local ICP fit scoring.`);
  }

  if (discovered === 0 && !resume) {
    console.error(
      `enrich acquire: ${disc.provider} discovered 0 prospects for this ICP — the plan will be empty. ` +
        "This is usually an over-narrow filter, not an empty market: check the ICP's industry and seniority " +
        "(provider vocab is finicky), widen one constraint, or run `fullstackgtm icp show` to inspect the " +
        "generated discovery filters. (Distinct from dedup: nothing was returned to filter.)",
    );
  }
  if (icp && discovered > 0 && qualified === 0) {
      console.error(
        `enrich acquire: all ${discovered} discovered prospect(s) scored below the ICP fit threshold ` +
          `(${fitThreshold(icp)}) — none qualified. Loosen the ICP persona or lower scoring.threshold.`,
      );
  }

  progress.stage(ACQUIRE_STAGES[1], 1, ACQUIRE_STAGES.length);
  progress.note("checking work-email requirements");

  // 3. Resolve contact fields through the ordered, fill-only waterfall. Keep
  // legacy behavior: email-keyed acquisition and resolveEmailsWith=pipe0 imply
  // a Pipe0 work-email step when no explicit waterfall is configured.
  const implicitPipe0 = matchKey === "email" || disc.resolveEmailsWith === "pipe0";
  const contactWaterfall: ContactWaterfallStep[] = disc.contactWaterfall ?? (
    implicitPipe0 ? [{ provider: "pipe0", fields: ["work_email"] }] : []
  );
  if (contactWaterfall.length > 0) {
    const adapters: Record<string, ContactProviderAdapter> = {
      pipe0: {
        provider: "pipe0",
        resolve: async (candidates, fields) => {
          let resolved = candidates;
          if (fields.includes("work_email") && resolved.some((p) => !p.companyDomain && p.companyName)) {
            progress.note(`resolving company domains for ${resolved.length} candidate(s)`);
            resolved = await pipe0ResolveCompanyDomains({ apiKey: providerKey("pipe0"), prospects: resolved });
          }
          if (fields.includes("work_email")) {
            progress.note(`resolving work emails with pipe0 for ${resolved.length} candidate(s)`);
            resolved = await pipe0ResolveWorkEmails({ apiKey: providerKey("pipe0"), prospects: resolved });
          }
          const profileFields = fields
            .filter((field): field is "work_email" | "mobile" => field === "work_email" || field === "mobile")
            .filter((field) => resolved.some((prospect) => prospect.linkedin && (field === "mobile" ? !prospect.mobile : !prospect.email)));
          if (profileFields.length) {
            progress.note(`resolving LinkedIn contact details with pipe0 for ${resolved.length} candidate(s)`);
            resolved = await pipe0ResolveProfileContacts({ apiKey: providerKey("pipe0"), prospects: resolved, fields: profileFields });
          }
          return resolved;
        },
      },
    };
    const result = await runContactWaterfall({ prospects, steps: contactWaterfall, adapters });
    prospects.splice(0, prospects.length, ...result.prospects);
    for (const attempt of result.attempts) {
      const added = Object.entries(attempt.added).map(([field, count]) => `${count} ${field}`).join(", ") || "0 fields";
      progress.note(`${attempt.provider}: ${attempt.attempted} attempted · ${added} added`);
    }
  }
  progress.items(prospects.length, prospects.length);
  progress.note(`${prospects.length} candidate(s) ready for planning`);

  const processedKeys = prospects.flatMap(prospectIdentityKeys);
  const records = prospects
    .map((p) => {
      const keyValue = (p as unknown as Record<string, unknown>)[matchKey] as string | undefined;
      return {
        id: p.sourceId ?? `${source}:${keyValue ?? p.fullName ?? ""}`,
        objectType: "contact" as const,
        keys: { [matchKey]: keyValue },
        payload: p as unknown as Record<string, unknown>,
      };
    })
    .filter((record) => Boolean(record.keys[matchKey]));
  const discovery = { queryFingerprint, cursor, offset, exhausted };
  return {
    records,
    skippedCrm,
    skippedSeen,
    processedKeys,
    telemetry: {
      funnel: {
        discovered,
        qualified,
        skippedCrm,
        skippedSeen,
        resolved: records.length,
        proposed: 0,
        withheldByMeter: 0,
      },
      discovery,
    },
    checkpointKey,
    hostedVersion,
  };
}

/** Commit continuation only after the saved plan/run is durable. */
async function persistAcquireCheckpoint(
  key: AcquireCheckpointKey,
  discovery: NonNullable<EnrichRun["acquireTelemetry"]>["discovery"],
  hostedVersion: number | null,
): Promise<void> {
  const store = createFileAcquireCheckpointStore();
  await store.put(key, {
    cursor: discovery.cursor,
    offset: discovery.offset,
    exhausted: discovery.exhausted,
  });
  const hostedWrite = await writeHostedAcquireCheckpoint(
    acquireCheckpointId(key),
    discovery,
    hostedVersion,
  );
  if (hostedWrite.status === "conflict" && hostedWrite.current) {
    const current = hostedWrite.current.checkpoint;
    await store.put(
      key,
      { cursor: current.cursor, offset: current.offset, exhausted: current.exhausted },
      new Date(hostedWrite.current.updatedAt),
    );
    console.error(
      "Acquisition checkpoint advanced concurrently in the hosted workspace; " +
        "the newer hosted continuation was kept locally for the next run.",
    );
  } else if (hostedWrite.status === "unavailable") {
    console.error(`Hosted checkpoint sync unavailable; local continuation retained (${hostedWrite.reason}).`);
  }
}

/**
 * Rich-only fuel gauge under the acquire meter line: one bar per configured
 * budget window, colored by how much is burned (green → yellow ≥70% → red
 * ≥90%). Returns null in plain mode or with no caps configured, keeping
 * piped output byte-identical.
 */
function acquireGaugeLine(headroom: AcquireRemaining, budget: AcquireBudget, p: Paint): string | null {
  if (!p.enabled) return null;
  const parts: string[] = [];
  const segment = (
    label: string,
    left: number | null,
    cap: number | undefined,
    fmt: (value: number) => string,
  ) => {
    if (left === null || cap === undefined || cap <= 0) return;
    const used = Math.max(0, cap - left);
    const fraction = used / cap;
    const painter = fraction >= 0.9 ? p.red : fraction >= 0.7 ? p.yellow : p.green;
    parts.push(`${p.dim(label)} ${painter(formatBar(fraction, 10))} ${fmt(used)}/${fmt(cap)}`);
  };
  segment("applied/day", headroom.records.day, budget.records?.perDay, String);
  segment("applied/mo", headroom.records.month, budget.records?.perMonth, String);
  segment("spend/day", headroom.spendUsd.day, budget.spend?.perDay, (value) => `$${value.toFixed(2)}`);
  segment("spend/mo", headroom.spendUsd.month, budget.spend?.perMonth, (value) => `$${value.toFixed(2)}`);
  return parts.length > 0 ? parts.join("  ·  ") : null;
}

function formatAcquireMeter(headroom: AcquireRemaining, costPerRecord: number): string {
  const n = (v: number | null) => (v === null ? "∞" : String(v));
  const money = (v: number | null) => (v === null ? "∞" : `$${v.toFixed(2)}`);
  const max = headroom.maxRecords === null ? "unlimited" : `${headroom.maxRecords}`;
  return `Apply budget (not market size) — up to ${max} more create(s) may be applied now; ` +
    `${n(headroom.records.day)} left today, ${n(headroom.records.month)} this month · ` +
    `spend headroom ${money(headroom.spendUsd.day)}/day, ${money(headroom.spendUsd.month)}/month ` +
    `(≈$${costPerRecord.toFixed(2)}/lead). Dry runs do not consume this budget.`;
}

function renderAcquireLeadCards(result: ReturnType<typeof buildAcquirePlan>): string {
  const p = paint(colorEnabled(process.stdout));
  const evidence = new Map((result.plan.evidence ?? []).map((item) => [item.id, item]));
  return result.plan.operations.map((operation, index) => {
    const payload = operation.afterValue as CreateRecordPayload;
    const props = payload.properties ?? {};
    const name = [props.firstname, props.lastname].filter(Boolean).join(" ") || payload.matchValue;
    const title = props.jobtitle || "Title unavailable";
    const company = props.company || payload.associateCompanyName || "Company unavailable";
    let fit: number | undefined;
    const item = operation.evidenceIds?.[0] ? evidence.get(operation.evidenceIds[0]) : undefined;
    try { fit = Number((JSON.parse(item?.text ?? "{}") as { fitScore?: unknown }).fitScore); } catch { /* malformed evidence remains display-only */ }
    const fitPercent = Number.isFinite(fit) ? Math.round((fit ?? 0) * 100) : undefined;
    const lines = [
      p.bold(truncateToWidth(name, 84)),
      p.cyan(truncateToWidth(`${title} · ${company}`, 84)),
      p.blue(truncateToWidth([payload.associateCompanyDomain, props.hs_linkedin_url].filter(Boolean).join(" · "), 84)),
    ];
    const fitLabel = fitPercent === undefined ? "" : ` · ${scoreColor(fitPercent, p)}% fit`;
    return box(lines, p, `Lead ${index + 1}/${result.plan.operations.length}${fitLabel}`).join("\n");
  }).join("\n");
}

function printAcquireOutput(options: {
  args: readonly string[];
  result: ReturnType<typeof buildAcquirePlan>;
  meter: AcquireRemaining;
  meterLine: string;
  gaugeLine: string | null;
  /** The acquisition run/checkpoint was persisted. */
  saved: boolean;
  /** A non-empty plan was persisted to the plan store. */
  planSaved: boolean;
  hostedPlanUrl: string | null;
}): void {
  const { args, result, meter, meterLine, gaugeLine, saved, planSaved, hostedPlanUrl } = options;
  if (args.includes("--json")) {
    console.log(JSON.stringify({
      plan: result.plan,
      counts: result.counts,
      estCostUsd: result.estCostUsd,
      meter,
      persistence: {
        runSaved: saved,
        planSaved,
        planId: planSaved ? result.plan.id : null,
        hostedPlanUrl,
      },
    }, null, 2));
    return;
  }

  if (verbosePlanRequested(args)) {
    console.log(patchPlanToMarkdown(result.plan));
    console.log(`\nAcquisition`);
    console.log(`  Leads      ${result.counts.created} net-new · ${result.counts.unassigned} unassigned`);
    console.log(`  Est. cost  $${result.estCostUsd.toFixed(2)}`);
    console.log(`  Budget     ${gaugeLine ?? meterLine}`);
    if (hostedPlanUrl) console.log(`  Plan       ${hostedPlanUrl}`);
  } else if (planSaved || !saved) {
    if (result.plan.operations.length > 0) console.log(renderAcquireLeadCards(result));
    console.log(compactPlan(result.plan, { saved: planSaved }));
    console.log(meterLine);
  } else {
    console.log(meterLine);
    console.log("No net-new leads to create (everything sourced already matched, or was withheld by the meter).");
  }

  if (planSaved) {
    console.log(`\nApprove  fullstackgtm plans approve ${result.plan.id} --operations all`);
    console.log(`Apply    fullstackgtm apply --plan-id ${result.plan.id} --provider <hubspot|salesforce>`);
    const hostedRuns = hostedRunsUrl();
    if (hostedRuns) console.log(`Observe  ${hostedRuns}`);
    console.log("The meter is charged only when a create lands at apply.");
  }
}

function normalizedCompanyDomain(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

function hostedRunsUrl(): string | null {
  const baseUrl = getCredential("broker")?.baseUrl?.replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/dashboard/runs` : null;
}

function resolveEnrichSource(config: EnrichConfig, rest: string[]): string {
  const requested = option(rest, "--source");
  const declared = Object.keys(config.sources);
  if (requested) {
    if (!config.sources[requested]) {
      throw new Error(`Unknown enrich source "${requested}" (declared: ${declared.join(", ")})`);
    }
    return requested;
  }
  if (declared.length === 1) return declared[0];
  if (config.sources.apollo) return "apollo";
  throw new Error(`Multiple sources declared (${declared.join(", ")}) — pass --source <id>`);
}

function parseEnrichObjects(rest: string[], config: EnrichConfig, source: string): EnrichObjectType[] {
  const configured = (["company", "contact"] as EnrichObjectType[]).filter((objectType) =>
    (config.fields[objectType] ?? []).some((field) => field.from[source] !== undefined),
  );
  const flag = option(rest, "--objects");
  if (!flag) {
    if (configured.length === 0) {
      throw new Error(`No fields map from source "${source}" — add "from": { "${source}": ... } entries to the config.`);
    }
    return configured;
  }
  const requested = Array.from(new Set(flag.split(",").map((part) => parseSingleObjectType(part))));
  for (const objectType of requested) {
    if (!configured.includes(objectType)) {
      throw new Error(`--objects ${flag}: no ${objectType} fields map from source "${source}" in the config.`);
    }
  }
  return requested;
}

function apolloApiKey(): string {
  if (process.env.APOLLO_API_KEY) return process.env.APOLLO_API_KEY;
  const stored = getCredential("apollo");
  if (stored) return stored.accessToken;
  throw new Error(
    'No Apollo credentials. Run `echo "$APOLLO_API_KEY" | fullstackgtm login apollo` once, or set APOLLO_API_KEY.',
  );
}

/**
 * Open (or resume) a saved run. An interrupted run — same label, same source
 * and mode, never completed — is resumed from its cursor; a completed run
 * with the default label gets a -2/-3 suffix (runs are append-only).
 */
async function openEnrichRun(
  store: EnrichRunStore,
  source: string,
  mode: "append" | "refresh" | "acquire",
  requestedLabel: string | null,
  today: string,
): Promise<EnrichRun> {
  const baseLabel = requestedLabel ?? `${mode}-${source}-${today}`;
  let label = baseLabel;
  for (let suffix = 2; ; suffix += 1) {
    const existing = await store.get(label);
    if (!existing) break;
    if (existing.source === source && existing.mode === mode && existing.completedAt === null) {
      return existing; // resume the interrupted run
    }
    if (requestedLabel) {
      throw new Error(`Run "${requestedLabel}" already exists and is completed — enrich runs are append-only.`);
    }
    label = `${baseLabel}-${suffix}`;
  }
  return store.append({
    id: enrichRunId(source, label),
    runLabel: label,
    source,
    mode,
    startedAt: new Date().toISOString(),
    completedAt: null,
    cursor: null,
    counts: { fetched: 0, matched: 0, unmatched: 0, ambiguous: 0, opsEmitted: 0 },
    planIds: [],
    stamps: [],
  });
}

async function enrichIngest(store: EnrichRunStore, config: EnrichConfig, rest: string[], autoAppend = false) {
  const file = rest.find((arg) => !arg.startsWith("--") && !isOptionValue(rest, arg));
  if (!file) throw new Error("Usage: fullstackgtm enrich ingest <file.csv|payload.json|spool.jsonl|spool-dir> --source <id> [--run-label <label>]");
  const source = option(rest, "--source");
  if (!source) throw new Error("enrich ingest requires --source <id> (the ingest source the data belongs to)");
  const sourceConfig = config.sources[source];
  if (!sourceConfig) {
    throw new Error(`Unknown enrich source "${source}" (declared: ${Object.keys(config.sources).join(", ")})`);
  }
  if (sourceConfig.kind !== "ingest") {
    throw new Error(`Source "${source}" is kind "${sourceConfig.kind}" — only ingest sources accept staged data.`);
  }

  const filePath = resolve(process.cwd(), file);
  let rows: Array<Record<string, unknown>>;
  if (isSpoolPath(filePath)) {
    // Spool convention (docs/signal-spool-format.md): a *.jsonl file (one JSON
    // row per line) or a directory of *.jsonl / *.json spool files — so a
    // webhook landing zone can be staged directly. Additive: .csv / .json
    // files parse exactly as before.
    rows = readSpoolPath(filePath, "enrich ingest").map((entry) => entry.row);
  } else if ((file.toLowerCase().endsWith(".csv") || sourceConfig.format === "csv") && !file.toLowerCase().endsWith(".json")) {
    const raw = readFileSync(filePath, "utf8");
    rows = parseCsv(raw);
  } else {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) rows = parsed as Array<Record<string, unknown>>;
    else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown }).rows)) {
      rows = (parsed as { rows: Array<Record<string, unknown>> }).rows;
    } else if (parsed && typeof parsed === "object") {
      rows = [parsed as Record<string, unknown>];
    } else {
      throw new Error(`${file}: expected a JSON array, an object, or { "rows": [...] }`);
    }
  }
  if (rows.length === 0) throw new Error(`${file}: no rows to stage`);

  const objectsFlag = option(rest, "--objects");
  const objectType: EnrichObjectType = objectsFlag
    ? parseSingleObjectType(objectsFlag)
    : inferIngestObjectType(config, source, rows);

  const today = new Date().toISOString().slice(0, 10);
  const baseLabel = option(rest, "--run-label") ?? `ingest-${source}-${today}`;
  let label = baseLabel;
  for (let suffix = 2; await store.get(label); suffix += 1) {
    if (option(rest, "--run-label")) {
      throw new Error(`Run "${baseLabel}" already exists — enrich runs are append-only; pick a new --run-label.`);
    }
    label = `${baseLabel}-${suffix}`;
  }
  const now = new Date().toISOString();
  await store.append({
    id: enrichRunId(source, label),
    runLabel: label,
    source,
    mode: "ingest",
    startedAt: now,
    completedAt: now,
    cursor: null,
    counts: { fetched: rows.length, matched: 0, unmatched: 0, ambiguous: 0, opsEmitted: 0 },
    planIds: [],
    stamps: [],
    staged: rows,
    stagedObjectType: objectType,
  });
  console.log(
    autoAppend
      ? `Staged ${rows.length} ${objectType} row(s) from ${file} as run ${label}; matching against the CRM…`
      : `Staged ${rows.length} ${objectType} row(s) from ${file} as run ${label}. ` +
          `Next: fullstackgtm enrich append --source ${source} [source options] [--save]`,
  );
}

function parseSingleObjectType(value: string): EnrichObjectType {
  const normalized = value.trim().toLowerCase();
  if (normalized === "companies" || normalized === "company") return "company";
  if (normalized === "contacts" || normalized === "contact") return "contact";
  throw new Error(`--objects must be companies or contacts (got "${value}")`);
}

async function enrichStatus(store: EnrichRunStore, rest: string[], configFile: string) {
  const sourceFilter = option(rest, "--source");
  const allRuns = (await store.list()).filter((run) => !sourceFilter || run.source === sourceFilter);
  if (allRuns.length === 0) {
    console.log(
      sourceFilter
        ? `No enrich runs for source "${sourceFilter}".`
        : "No enrich runs yet. Start with `fullstackgtm enrich append --save` or stage data with `enrich ingest`.",
    );
    return;
  }

  // Staleness windows come from the config when one is readable; status must
  // not REQUIRE a config (the run store alone is enough to report on).
  let config: EnrichConfig | null = null;
  if (existsSync(configFile)) {
    try {
      config = loadEnrichConfig(configFile);
    } catch {
      config = null;
    }
  }

  const now = Date.now();
  const sources = Array.from(new Set(allRuns.map((run) => run.source)));
  const report = sources.map((source) => {
    const runs = allRuns.filter((run) => run.source === source);
    const last = runs[runs.length - 1];
    const interrupted = runs.filter((run) => run.completedAt === null);
    const stamps = Array.from(latestStamps(runs, source).values());
    const ages = stamps.map((stamp) => (now - Date.parse(stamp.enrichedAt)) / 86_400_000);
    const staleness = stamps.map((stamp, index) => {
      const windowDays = config
        ? staleDaysFor(config, stamp.objectType, stamp.field)
        : DEFAULT_STALE_DAYS;
      return ages[index] > windowDays;
    });
    return {
      source,
      runs: runs.length,
      lastRun: {
        runLabel: last.runLabel,
        mode: last.mode,
        startedAt: last.startedAt,
        completedAt: last.completedAt,
        counts: last.counts,
        acquireTelemetry: last.acquireTelemetry,
        planIds: last.planIds,
      },
      interrupted: interrupted.map((run) => ({ runLabel: run.runLabel, cursor: run.cursor })),
      stamps: {
        total: stamps.length,
        stale: staleness.filter(Boolean).length,
        oldestDays: ages.length ? Math.round(Math.max(...ages)) : null,
        newestDays: ages.length ? Math.round(Math.min(...ages)) : null,
        windowSource: config ? "enrich.config.json" : `default ${DEFAULT_STALE_DAYS}d`,
      },
    };
  });

  if (rest.includes("--json")) {
    console.log(JSON.stringify({ sources: report, runs: rest.includes("--runs") ? allRuns : undefined }, null, 2));
    return;
  }

  for (const entry of report) {
    const last = entry.lastRun;
    console.log(`${entry.source} — ${entry.runs} run(s)`);
    console.log(
      `  last: ${last.runLabel} (${last.mode}) ${last.completedAt ? `completed ${last.completedAt}` : "INTERRUPTED"}` +
        ` · ${last.counts.fetched} fetched, ${last.counts.matched} matched, ${last.counts.unmatched} unmatched,` +
        ` ${last.counts.ambiguous} ambiguous, ${last.counts.opsEmitted} ops` +
        (last.planIds.length ? ` · plans: ${last.planIds.join(", ")}` : ""),
    );
    if (last.acquireTelemetry) {
      const f = last.acquireTelemetry.funnel;
      const d = last.acquireTelemetry.discovery;
      console.log(
        `  funnel: ${f.discovered} discovered → ${f.qualified} qualified → ` +
          `${f.resolved} resolved → ${f.proposed} proposed` +
          ` · skipped ${f.skippedCrm} CRM + ${f.skippedSeen} seen` +
          (f.withheldByMeter ? ` · ${f.withheldByMeter} meter-withheld` : ""),
      );
      console.log(
        `  audience: ${d.exhausted ? "exhausted" : "continuing"}` +
          `${d.cursor ? " · cursor saved" : d.offset ? ` · offset ${d.offset}` : ""}`,
      );
    }
    for (const run of entry.interrupted) {
      console.log(`  interrupted: ${run.runLabel} at cursor ${run.cursor ?? "(start)"} — re-run with --save to resume`);
    }
    console.log(
      `  stamps: ${entry.stamps.total} field(s) enriched · ${entry.stamps.stale} stale (window: ${entry.stamps.windowSource})` +
        (entry.stamps.total ? ` · age ${entry.stamps.newestDays}–${entry.stamps.oldestDays}d` : ""),
    );
  }
  if (rest.includes("--runs")) {
    console.log("");
    for (const run of allRuns) {
      console.log(
        `${run.runLabel}  ${run.source.padEnd(8)} ${run.mode.padEnd(8)} ${run.completedAt ? "done" : "interrupted"}` +
          `  ${run.counts.opsEmitted} ops  ${run.stamps.length} stamps${run.staged ? `  ${run.staged.length} staged` : ""}`,
      );
    }
  }
}
