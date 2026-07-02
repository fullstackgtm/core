// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCredential } from "../credentials.js";
import { patchPlanToMarkdown } from "../format.js";
import { createFilePlanStore } from "../planStore.js";
import { buildAcquirePlan, buildEnrichPlan, createFileEnrichRunStore, DEFAULT_STALE_DAYS, ENRICH_CONFIG_FILE_NAME, builtinAcquirePreset, builtinEnrichPreset, enrichRunId, inferIngestObjectType, latestStamps, loadEnrichConfig, parseCsv, resolveCrmField, selectStaleWork, stagedSourceRecords, staleDaysFor } from "../enrich.js";
import { loadMeter, remaining } from "../acquireMeter.js";
import { crmContactKeys, fetchExploriumProspects, fetchPipe0CrustdataProspects, partitionFreshProspects, pipe0ResolveCompanyDomains, pipe0ResolveWorkEmails, prospectIdentityKeys } from "../connectors/prospectSources.js";
import { loadSeen, recordSeen } from "../acquireSeen.js";
import { reportCounts, reportEvent } from "../runReport.js";
import { createLinkedInProvider, discoverLinkedInProspects } from "../acquireLinkedIn.js";
import { fitThreshold, icpToCrustdataFilters, icpToExploriumFilters, scoreProspectAgainstIcp } from "../icp.js";
import { apolloPullKeysForAppend, apolloPullKeysForRefresh, createApolloClient, pullApolloRecords } from "../enrichApollo.js";
import { isSpoolPath, readSpoolPath } from "../spoolFiles.js";
import { isOptionValue, loadIcp, numericOption, option, readSnapshot, saveRequested } from "./shared.js";
import { providerKey } from "./tam.js";
import { unknownSubcommandError } from "./suggest.js";
import { colorEnabled, createStatusLine, formatBar, formatDuration, paint } from "./ui.js";
/**
 * The enrich layer: governed append/refresh of third-party data (Apollo pull,
 * Clay ingest) into the CRM through the normal dry-run → approval → apply
 * contract. State lives in the profile-scoped run store (checkpoint,
 * staleness ledger, observability in one); scheduling belongs to the
 * horizontal scheduler — enrich owns no cron logic.
 */
