// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCredential, resolveHubspotConnection } from "../credentials.js";
import { discoverSignalsWithExa } from "../signalDiscovery.js";
import { buildSignalsFromAts, computeWeights, createFileSignalStore, DEFAULT_SIGNALS_CONFIG, dedupeSignals, loadSignalsConfig, makeOutcome, normalizeAccountDomain, SIGNAL_BUCKETS, signalRunId, signalsSpoolDir, stagedRowToSignal } from "../signals.js";
import { fetchAtsJobs } from "../connectors/atsBoards.js";
import { getSignalSource, listSignalSources } from "../connectors/signalSources.js";
import { isSpoolPath, readSpoolPath } from "../spoolFiles.js";
import { loadIcp, option, readSnapshot, repeatedOption, saveRequested } from "./shared.js";
import { createStatusLine } from "./ui.js";
import { unknownSubcommandError } from "./suggest.js";
/**
 * Resolve a signals config: explicit --config, else signals.config.json in cwd,
 * else the zero-config DEFAULT_SIGNALS_CONFIG (preset-first, like enrich).
 */
function resolveSignalsConfig(args) {
    const explicit = option(args, "--config");
    if (explicit)
        return loadSignalsConfig(resolve(process.cwd(), explicit));
    const local = resolve(process.cwd(), "signals.config.json");
    if (existsSync(local))
        return loadSignalsConfig(local);
    return DEFAULT_SIGNALS_CONFIG;
}
function concise(value, max = 72) {
    const oneLine = value.replace(/\s+/g, " ").trim();
    return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
function renderSignals(signals) {
    if (signals.length === 0)
        return "No signals matched.";
    const lines = [`Fresh signals (${signals.length})`, ""];
    for (const signal of signals) {
        lines.push(`${signal.weight.toFixed(2).padStart(5)}  ${signal.accountDomain}  · ${signal.bucket}`);
        lines.push(`       ${concise(signal.trigger)}`);
    }
    return lines.join("\n");
}
/**
 * Resolve the watchlist of accounts to scan. Sources, in precedence order:
 *  - a --watchlist file (JSON array of {domain, boards?} or bare domain strings),
 *  - a `crm:<segment>` token (derive account domains from a CRM snapshot, scoped
 *    by the segment's `field=value` where-clauses; reuses readSnapshot),
 *  - config.watchlist.domains.
 * Board tokens come from the entry's own `boards`, else config.watchlist.boards.
 */
async function resolveWatchlist(args, config) {
    const configBoards = config.watchlist.boards ?? {};
    const fromConfig = (domain) => {
        const normalized = normalizeAccountDomain(domain);
        const token = configBoards[normalized] ?? configBoards[domain];
        return token ? { domain: normalized, boards: { greenhouse: token, lever: token, ashby: token } } : { domain: normalized };
    };
    const watchlistArg = option(args, "--watchlist") ?? config.watchlist.source;
    if (watchlistArg && watchlistArg.startsWith("crm:")) {
        const segment = watchlistArg.slice("crm:".length);
        const snapshot = await readSnapshot(args);
        // Segment is an optional `;`-separated list of `field=value` equality
        // clauses over snapshot accounts (the common case; richer filtering lives in
        // bulk-update). Empty segment = every account with a domain.
        const clauses = (segment ? segment.split(";").map((s) => s.trim()).filter(Boolean) : []).map((clause) => {
            const eq = clause.indexOf("=");
            if (eq === -1)
                throw new Error(`--watchlist crm:<segment>: clause "${clause}" must be field=value.`);
            return { field: clause.slice(0, eq).trim(), value: clause.slice(eq + 1).trim() };
        });
        const accounts = (snapshot.accounts ?? []).filter((acct) => clauses.every((c) => {
            const raw = acct[c.field];
            return (raw == null ? "" : String(raw)).toLowerCase() === c.value.toLowerCase();
        }));
        const domains = accounts
            .map((acct) => normalizeAccountDomain(acct.domain ?? ""))
            .filter((d) => Boolean(d));
        return [...new Set(domains)].map(fromConfig);
    }
    if (watchlistArg) {
        const raw = JSON.parse(readFileSync(resolve(process.cwd(), watchlistArg), "utf8"));
        if (!Array.isArray(raw))
            throw new Error(`--watchlist ${watchlistArg}: expected a JSON array of domains or {domain, boards?} objects`);
        return raw.map((entry) => {
            if (typeof entry === "string")
                return fromConfig(entry);
            if (entry && typeof entry === "object" && typeof entry.domain === "string") {
                const e = entry;
                const base = fromConfig(e.domain);
                return e.boards ? { domain: base.domain, boards: { ...base.boards, ...e.boards } } : base;
            }
            throw new Error(`--watchlist ${watchlistArg}: each entry must be a domain string or {domain, boards?} object`);
        });
    }
    return (config.watchlist.domains ?? []).map(fromConfig);
}
/**
 * `signals` — detect fresh buying triggers (ATS job-board scrapes + staged
 * funding/company/social ingest), rank them, and persist a local signal ledger.
 * READ-ONLY re: CRM: NEVER emits a PatchPlan, never calls a recording connector.
 * `--save` persists only to the signal store, not a plan.
 */
export async function signalsCommand(args) {
    const [sub, ...rest] = args;
    // Help-before-network: catch --help/-h BEFORE any config load or fetch —
    // anywhere in argv (`signals --help` and `signals fetch --help` both land here).
    if (!sub || args.includes("--help") || args.includes("-h")) {
        console.log(`Usage:
  fullstackgtm signals fetch [--bucket job,funding,...] [--source greenhouse,lever,ashby] [--connector file,serpapi-news,hubspot-forms] [--connector-opt k=v ...] [--watchlist <path|crm:segment>] [--keywords "growth,revops"] [--from <file.json|spool.jsonl|spool-dir>] [--config <path>] [--save]
  fullstackgtm signals discover [--icp <path>] [--source exa] [--since 30d] [--max-accounts 10] [--max-results 50] [--max-searches 12] [--max-usd 0.25] [--save]
  fullstackgtm signals list [--since 7d] [--bucket b] [--account d] [--unjudged]
  fullstackgtm signals outcome --account <domain> [--touch <id>] --result replied|meeting|bounced|no_reply
  fullstackgtm signals weights [--explain]

Detect fresh buying triggers and rank them. \`discover\` searches canonical
public ATS pages for evidence matching the ICP's behavioral trigger hypotheses,
then resolves employer domains through Exa. \`fetch\` and \`discover\` are read-only re: CRM — they
NEVER emit a patch plan; --save persists only the local signal ledger (used by
\`icp judge\`). ATS adapters are no-auth. Source connectors (--connector) pull
from connected platforms: file (local JSON/JSONL spool, no auth), serpapi-news
(API key via env/login), hubspot-forms (reuses the HubSpot login). Secrets come
from the credential ladder, never argv; --connector-opt carries non-secret knobs
(e.g. path=… for file, bucket=company for serpapi-news).

\`--connector file\` with no path reads the conventional webhook landing zone
(${signalsSpoolDir()}) — every *.jsonl in it. Point a webhook receiver there
(one row per event); see docs/signal-spool-format.md.`);
        return;
    }
    if (sub === "discover") {
        const source = option(rest, "--source") ?? "exa";
        if (source !== "exa")
            throw new Error(`signals discover: unsupported --source "${source}" (currently: exa).`);
        const icp = loadIcp(rest);
        if (!icp)
            throw new Error("signals discover: no ICP found. Pass --icp <path> or create ./icp.json.");
        const apiKey = await resolveSignalSourceKey("exa");
        if (!apiKey)
            throw new Error("signals discover: missing Exa API key. Set EXA_API_KEY or run `fullstackgtm login exa`.");
        const now = new Date();
        const sinceArg = option(rest, "--since") ?? "30d";
        const since = new Date(now.getTime() - parseSinceWindowMs(sinceArg));
        const maxAccounts = positiveIntegerOption(rest, "--max-accounts", 10);
        const maxResults = positiveIntegerOption(rest, "--max-results", 50);
        const maxSearches = positiveIntegerOption(rest, "--max-searches", 12);
        const maxUsd = positiveNumberOption(rest, "--max-usd", 0.25);
        const config = resolveSignalsConfig(rest);
        const status = createStatusLine();
        status.set(`Searching public evidence with Exa… up to ${maxSearches} searches / $${maxUsd.toFixed(2)}`);
        let discovered;
        try {
            discovered = await discoverSignalsWithExa({ icp, apiKey, since, maxAccounts, maxResults, maxSearches, maxUsd, now,
                config });
        }
        finally {
            status.done();
        }
        const store = createFileSignalStore();
        const priorSignals = await store.allSignals();
        const { fresh, deduped } = dedupeSignals(discovered.signals, priorSignals, config.dedupWindowDays, now);
        const ranked = [...fresh].sort((a, b) => b.weight - a.weight || a.accountDomain.localeCompare(b.accountDomain));
        const output = { ...discovered.summary, freshSignals: ranked.length, dedupedSignals: deduped.length,
            warnings: discovered.summary.warnings, signals: ranked };
        console.log(rest.includes("--json") || rest.includes("--verbose") ? JSON.stringify(output, null, 2) : renderSignals(ranked));
        console.error(`Exa: ${discovered.summary.searchesUsed}/${maxSearches} searches, $${discovered.summary.costUsd.toFixed(4)} reported cost; ` +
            `${discovered.summary.matchedEvidence} evidence match(es), ${discovered.summary.resolvedAccounts} account(s), ` +
            `${ranked.length} fresh. NO plan emitted — discovery is read-only re: CRM.`);
        for (const warning of discovered.summary.warnings)
            console.error(`Warning: ${warning}`);
        if (saveRequested(rest)) {
            const runLabel = option(rest, "--label") ?? `discover-${now.toISOString().slice(0, 10)}`;
            await store.appendRun({ id: signalRunId(runLabel), runLabel, startedAt: now.toISOString(), completedAt: new Date().toISOString(),
                buckets: ["job"], counts: { fetched: discovered.summary.rawResults, new: ranked.length, deduped: deduped.length }, signals: ranked });
            console.error(`Saved signal run "${runLabel}". Next: \`fullstackgtm icp judge --signals-from ${runLabel} --save\`.`);
        }
        else {
            console.error("(not saved — re-run with --save to persist this evidence to the signal ledger)");
        }
        return;
    }
    if (sub === "fetch") {
        const config = resolveSignalsConfig(rest);
        // Merge --keywords into the job bucket; filter buckets + job sources.
        const keywordsArg = option(rest, "--keywords");
        if (keywordsArg) {
            const merged = keywordsArg.split(",").map((k) => k.trim()).filter(Boolean);
            config.buckets.job = { ...config.buckets.job, keywords: merged };
        }
        const bucketFilter = option(rest, "--bucket");
        // Explicit --bucket narrows EVERYTHING (job scan, --from, connectors). With
        // no --bucket, the JOB SCAN defaults to buckets that have configured sources
        // (its legacy behavior), but staged/connector rows are NOT narrowed — they
        // carry their own bucket and must flow even for buckets with no `sources`
        // (e.g. `demand`, which `hubspot-forms` and form-spool rows produce).
        const explicitBuckets = bucketFilter
            ? bucketFilter.split(",").map((b) => b.trim()).filter(Boolean)
            : null;
        const buckets = explicitBuckets ?? SIGNAL_BUCKETS.filter((b) => (config.buckets[b]?.sources.length ?? 0) > 0);
        for (const b of buckets) {
            if (!SIGNAL_BUCKETS.includes(b))
                throw new Error(`Unknown bucket: ${b} (one of ${SIGNAL_BUCKETS.join(", ")})`);
        }
        // Bucket filter for explicitly-provided rows: the --bucket list, else none.
        const rowBuckets = explicitBuckets ?? [];
        const sourceFilter = option(rest, "--source");
        const allJobSources = ["greenhouse", "lever", "ashby"];
        const jobSources = sourceFilter
            ? sourceFilter.split(",").map((s) => s.trim()).filter(Boolean).filter((s) => allJobSources.includes(s))
            : config.buckets.job.sources.filter((s) => allJobSources.includes(s));
        const now = new Date();
        const store = createFileSignalStore();
        const priorSignals = await store.allSignals();
        const candidates = [];
        // Job bucket: scan ATS boards for each watchlist account x job source.
        if (buckets.includes("job")) {
            const watchlist = await resolveWatchlist(rest, config);
            // Live tally on interactive terminals (inert no-op otherwise): boards
            // are checked sequentially, so a long watchlist is otherwise silent.
            const status = createStatusLine();
            let hits = 0;
            try {
                for (const [index, account] of watchlist.entries()) {
                    status.set(`Checking ATS boards… ${index + 1}/${watchlist.length} domains · ${hits} signal${hits === 1 ? "" : "s"} · ${account.domain}`);
                    const rawJobs = [];
                    for (const source of jobSources) {
                        const boardToken = account.boards?.[source] ?? account.domain;
                        const jobs = await fetchAtsJobs({
                            source,
                            boardToken,
                            accountDomain: account.domain,
                            keywords: config.buckets.job.keywords,
                        });
                        for (const job of jobs)
                            rawJobs.push({ ...job, source });
                    }
                    const accountSignals = buildSignalsFromAts(rawJobs, { domain: account.domain }, config, {
                        now,
                        priorSignals,
                    });
                    hits += accountSignals.length;
                    candidates.push(...accountSignals);
                }
            }
            finally {
                status.done();
            }
        }
        // Staged ingest (any bucket): --from <file.json|spool.jsonl|spool-dir>. Narrowed only by --bucket.
        const fromFile = option(rest, "--from");
        if (fromFile) {
            const ingested = readStagedSignals(resolve(process.cwd(), fromFile), rowBuckets, now);
            candidates.push(...ingested);
        }
        // Source connectors (opt-in, additive): --connector id[,id] [--connector-opt k=v ...].
        // Default behavior is unchanged when no --connector is passed.
        const connectorArg = option(rest, "--connector");
        if (connectorArg) {
            const ids = connectorArg.split(",").map((s) => s.trim()).filter(Boolean);
            const options = {};
            for (const pair of repeatedOption(rest, "--connector-opt")) {
                const eq = pair.indexOf("=");
                if (eq === -1)
                    throw new Error(`--connector-opt "${pair}" must be key=value.`);
                options[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
            }
            // The `file` connector defaults to the conventional spool dir (the webhook
            // landing zone) when no explicit path is given, so `--connector file`
            // works with zero args against `<profile home>/signals/spool`.
            if (ids.includes("file") && !options.path && !options.file) {
                options.path = signalsSpoolDir();
            }
            const watchlist = await resolveWatchlist(rest, config);
            const ctx = {
                watchlist: watchlist.map((a) => ({ domain: a.domain })),
                keywords: config.buckets.job.keywords ?? [],
                now,
                getApiKey: resolveSignalSourceKey,
                options,
            };
            candidates.push(...(await runSignalConnectors(ids, ctx, rowBuckets)));
        }
        const fetched = candidates.length;
        const { fresh, deduped } = dedupeSignals(candidates, priorSignals, config.dedupWindowDays, now);
        const ranked = [...fresh].sort((a, b) => b.weight - a.weight || a.accountDomain.localeCompare(b.accountDomain));
        // Ranked fresh signals to stdout; guidance to stderr.
        console.log(rest.includes("--json") || rest.includes("--verbose") ? JSON.stringify(ranked, null, 2) : renderSignals(ranked));
        console.error(`Fetched ${fetched} candidate signal(s); ${fresh.length} fresh, ${deduped.length} deduped ` +
            `(window ${config.dedupWindowDays}d). NO plan emitted — signals are read-only re: CRM.`);
        const save = saveRequested(rest);
        if (save) {
            const runLabel = option(rest, "--label") ?? `signals-${now.toISOString().slice(0, 10)}`;
            const startedAt = now.toISOString();
            await store.appendRun({
                id: signalRunId(runLabel),
                runLabel,
                startedAt,
                completedAt: new Date().toISOString(),
                buckets,
                counts: { fetched, new: fresh.length, deduped: deduped.length },
                signals: ranked,
            });
            console.error(`Saved signal run "${runLabel}" (${fresh.length} fresh). Next: \`fullstackgtm icp judge --save\`.`);
        }
        else {
            console.error("(not saved — re-run with --save to persist this run to the signal ledger)");
        }
        return;
    }
    if (sub === "list") {
        const store = createFileSignalStore();
        const all = await store.allSignals();
        const sinceArg = option(rest, "--since");
        const sinceMs = sinceArg ? parseSinceWindowMs(sinceArg) : undefined;
        const now = Date.now();
        const bucket = option(rest, "--bucket");
        const accountArg = option(rest, "--account");
        const account = accountArg ? normalizeAccountDomain(accountArg) : undefined;
        const unjudgedOnly = rest.includes("--unjudged");
        const filtered = all.filter((s) => {
            if (sinceMs !== undefined) {
                const seen = Date.parse(s.firstSeen);
                if (!Number.isFinite(seen) || now - seen > sinceMs)
                    return false;
            }
            if (bucket && s.bucket !== bucket)
                return false;
            if (account && s.accountDomain !== account)
                return false;
            if (unjudgedOnly && s.judgedBy)
                return false;
            return true;
        });
        const ranked = filtered.sort((a, b) => b.weight - a.weight || a.accountDomain.localeCompare(b.accountDomain));
        console.log(rest.includes("--json") || rest.includes("--verbose") ? JSON.stringify(ranked, null, 2) : renderSignals(ranked));
        console.error(`${ranked.length} signal(s)${unjudgedOnly ? " (unjudged)" : ""}.`);
        return;
    }
    if (sub === "outcome") {
        const accountArg = option(rest, "--account");
        if (!accountArg)
            throw new Error("signals outcome: --account <domain> is required.");
        const result = option(rest, "--result");
        const valid = ["replied", "meeting", "bounced", "no_reply"];
        if (!result || !valid.includes(result)) {
            throw new Error(`signals outcome: --result must be one of ${valid.join(", ")}.`);
        }
        const touchId = option(rest, "--touch") ?? undefined;
        const contactId = option(rest, "--contact") ?? undefined;
        const outcome = makeOutcome({ accountDomain: accountArg, touchId, contactId, result: result });
        await createFileSignalStore().appendOutcome(outcome);
        console.error(`Recorded outcome "${outcome.result}" for ${outcome.accountDomain} (${outcome.id}). ` +
            `Re-run \`fullstackgtm signals weights\` to see the learned shift.`);
        return;
    }
    if (sub === "weights") {
        const config = resolveSignalsConfig(rest);
        const store = createFileSignalStore();
        const outcomes = await store.listOutcomes();
        const signalsById = new Map((await store.allSignals()).map((s) => [s.id, s]));
        const weights = computeWeights(config, outcomes, signalsById);
        if (rest.includes("--json") || rest.includes("--verbose")) {
            console.log(JSON.stringify(weights, null, 2));
        }
        else {
            console.log(["Learned signal weights", "", ...SIGNAL_BUCKETS.map((bucket) => `${bucket.padEnd(10)} ${weights[bucket].toFixed(4)}`)].join("\n"));
        }
        if (rest.includes("--explain")) {
            // Per-bucket config default vs learned + booked/total over credited signals.
            const booked = new Map();
            const total = new Map();
            for (const outcome of outcomes) {
                for (const id of outcome.creditedSignals) {
                    const signal = signalsById.get(id);
                    if (!signal)
                        continue;
                    total.set(signal.bucket, (total.get(signal.bucket) ?? 0) + 1);
                    if (outcome.result === "meeting")
                        booked.set(signal.bucket, (booked.get(signal.bucket) ?? 0) + 1);
                }
            }
            console.error("Per-bucket weight (config default vs learned, booked/total credited):");
            for (const b of SIGNAL_BUCKETS) {
                console.error(`  ${b.padEnd(8)} default ${config.buckets[b].weight.toFixed(2)} -> learned ${weights[b].toFixed(4)} ` +
                    `(${booked.get(b) ?? 0}/${total.get(b) ?? 0} booked)`);
            }
        }
        return;
    }
    throw unknownSubcommandError("signals", sub, ["fetch", "discover", "list", "outcome", "weights"]);
}
function positiveIntegerOption(args, flag, fallback) {
    const raw = option(args, flag);
    if (raw == null)
        return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1)
        throw new Error(`${flag}: expected a positive integer (got "${raw}").`);
    return value;
}
function positiveNumberOption(args, flag, fallback) {
    const raw = option(args, flag);
    if (raw == null)
        return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0)
        throw new Error(`${flag}: expected a number greater than zero (got "${raw}").`);
    return value;
}
/** Parse a "7d"/"30d"/"12h" recency window into milliseconds. */
function parseSinceWindowMs(value) {
    const match = /^(\d+)\s*([dhwm])$/i.exec(value.trim());
    if (!match)
        throw new Error(`--since: expected a window like 7d, 24h, 2w (got "${value}").`);
    const n = Number(match[1]);
    const unit = match[2].toLowerCase();
    const ms = unit === "h" ? 3600_000 : unit === "w" ? 7 * 86_400_000 : unit === "m" ? 30 * 86_400_000 : 86_400_000;
    return n * ms;
}
/**
 * Read staged funding/company/social signals from a JSON file (array of partial
 * signals). Also accepts the spool convention (docs/signal-spool-format.md):
 * a `*.jsonl` file (one row per line) or a directory of `*.jsonl` / `*.json`
 * spool files, via the shared reader — so a webhook landing zone can be pointed
 * at directly with `--from`, same as `--connector file`. Each row is validated
 * against the signal schema + the quote gate (a non-empty verbatim quote is
 * required); source = "ingest". Plain `.json` files parse exactly as before.
 */