export async function enrichCommand(args) {
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
enrich acquire [--source <id>] [--max <n>] [--list <id>] [--assign-owner <id>] [--save] [--config <path>] [--json]
enrich status  [--runs] [--source <id>] [--config <path>] [--json]

acquire creates NET-NEW leads from a staged prospect list (ingest first):
it dedupes each sourced row against the CRM, skips matches and ambiguities
(resolve-first never creates over a possible duplicate), and proposes a
\`create_record\` op per confirmed net-new row — capped by the acquire meter's
remaining budget (records + spend, per day and per month; whichever is hit
first). Approval-gated like every write: \`--save\` → plans approve → apply.
The meter is charged only when a create actually lands at apply.
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
    const presetFor = (src) => subcommand === "acquire" ? builtinAcquirePreset(src) : builtinEnrichPreset(src);
    const config = !explicitConfig && !existsSync(configFile)
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
        if (!autoAppend)
            return;
    }
    if (subcommand === "acquire") {
        if (!config.acquire) {
            throw new Error('enrich acquire: config has no "acquire" section. Add e.g. { "acquire": { "create": { "contact": { "matchKey": "email", "properties": { "email": "email", "firstname": "first_name", "lastname": "last_name" } } }, "budget": { "records": { "perDay": 50, "perMonth": 500 } }, "costPerRecord": { "clay": 0.10 } } } to enrich.config.json.');
        }
        const source = resolveEnrichSource(config, rest);
        const sourceConfig = config.sources[source];
        const save = saveRequested(rest);
        const today = new Date().toISOString().slice(0, 10);
        // Prospects come from an API source (net-new discovery, e.g. Explorium +
        // pipe0 work-email) or a staged ingest list (Clay/CSV/webhook).
        const snapshot = await readSnapshot(rest);
        const icp = loadIcp(rest);
        if (sourceConfig.kind === "api" && !icp) {
            console.error("⚠ No ICP loaded — discovery will use the raw discovery.filters and skip fit scoring. " +
                "Develop one with `fullstackgtm icp interview` (or pass --icp <path>) so leads map to your ICP.");
        }
        // Recommend the strong dedup key when the CRM carries no LinkedIn URLs:
        // without them, pre-email dedup falls back to the weaker name+domain match.
        if (sourceConfig.kind === "api" && !(snapshot.contacts ?? []).some((c) => c.linkedin)) {
            console.error("⚠ No LinkedIn URLs found on your contacts — pre-email dedup falls back to name+domain (weaker). " +
                "Populate the HubSpot \"LinkedIn URL\" (hs_linkedin_url) property for exact dedup; " +
                "acquire writes it on every new contact it creates, so coverage grows automatically.");
        }
        const seen = loadSeen();
        let records;
        let apiSkippedCrm = 0;
        let apiSkippedSeen = 0;
        let apiProcessedKeys = [];
        if (sourceConfig.kind === "api") {
            const api = await acquireFromApi(config, source, rest, icp, snapshot, seen);
            records = api.records;
            apiSkippedCrm = api.skippedCrm;
            apiSkippedSeen = api.skippedSeen;
            apiProcessedKeys = api.processedKeys;
        }
        else {
            const stagedLabel = option(rest, "--staged-run");
            const stagedRun = stagedLabel
                ? await store.get(stagedLabel)
                : await store.latest({ source, mode: "ingest" });
            if (!stagedRun || stagedRun.mode !== "ingest") {
                throw new Error(`No staged data for source "${source}". Stage prospects first: fullstackgtm enrich ingest <prospects.csv|payload.json> --source ${source}`);
            }
            records = stagedSourceRecords(config, source, stagedRun);
        }
        // Meter: how many MORE leads may we create right now? --max is an
        // additional per-run ceiling, never a way to exceed the budget.
        const now = new Date();
        const costPerRecord = config.acquire.costPerRecord?.[source] ?? 0;
        if (apiSkippedCrm || apiSkippedSeen) {
            console.error(`Pre-email dedup: skipped ${apiSkippedCrm} already-in-CRM + ${apiSkippedSeen} seen before paying for emails ` +
                `(≈$${((apiSkippedCrm + apiSkippedSeen) * costPerRecord).toFixed(2)} enrichment saved).`);
        }
        const headroom = remaining(loadMeter(now), config.acquire.budget, costPerRecord, now);
        const explicitMax = numericOption(rest, "--max");
        let cap = headroom.maxRecords;
        if (explicitMax !== undefined)
            cap = cap === null ? explicitMax : Math.min(cap, explicitMax);
        // Assignment: never create an ownerless lead. An explicit `acquire.assign`
        // policy wins; a `--assign-owner <id>` flag is a quick fixed override;
        // otherwise, when the portal has exactly one active owner, default every
        // lead to them. With multiple owners and no policy we refuse to guess —
        // leads are left unassigned and the operator is told to configure a rule.
        const assignOwnerFlag = option(rest, "--assign-owner");
        if (!config.acquire.assign) {
            if (assignOwnerFlag) {
                config.acquire.assign = { strategy: "fixed", ownerId: assignOwnerFlag };
            }
            else {
                const activeOwners = (snapshot.users ?? []).filter((u) => u.active !== false);
                if (activeOwners.length === 1) {
                    const sole = activeOwners[0].crmId ?? activeOwners[0].id;
                    config.acquire.assign = { strategy: "fixed", ownerId: sole };
                    console.error(`Assignment: no policy set — defaulting every lead to the portal's sole owner ` +
                        `${activeOwners[0].name} (${sole}). Configure "acquire.assign" to route across reps.`);
                }
                else if (activeOwners.length > 1) {
                    console.error(`⚠ Assignment: ${activeOwners.length} active owners and no "acquire.assign" policy — ` +
                        `leads will be created OWNERLESS. Add an acquire.assign rule (fixed / round-robin / territory) ` +
                        `or pass --assign-owner <id> so every lead lands with an owner.`);
                }
            }
        }
        const result = buildAcquirePlan({
            config,
            source,
            snapshot,
            records,
            runLabel: option(rest, "--run-label") ?? `acquire-${source}-${today}`,
            maxRecords: cap,
        });
        if (result.counts.unassigned > 0 && result.counts.created > 0) {
            console.error(`⚠ ${result.counts.unassigned}/${result.counts.created} proposed lead(s) have no owner ` +
                `(policy could not place them). They will be created ownerless.`);
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
            if (rest.includes("--json")) {
                console.log(JSON.stringify({ plan: result.plan, counts: result.counts, estCostUsd: result.estCostUsd, meter: headroom }, null, 2));
            }
            else {
                console.log(patchPlanToMarkdown(result.plan));
                console.log(meterLine);
                if (gaugeLine)
                    console.log(gaugeLine);
                console.log("\nDry run — nothing written. Re-run with --save to persist the plan, then approve + apply.");
            }
            return;
        }
        const run = await openEnrichRun(store, source, "append", option(rest, "--run-label"), today);
        const planIds = [];
        if (result.plan.operations.length > 0) {
            await createFilePlanStore().save(result.plan);
            planIds.push(result.plan.id);
            reportEvent("plan_saved", result.plan.id);
        }
        await store.update({
            ...run,
            completedAt: new Date().toISOString(),
            cursor: null,
            planIds: [...(run.planIds ?? []), ...planIds],
        });
        // Remember everyone we email-resolved this run so the next run skips them
        // pre-email (cross-run credit saver). Committed (--save) runs only.
        if (apiProcessedKeys.length > 0)
            recordSeen(apiProcessedKeys, now);
        console.log(meterLine);
        if (gaugeLine)
            console.log(gaugeLine);
        if (planIds.length > 0) {
            console.log(`Saved plan ${result.plan.id} — ${result.counts.created} net-new lead(s), est. $${result.estCostUsd.toFixed(2)}. ` +
                `Review \`fullstackgtm plans show ${result.plan.id}\`, approve \`fullstackgtm plans approve ${result.plan.id} --operations all\`, ` +
                `then \`fullstackgtm apply --plan-id ${result.plan.id} --provider hubspot\`. The meter is charged only when a create lands at apply.`);
        }
        else {
            console.log("No net-new leads to create (everything sourced already matched, or was withheld by the meter).");
        }
        return;
    }
    const mode = subcommand === "refresh" ? "refresh" : "append";
    const source = resolveEnrichSource(config, rest);
    const sourceConfig = config.sources[source];
    const save = saveRequested(rest);
    const today = new Date().toISOString().slice(0, 10);
    // Refresh work set comes from the staleness ledger, before any fetch.
    const allRuns = await store.list();
    let workSet = [];
    if (mode === "refresh") {
        const staleDaysOverride = numericOption(rest, "--stale-days");
        workSet = selectStaleWork(config, allRuns, source, { staleDaysOverride });
        if (workSet.length === 0) {
            const stamped = latestStamps(allRuns, source).size;
            console.log(stamped === 0
                ? `Nothing to refresh: no ${source} enrichment stamps yet. Run \`enrich append --source ${source} --save\` first.`
                : `Nothing to refresh: all ${stamped} stamped field(s) from ${source} are within their staleness window.`);
            return;
        }
    }
    const snapshot = await readSnapshot(rest);
    // Assemble source records: api pull (checkpointed when --save) or staged ingest data.
    let run = null;
    let records;
    let missCount = 0;
    if (sourceConfig.kind === "api") {
        const objectTypes = parseEnrichObjects(rest, config, source);
        const fieldsFor = (objectType) => (config.fields[objectType] ?? []).filter((field) => field.from[source] !== undefined);
        const pullKeys = mode === "append"
            ? apolloPullKeysForAppend(snapshot, objectTypes, (objectType, record) => fieldsFor(objectType).some((field) => {
                const value = record[resolveCrmField(objectType, field.crm)];
                return value === undefined || value === null || String(value).trim() === "";
            }))
            : apolloPullKeysForRefresh(snapshot, workSet);
        if (pullKeys.length === 0) {
            console.log(mode === "append"
                ? "Nothing to enrich: no records with a blank mapped field and a pull key (companies need a domain, contacts an email)."
                : "Nothing to refresh: no stale records carry a pull key (companies need a domain, contacts an email).");
            return;
        }
        const client = createApolloClient({
            getApiKey: () => apolloApiKey(),
            apiBaseUrl: process.env.APOLLO_API_BASE_URL,
        });
        if (save) {
            run = await openEnrichRun(store, source, mode, option(rest, "--run-label"), today);
            if (run.cursor) {
                console.error(`Resuming interrupted run ${run.runLabel} from cursor ${run.cursor} (${run.pulled?.length ?? 0} record(s) already pulled).`);
            }
        }
        // Interactive terminals get a stderr progress bar over the pull (rate +
        // ETA); the checkpointing callback below is unchanged. Inert otherwise.
        const pullBar = createStatusLine();
        const pullStarted = Date.now();
        let pullProcessed = 0;
        let result;
        try {
            result = await pullApolloRecords(client, pullKeys, {
                resumeAfter: run?.cursor ?? null,
                onProgress: async (progress) => {
                    if (pullBar.active) {
                        pullProcessed += 1;
                        const elapsed = Date.now() - pullStarted;
                        const rate = pullProcessed / Math.max(1, elapsed / 1000);
                        const left = Math.max(0, pullKeys.length - pullProcessed);
                        pullBar.set(`Enriching via ${source}… ${formatBar(pullProcessed / pullKeys.length, 12)} ${pullProcessed}/${pullKeys.length} · ${rate.toFixed(1)}/s · ETA ${formatDuration((left / Math.max(rate, 0.01)) * 1000)}`);
                    }
                    if (!run)
                        return;
                    run.cursor = progress.lastKeyValue;
                    if (progress.record)
                        run.pulled = [...(run.pulled ?? []), progress.record];
                    if (progress.miss)
                        run.missedKeys = [...(run.missedKeys ?? []), progress.miss.value];
                    await store.update(run);
                },
            });
        }
        finally {
            pullBar.done();
        }
        records = run ? [...(run.pulled ?? [])] : result.records;
        missCount = run ? (run.missedKeys?.length ?? 0) : result.misses.length;
    }
    else {
        const stagedLabel = option(rest, "--staged-run");
        const stagedRun = stagedLabel
            ? await store.get(stagedLabel)
            : await store.latest({ source, mode: "ingest" });
        if (!stagedRun || stagedRun.mode !== "ingest") {
            throw new Error(`No staged data for source "${source}". Stage it first: fullstackgtm enrich ingest <file.csv|payload.json> --source ${source}`);
        }
        records = stagedSourceRecords(config, source, stagedRun);
        if (save)
            run = await openEnrichRun(store, source, mode, option(rest, "--run-label"), today);
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
        }
        else {
            console.log(patchPlanToMarkdown(result.plan));
            console.log(formatEnrichCounts(result.counts, result.ambiguities.length));
            console.log("\nDry run — nothing written. Re-run with --save to persist the plan and the run record.");
        }
        return;
    }
    // --save: persist the plan (when it proposes anything) and finalize the run.
    const planIds = [];
    if (result.plan.operations.length > 0) {
        await createFilePlanStore().save(result.plan);
        planIds.push(result.plan.id);
    }
    const finalized = {
        ...run,
        completedAt: new Date().toISOString(),
        cursor: null,
        counts: result.counts,
        planIds: [...(run.planIds ?? []), ...planIds],
        stamps: [...(run.stamps ?? []), ...result.stamps],
        ambiguities: result.ambiguities,
    };
    await store.update(finalized);
    console.log(formatEnrichCounts(result.counts, result.ambiguities.length));
    if (planIds.length > 0) {
        console.log(`Saved plan ${result.plan.id} (run ${finalized.runLabel}). Review with \`fullstackgtm plans show ${result.plan.id}\`, ` +
            `approve with \`fullstackgtm plans approve ${result.plan.id} --operations <ids|all>\`, then ` +
            `\`fullstackgtm apply --plan-id ${result.plan.id} --provider <name>\`.`);
    }
    else {
        console.log(`Run ${finalized.runLabel} recorded; no operations to propose.`);
    }
}
function formatEnrichCounts(counts, ambiguities) {
    return (`Source records: ${counts.fetched} fetched · ${counts.matched} matched · ` +
        `${counts.unmatched} unmatched · ${counts.ambiguous} ambiguous (${ambiguities} collision(s) recorded) · ` +
        `${counts.opsEmitted} operation(s) proposed`);
}
/**
 * Pull net-new prospects from an API acquire source into source records the
 * acquire builder dedupes + turns into create_record ops. Explorium discovers;
 * pipe0 (when resolveEmailsWith=pipe0) fills real work emails. Only rows that
 * carry the dedupe key (email) survive — you cannot resolve-first without it.
 */
async function acquireFromApi(config, source, rest, icp, snapshot, seen) {
    const acquire = config.acquire;
    const disc = acquire.discovery?.[source];
    if (!disc) {
        throw new Error(`enrich acquire: api source "${source}" needs an "acquire.discovery.${source}" config (provider + size).`);
    }
    const matchKey = acquire.create.contact?.matchKey ?? "email";
    const maxOverride = numericOption(rest, "--max");
    const size = maxOverride !== undefined ? Math.min(maxOverride, disc.size ?? 25) : disc.size ?? 25;
    // 1. Discover. Filters come from the ICP when one is loaded (the whole point —
    //    targeted, not random); otherwise from the hand-written disc.filters.
    let prospects;
    if (disc.provider === "explorium") {
        const filters = icp
            ? icpToExploriumFilters(icp)
            : (disc.filters ?? {});
        prospects = await fetchExploriumProspects({ apiKey: providerKey("explorium"), filters, size });
    }
    else if (disc.provider === "pipe0") {
        const filters = icp ? icpToCrustdataFilters(icp) : (disc.filters ?? {});
        prospects = await fetchPipe0CrustdataProspects({ apiKey: providerKey("pipe0"), filters, limit: size });
    }
    else if (disc.provider === "linkedin" || disc.provider === "heyreach") {
        // LinkedIn reads a pre-populated lead list (not an ICP-driven query); the ICP
        // scores the pulled list below. List id: disc.listId or --list <id>.
        const listId = disc.listId ?? option(rest, "--list") ?? undefined;
        if (!listId) {
            throw new Error("enrich acquire --source linkedin needs a HeyReach lead-list id: pass --list <id> or set acquire.discovery.linkedin.listId.");
        }
        const provider = createLinkedInProvider(disc.provider, providerKey("heyreach"));
        prospects = await discoverLinkedInProspects(provider, { sourceId: listId, max: size });
    }
    else {
        throw new Error(`enrich acquire: unknown discovery provider "${disc.provider}" (explorium | pipe0 | linkedin).`);
    }
    // Surface a zero-discovery result LOUDLY rather than emit a silent empty plan.
    // A provider that returns 0 with no error usually means an over-narrow ICP
    // filter (most often the industry/seniority vocab) — not "no market exists".
    const discoveredCount = prospects.length;
    if (discoveredCount === 0) {
        console.error(`enrich acquire: ${disc.provider} discovered 0 prospects for this ICP — the plan will be empty. ` +
            "This is usually an over-narrow filter, not an empty market: check the ICP's industry and seniority " +
            "(provider vocab is finicky), widen one constraint, or run `fullstackgtm icp show` to inspect the " +
            "generated discovery filters. (Distinct from dedup: nothing was returned to filter.)");
    }
    // 2. ICP fit scoring BEFORE paying for emails — only above-threshold prospects
    //    proceed to (credit-spending) email resolution.
    if (icp) {
        const threshold = fitThreshold(icp);
        prospects = prospects
            .map((p) => ({ ...p, fitScore: scoreProspectAgainstIcp(p, icp).score }))
            .filter((p) => (p.fitScore ?? 0) >= threshold);
        if (discoveredCount > 0 && prospects.length === 0) {
            console.error(`enrich acquire: all ${discoveredCount} discovered prospect(s) scored below the ICP fit threshold ` +
                `(${fitThreshold(icp)}) — none qualified. Loosen the ICP persona or lower scoring.threshold.`);
        }
    }
    // 2.5 Pre-email dedup — drop prospects already in the CRM (name+domain match
    //     vs the snapshot) or already processed in a prior run (the seen cache),
    //     BEFORE paying pipe0 for emails. The email-level dedup (buildAcquirePlan)
    //     and apply-time resolve-first remain the precise backstop.
    const { fresh, skippedCrm, skippedSeen } = partitionFreshProspects(prospects, crmContactKeys(snapshot), seen);
    prospects = fresh;
    // 3. Resolve real work emails. Triggered either when email IS the dedupe key
    //    (Explorium's email is hashed, Crustdata returns none) or when a source
    //    that keys on something else opts in via `resolveEmailsWith: "pipe0"`
    //    (e.g. LinkedIn keys on the profile URL but still wants outreach emails).
    //    pipe0 waterfall, chunked; resolves from name + company domain/name.
    if (matchKey === "email" || disc.resolveEmailsWith === "pipe0") {
        // The waterfall needs a company DOMAIN; LinkedIn/HeyReach lists carry only
        // names. Resolve domains first (pipe0 company:identity) so resolution can
        // actually land — without it, name-only resolution fails for every lead.
        if (prospects.some((p) => !p.companyDomain && p.companyName)) {
            prospects = await pipe0ResolveCompanyDomains({ apiKey: providerKey("pipe0"), prospects });
        }
        prospects = await pipe0ResolveWorkEmails({ apiKey: providerKey("pipe0"), prospects });
    }
    const processedKeys = prospects.flatMap(prospectIdentityKeys);
    const records = prospects
        .map((p) => {
        const keyValue = p[matchKey];
        return {
            id: p.sourceId ?? `${source}:${keyValue ?? p.fullName ?? ""}`,
            objectType: "contact",
            keys: { [matchKey]: keyValue },
            payload: p,
        };
    })
        .filter((record) => Boolean(record.keys[matchKey]));
    return { records, skippedCrm, skippedSeen, processedKeys };
}
/**
 * Rich-only fuel gauge under the acquire meter line: one bar per configured
 * budget window, colored by how much is burned (green → yellow ≥70% → red
 * ≥90%). Returns null in plain mode or with no caps configured, keeping
 * piped output byte-identical.
 */