function readStagedSignals(path, buckets, now) {
    const staged = [];
    if (isSpoolPath(path)) {
        for (const { file, index, row } of readSpoolPath(path, "--from")) {
            staged.push({ entry: row, label: `--from ${file}: row ${index}` });
        }
    }
    else {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        if (!Array.isArray(raw))
            throw new Error(`--from ${path}: expected a JSON array of staged signals.`);
        raw.forEach((entry, index) => staged.push({ entry, label: `--from ${path}: row ${index}` }));
    }
    const out = [];
    staged.forEach(({ entry, label }) => {
        if (!entry || typeof entry !== "object")
            throw new Error(`${label} is not an object.`);
        const e = entry;
        // Filter a --bucket-excluded row out BEFORE validation so it never errors;
        // an unknown bucket falls through to stagedRowToSignal, which rejects it.
        const bucket = String(e.bucket ?? "");
        if (buckets.length && SIGNAL_BUCKETS.includes(bucket) && !buckets.includes(bucket)) {
            return;
        }
        out.push(stagedRowToSignal(e, { now, source: "ingest", errorLabel: label }));
    });
    return out;
}
/**
 * Run the selected source connectors and return their candidate signals,
 * funneled through the SAME staged-row gate as `--from` (so evidence-gating,
 * dedup, and weighting are identical regardless of intake). Connectors are
 * resilient by contract; a connector that still throws (e.g. a malformed file
 * it was explicitly pointed at) surfaces with its id for context. `--bucket`
 * filtering is applied after the row is validated.
 */
async function runSignalConnectors(ids, ctx, buckets) {
    const out = [];
    for (const id of ids) {
        const connector = getSignalSource(id);
        if (!connector) {
            const known = listSignalSources().map((c) => c.id).join(", ");
            throw new Error(`Unknown --connector "${id}" (one of: ${known}).`);
        }
        let rows;
        try {
            rows = await connector.fetch(ctx);
        }
        catch (error) {
            throw new Error(`signals source "${id}": ${error instanceof Error ? error.message : String(error)}`);
        }
        rows.forEach((row, index) => {
            const e = row;
            const bucket = String(e.bucket ?? "");
            if (buckets.length && SIGNAL_BUCKETS.includes(bucket) && !buckets.includes(bucket)) {
                return;
            }
            out.push(stagedRowToSignal(e, { now: ctx.now, source: id, errorLabel: `signals source "${id}": row ${index}` }));
        });
    }
    return out;
}
/**
 * Credential-ladder lookup for source connectors. Env wins (CI / agent
 * sandboxes never touch the filesystem), then the stored login. HubSpot reuses
 * the existing connection resolver (private-app / OAuth-refresh / broker) so a
 * forms source needs no separate login. Returns null when nothing is configured
 * — the connector then treats itself as inactive (returns []), never argv.
 */
async function resolveSignalSourceKey(provider) {
    const envKey = `FSGTM_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
    const fromEnv = process.env[envKey] ?? process.env[`${provider.toUpperCase()}_API_KEY`];
    if (fromEnv)
        return fromEnv;
    if (provider === "hubspot") {
        const connection = await resolveHubspotConnection();
        return connection?.accessToken ?? null;
    }
    return getCredential(provider)?.accessToken ?? null;
}