function acquireGaugeLine(headroom, budget, p) {
    if (!p.enabled)
        return null;
    const parts = [];
    const segment = (label, left, cap, fmt) => {
        if (left === null || cap === undefined || cap <= 0)
            return;
        const used = Math.max(0, cap - left);
        const fraction = used / cap;
        const painter = fraction >= 0.9 ? p.red : fraction >= 0.7 ? p.yellow : p.green;
        parts.push(`${p.dim(label)} ${painter(formatBar(fraction, 10))} ${fmt(used)}/${fmt(cap)}`);
    };
    segment("records/day", headroom.records.day, budget.records?.perDay, String);
    segment("records/mo", headroom.records.month, budget.records?.perMonth, String);
    segment("spend/day", headroom.spendUsd.day, budget.spend?.perDay, (value) => `$${value.toFixed(2)}`);
    segment("spend/mo", headroom.spendUsd.month, budget.spend?.perMonth, (value) => `$${value.toFixed(2)}`);
    return parts.length > 0 ? parts.join("  ·  ") : null;
}
function formatAcquireMeter(headroom, costPerRecord) {
    const n = (v) => (v === null ? "∞" : String(v));
    const money = (v) => (v === null ? "∞" : `$${v.toFixed(2)}`);
    const max = headroom.maxRecords === null ? "unlimited" : `${headroom.maxRecords}`;
    return (`Acquire meter — creatable now: ${max} lead(s). ` +
        `Records left: ${n(headroom.records.day)}/day, ${n(headroom.records.month)}/month · ` +
        `Spend left: ${money(headroom.spendUsd.day)}/day, ${money(headroom.spendUsd.month)}/month ` +
        `(≈$${costPerRecord.toFixed(2)}/lead).`);
}
function resolveEnrichSource(config, rest) {
    const requested = option(rest, "--source");
    const declared = Object.keys(config.sources);
    if (requested) {
        if (!config.sources[requested]) {
            throw new Error(`Unknown enrich source "${requested}" (declared: ${declared.join(", ")})`);
        }
        return requested;
    }
    if (declared.length === 1)
        return declared[0];
    if (config.sources.apollo)
        return "apollo";
    throw new Error(`Multiple sources declared (${declared.join(", ")}) — pass --source <id>`);
}
function parseEnrichObjects(rest, config, source) {
    const configured = ["company", "contact"].filter((objectType) => (config.fields[objectType] ?? []).some((field) => field.from[source] !== undefined));
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
function apolloApiKey() {
    if (process.env.APOLLO_API_KEY)
        return process.env.APOLLO_API_KEY;
    const stored = getCredential("apollo");
    if (stored)
        return stored.accessToken;
    throw new Error('No Apollo credentials. Run `echo "$APOLLO_API_KEY" | fullstackgtm login apollo` once, or set APOLLO_API_KEY.');
}
/**
 * Open (or resume) a saved run. An interrupted run — same label, same source
 * and mode, never completed — is resumed from its cursor; a completed run
 * with the default label gets a -2/-3 suffix (runs are append-only).
 */
async function openEnrichRun(store, source, mode, requestedLabel, today) {
    const baseLabel = requestedLabel ?? `${mode}-${source}-${today}`;
    let label = baseLabel;
    for (let suffix = 2;; suffix += 1) {
        const existing = await store.get(label);
        if (!existing)
            break;
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
async function enrichIngest(store, config, rest, autoAppend = false) {
    const file = rest.find((arg) => !arg.startsWith("--") && !isOptionValue(rest, arg));
    if (!file)
        throw new Error("Usage: fullstackgtm enrich ingest <file.csv|payload.json|spool.jsonl|spool-dir> --source <id> [--run-label <label>]");
    const source = option(rest, "--source");
    if (!source)
        throw new Error("enrich ingest requires --source <id> (the ingest source the data belongs to)");
    const sourceConfig = config.sources[source];
    if (!sourceConfig) {
        throw new Error(`Unknown enrich source "${source}" (declared: ${Object.keys(config.sources).join(", ")})`);
    }
    if (sourceConfig.kind !== "ingest") {
        throw new Error(`Source "${source}" is kind "${sourceConfig.kind}" — only ingest sources accept staged data.`);
    }
    const filePath = resolve(process.cwd(), file);
    let rows;
    if (isSpoolPath(filePath)) {
        // Spool convention (docs/signal-spool-format.md): a *.jsonl file (one JSON
        // row per line) or a directory of *.jsonl / *.json spool files — so a
        // webhook landing zone can be staged directly. Additive: .csv / .json
        // files parse exactly as before.
        rows = readSpoolPath(filePath, "enrich ingest").map((entry) => entry.row);
    }
    else if ((file.toLowerCase().endsWith(".csv") || sourceConfig.format === "csv") && !file.toLowerCase().endsWith(".json")) {
        const raw = readFileSync(filePath, "utf8");
        rows = parseCsv(raw);
    }
    else {
        const raw = readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
            rows = parsed;
        else if (parsed && typeof parsed === "object" && Array.isArray(parsed.rows)) {
            rows = parsed.rows;
        }
        else if (parsed && typeof parsed === "object") {
            rows = [parsed];
        }
        else {
            throw new Error(`${file}: expected a JSON array, an object, or { "rows": [...] }`);
        }
    }
    if (rows.length === 0)
        throw new Error(`${file}: no rows to stage`);
    const objectsFlag = option(rest, "--objects");
    const objectType = objectsFlag
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
    console.log(autoAppend
        ? `Staged ${rows.length} ${objectType} row(s) from ${file} as run ${label}; matching against the CRM…`
        : `Staged ${rows.length} ${objectType} row(s) from ${file} as run ${label}. ` +
            `Next: fullstackgtm enrich append --source ${source} [source options] [--save]`);
}
function parseSingleObjectType(value) {
    const normalized = value.trim().toLowerCase();
    if (normalized === "companies" || normalized === "company")
        return "company";
    if (normalized === "contacts" || normalized === "contact")
        return "contact";
    throw new Error(`--objects must be companies or contacts (got "${value}")`);
}
async function enrichStatus(store, rest, configFile) {
    const sourceFilter = option(rest, "--source");
    const allRuns = (await store.list()).filter((run) => !sourceFilter || run.source === sourceFilter);
    if (allRuns.length === 0) {
        console.log(sourceFilter
            ? `No enrich runs for source "${sourceFilter}".`
            : "No enrich runs yet. Start with `fullstackgtm enrich append --save` or stage data with `enrich ingest`.");
        return;
    }
    // Staleness windows come from the config when one is readable; status must
    // not REQUIRE a config (the run store alone is enough to report on).
    let config = null;
    if (existsSync(configFile)) {
        try {
            config = loadEnrichConfig(configFile);
        }
        catch {
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
        console.log(`  last: ${last.runLabel} (${last.mode}) ${last.completedAt ? `completed ${last.completedAt}` : "INTERRUPTED"}` +
            ` · ${last.counts.fetched} fetched, ${last.counts.matched} matched, ${last.counts.unmatched} unmatched,` +
            ` ${last.counts.ambiguous} ambiguous, ${last.counts.opsEmitted} ops` +
            (last.planIds.length ? ` · plans: ${last.planIds.join(", ")}` : ""));
        for (const run of entry.interrupted) {
            console.log(`  interrupted: ${run.runLabel} at cursor ${run.cursor ?? "(start)"} — re-run with --save to resume`);
        }
        console.log(`  stamps: ${entry.stamps.total} field(s) enriched · ${entry.stamps.stale} stale (window: ${entry.stamps.windowSource})` +
            (entry.stamps.total ? ` · age ${entry.stamps.newestDays}–${entry.stamps.oldestDays}d` : ""));
    }
    if (rest.includes("--runs")) {
        console.log("");
        for (const run of allRuns) {
            console.log(`${run.runLabel}  ${run.source.padEnd(8)} ${run.mode.padEnd(8)} ${run.completedAt ? "done" : "interrupted"}` +
                `  ${run.counts.opsEmitted} ops  ${run.stamps.length} stamps${run.staged ? `  ${run.staged.length} staged` : ""}`);
        }
    }
}
