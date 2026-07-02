// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFilePlanStore } from "../planStore.ts";
import type { ParsedCall } from "../calls.ts";
import { captureMarket, computeFrontStates, createFileObservationStore, diffFrontStates, loadCaptureTexts, loadMarketConfig, starterMarketConfig, validateObservationSet, verifyEvidenceSpans, type ObservationSet } from "../market.ts";
import { assessAxes, axesReportToText } from "../marketAxes.ts";
import { computeDirectives, computeOverlayStats, directivesToPlan, overlayToMarkdown, type CallDocument } from "../marketOverlay.ts";
import { computeScaleIndex, scaleReportToText } from "../marketScale.ts";
import { suggestMarketConfig } from "../marketTaxonomy.ts";
import { buildWorksheet, classifyMarket } from "../marketClassify.ts";
import { marketMapToHtml, marketMapToMarkdown } from "../marketReport.ts";
import type { CanonicalGtmSnapshot } from "../types.ts";
import { isSpoolPath, readSpoolPath } from "../spoolFiles.ts";
import { numericOption, option, repeatedOption, requireLlmCredential, saveRequested } from "./shared.ts";
import { createStatusLine } from "./ui.ts";
import { unknownSubcommandError } from "./suggest.ts";


/**
 * The market map: claim taxonomy in a reviewable config file, page captures
 * and append-only observations under the profile home, deterministic front
 * states and reports computed from the store. Intensity readings enter as
 * proposals through two channels — `classify` (LLM, bring-your-own-key, the
 * call-intelligence pattern) and `worksheet`/`observe` (an agent or human
 * fills the worksheet) — and BOTH pass the same mechanical gate: every quoted
 * span is verified verbatim against the stored capture it cites.
 */
const MARKET_SUBCOMMANDS = [
  "init", "capture", "classify", "worksheet", "observe", "fronts", "axes", "overlay", "scale", "report", "refresh",
];

export async function marketCommand(args: string[]) {
  const [subcommand, ...rest] = args;
  const configPath = () => resolve(process.cwd(), option(rest, "--config") ?? "market.config.json");

  // Catch --help anywhere before loadMarketConfig/credential checks run —
  // several subcommands (capture, refresh) have side effects on bare invocation.
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(`Usage:
market init --category <name> [--out <path>]   write a starter market.config.json
market init --category <name> --auto --vendor <url> [--vendor <url>...] [--anchor <url>] [--max-claims n]
                                               LLM-propose vendors + claim taxonomy from seed pages (needs an API key)
market capture [--config <path>] [--run <label>]
market classify [--run <label>] [--capture-run <label>] [--vendor <id>] [--model m] [--out <path>]
market worksheet --vendor <id> [--capture-run <label>] [--out <path>]
market observe --from <observations.json|sets.jsonl|spool-dir> [--unverified]
market fronts [--config <path>] [--run <label>] [--diff <prior-run>] [--json]
market axes [--config <path>] [--run <label>] [--json]
market overlay --snapshot <crm.json> [--calls <parsed.json|manifest.json>]... [--prior-run <label>]
               [--min-mentions N] [--promote-lift X] [--json] [--save --task-account <id>|--task-deal <id>]
market scale [--config <path>] [--json]
market report [--config <path>] [--run <label>] [--format md|html] [--out <path>]
market refresh [--run <label>] [--model m]     capture → classify → fronts drift → HTML report

overlay is the directive layer: joins the map to YOUR CRM ground truth and
emits OCCUPY / PROMOTE / URGENT / RETREAT directives, each carrying ≥1
observation and ≥1 CRM statistic with its sample size. Claim mentions are
deterministic word-boundary matches of each claim's "terms" against call
documents (call parse output); small samples refuse to become strategy
(--min-mentions, default 3). --save turns directives into approval-gated
create_task operations through the normal plans → approve → apply gate.

scale prints the relative scale index that sizes the report's bubbles when
vendors carry scaleSignals (citable review counts / headcount / revenue —
a within-set index, never "market share" unqualified).

axes runs the axis-discovery math: PCA over the vendor × claim intensity
matrix (PC1 = the category's primary axis, PC2 = the max-differentiation
direction orthogonal to it), triangulation of configured axes against the
PCs, and an orthogonality screen (|r|>0.75 = one axis twice). Axes live in
the config as claim-scoring rubrics; the report's strategic map and axis
lab render from them.

classify uses your Anthropic/OpenAI key (like call parse) to read the stored
captures and propose intensity readings; worksheet is the no-key path (an
agent or human fills it, submits via observe). Either way, every quoted span
is verified character-for-character against the capture it cites before the
observation is accepted — quotes that aren't on the page bounce.

The taxonomy (vendors + claims) is config you review and version; captures
and observations live under ~/.fullstackgtm/market/<category> (profile-scoped,
one client's category intel never bleeds into another's). Front states are
recomputed deterministically on every invocation — never stored.`);
    return;
  }

  if (subcommand === "init") {
    const category = option(rest, "--category");
    if (!category) throw new Error("market init requires --category <name>");
    const outPath = resolve(process.cwd(), option(rest, "--out") ?? "market.config.json");
    if (existsSync(outPath)) throw new Error(`${outPath} already exists — refusing to overwrite`);

    if (rest.includes("--auto")) {
      const vendorUrls = repeatedOption(rest, "--vendor");
      if (vendorUrls.length === 0) {
        throw new Error("market init --auto requires at least one --vendor <url> (the competitor homepages to seed from)");
      }
      const anchorUrl = option(rest, "--anchor");
      const credential = await requireLlmCredential("market classify");
      console.error(`Capturing ${vendorUrls.length} seed page(s) and proposing a claim taxonomy with ${credential.provider}…`);
      const { config, unreadableVendorIds, model } = await suggestMarketConfig({
        category,
        vendors: vendorUrls.map((url) => ({ url, anchor: anchorUrl ? url === anchorUrl : false })),
        llm: { ...credential, model: option(rest, "--model") ?? undefined },
        maxClaims: numericOption(rest, "--max-claims"),
      });
      writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);
      if (unreadableVendorIds.length > 0) {
        console.error(`Note: no readable text for ${unreadableVendorIds.join(", ")} — excluded from taxonomy grounding.`);
      }
      console.log(
        `Wrote ${outPath}: ${config.vendors.length} vendors, ${config.claims.length} proposed claims (${model}). Review it, then: fullstackgtm market refresh`,
      );
      return;
    }

    writeFileSync(outPath, `${JSON.stringify(starterMarketConfig(category), null, 2)}\n`);
    console.log(`Wrote ${outPath}. Fill in vendors and claims, then: fullstackgtm market capture`);
    return;
  }

  // Validate the subcommand BEFORE loading market.config.json — a typo'd
  // subcommand used to die with the config's ENOENT instead of a did-you-mean.
  if (!MARKET_SUBCOMMANDS.includes(subcommand)) {
    throw unknownSubcommandError("market", subcommand, MARKET_SUBCOMMANDS);
  }

  const config = loadMarketConfig(configPath());
  const store = createFileObservationStore(config.category);

  if (subcommand === "capture") {
    const result = await captureMarket(config, { runLabel: option(rest, "--run") ?? "run-1" });
    for (const entry of result.entries) {
      const flag = entry.captureHash && entry.textChars > 500 ? "" : "  <-- thin/empty";
      console.log(
        `${entry.vendorId.padEnd(16)} ${entry.kind.padEnd(8)} ${String(entry.httpStatus ?? "ERR").padEnd(4)} ${String(entry.textChars).padStart(7)} chars  ${entry.url}${flag}`,
      );
    }
    console.log(`\nmanifest: ${result.manifestPath}`);
    return;
  }

  if (subcommand === "observe") {
    const fromPath = option(rest, "--from");
    if (!fromPath) throw new Error("market observe requires --from <observations.json>");
    // Additive spool support (docs/signal-spool-format.md): a *.jsonl file (one
    // ObservationSet envelope per line) or a directory of *.jsonl / *.json spool
    // files, each envelope validated + appended through the SAME gates as the
    // single-file path. A plain .json file parses exactly as before.
    const abs = resolve(process.cwd(), fromPath);
    const sets: ObservationSet[] = isSpoolPath(abs)
      ? readSpoolPath(abs, "market observe --from").map((entry) => entry.row as unknown as ObservationSet)
      : [JSON.parse(readFileSync(abs, "utf8")) as ObservationSet];
    for (const set of sets) {
      const problems = validateObservationSet(config, set);
      if (problems.length > 0) {
        console.error(`Rejected: ${problems.length} problem(s)`);
        for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
        process.exitCode = 1;
        return;
      }
      if (!rest.includes("--unverified")) {
        const { textByHash } = loadCaptureTexts(config.category);
        const failures = verifyEvidenceSpans(set.observations, textByHash);
        if (failures.length > 0) {
          console.error(`Rejected: ${failures.length} evidence span(s) failed verification against the stored captures`);
          for (const failure of failures.slice(0, 20)) {
            console.error(`  - ${failure.vendorId} × ${failure.claimId}: ${failure.problem}`);
          }
          console.error("Quotes must be copied verbatim from the captured pages. (--unverified skips this gate when the captures genuinely live elsewhere.)");
          process.exitCode = 1;
          return;
        }
      }
      await store.append(set);
      console.log(`Appended ${set.runLabel}: ${set.observations.length} observations (${set.extractor})`);
    }
    return;
  }

  if (subcommand === "worksheet") {
    const vendorId = option(rest, "--vendor");
    if (!vendorId) throw new Error("market worksheet requires --vendor <id>");
    const worksheet = buildWorksheet(config, vendorId, { captureRun: option(rest, "--capture-run") ?? undefined });
    const outPath = option(rest, "--out");
    const payload = `${JSON.stringify(worksheet, null, 2)}\n`;
    if (outPath) {
      writeFileSync(resolve(process.cwd(), outPath), payload);
      console.log(`Wrote ${outPath} (${worksheet.pages.length} captured pages, ${worksheet.claims.length} claims)`);
    } else {
      console.log(payload);
    }
    return;
  }

  if (subcommand === "classify") {
    const credential = await requireLlmCredential("market classify");
    const vendorFilter = option(rest, "--vendor");
    const outPath = option(rest, "--out");
    if (vendorFilter && !outPath) {
      throw new Error(
        "market classify --vendor produces a partial set (coverage validation would reject it) — pass --out <path> to inspect/merge it by hand",
      );
    }
    const classifyStatus = createStatusLine();
    let result: Awaited<ReturnType<typeof classifyMarket>>;
    try {
      result = await classifyMarket(config, {
        llm: { ...credential, model: option(rest, "--model") ?? undefined },
        runLabel: option(rest, "--run") ?? option(rest, "--capture-run") ?? "run-1",
        captureRun: option(rest, "--capture-run") ?? undefined,
        vendors: vendorFilter ? [vendorFilter] : undefined,
        onVendor: classifyStatus.active
          ? (done, total, vendorId) =>
              classifyStatus.set(`Classifying vendor ${done + 1}/${total} · ${vendorId} · ${credential.provider}`)
          : undefined,
      });
    } finally {
      classifyStatus.done();
    }
    if (result.retriedVendorIds.length > 0) {
      console.error(`Span verification bounced ${result.retriedVendorIds.join(", ")} once; retry passed.`);
    }
    if (outPath) {
      writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(result.set, null, 2)}\n`);
      console.log(`Wrote ${outPath}: ${result.set.observations.length} verified observations (${result.set.extractor})`);
      return;
    }
    const problems = validateObservationSet(config, result.set);
    if (problems.length > 0) {
      throw new Error(`Classified set failed validation: ${problems.slice(0, 5).join("; ")}`);
    }
    await store.append(result.set);
    console.log(
      `Appended ${result.set.runLabel}: ${result.set.observations.length} observations, every span verified (${result.set.extractor})`,
    );
    return;
  }

  if (subcommand === "refresh") {
    const credential = await requireLlmCredential("market classify");
    const runLabel = option(rest, "--run") ?? `run-${new Date().toISOString().slice(0, 10)}`;
    const prior = await store.latest();
    console.log(`Capturing ${config.vendors.length} vendors as ${runLabel}…`);
    const captured = await captureMarket(config, { runLabel });
    const failed = captured.entries.filter((entry) => !entry.captureHash);
    if (failed.length > 0) console.log(`${failed.length} page(s) failed/empty — affected cells will verify against remaining pages or read unobservable.`);
    console.log(`Classifying with ${credential.provider}…`);
    const refreshStatus = createStatusLine();
    let result: Awaited<ReturnType<typeof classifyMarket>>;
    try {
      result = await classifyMarket(config, {
        llm: { ...credential, model: option(rest, "--model") ?? undefined },
        runLabel,
        captureRun: runLabel,
        onVendor: refreshStatus.active
          ? (done, total, vendorId) =>
              refreshStatus.set(`Classifying vendor ${done + 1}/${total} · ${vendorId} · ${credential.provider}`)
          : undefined,
      });
    } finally {
      refreshStatus.done();
    }
    await store.append(result.set);
    const fronts = computeFrontStates(config, result.set);
    if (prior) {
      const drift = diffFrontStates(computeFrontStates(config, prior), fronts);
      if (drift.length === 0) console.log(`No front changes since ${prior.runLabel}.`);
      for (const change of drift) console.log(`CHANGED   ${change.claimId}: ${change.before} → ${change.after}`);
    }
    const outPath = option(rest, "--out") ?? `${config.category}-${runLabel}.html`;
    writeFileSync(resolve(process.cwd(), outPath), marketMapToHtml(config, result.set));
    console.log(`Wrote ${outPath}`);
    return;
  }

  const loadSet = async (): Promise<ObservationSet> => {
    const runLabel = option(rest, "--run");
    const set = runLabel ? await store.get(runLabel) : await store.latest();
    if (!set) {
      throw new Error(
        runLabel
          ? `No observation run "${runLabel}" for ${config.category}`
          : `No observations stored for ${config.category} — run market observe --from <file> first`,
      );
    }
    return set;
  };

  if (subcommand === "fronts") {
    const set = await loadSet();
    const fronts = computeFrontStates(config, set);
    const priorLabel = option(rest, "--diff");
    const prior = priorLabel ? await store.get(priorLabel) : null;
    if (priorLabel && !prior) throw new Error(`No observation run "${priorLabel}" to diff against`);
    const drift = prior ? diffFrontStates(computeFrontStates(config, prior), fronts) : null;
    if (rest.includes("--json")) {
      console.log(JSON.stringify({ runLabel: set.runLabel, fronts, drift }, null, 2));
      return;
    }
    for (const front of fronts) {
      const owner = front.state === "owned" ? ` → ${front.loudVendorIds[0]}` : "";
      console.log(`${front.state.toUpperCase().padEnd(10)} ${front.claimId}${owner}`);
    }
    if (drift) {
      console.log("");
      if (drift.length === 0) console.log(`No front changes since ${priorLabel}.`);
      for (const change of drift) console.log(`CHANGED   ${change.claimId}: ${change.before} → ${change.after}`);
    }
    return;
  }

  if (subcommand === "report") {
    const set = await loadSet();
    const format = option(rest, "--format") ?? "md";
    const output = format === "html" ? marketMapToHtml(config, set) : marketMapToMarkdown(config, set);
    const outPath = option(rest, "--out");
    if (outPath) {
      writeFileSync(resolve(process.cwd(), outPath), output);
      console.log(`Wrote ${outPath}`);
    } else {
      console.log(output);
    }
    return;
  }

  if (subcommand === "axes") {
    const set = await loadSet();
    const report = assessAxes(config, set);
    if (rest.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(axesReportToText(report));
    return;
  }

  if (subcommand === "scale") {
    const report = computeScaleIndex(config);
    if (rest.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(scaleReportToText(config, report));
    return;
  }

  if (subcommand === "overlay") {
    const set = await loadSet();
    const snapshotPath = option(rest, "--snapshot");
    if (!snapshotPath) {
      throw new Error(
        "market overlay requires --snapshot <canonical-snapshot.json> (fullstackgtm snapshot --out it first) — directives need CRM ground truth",
      );
    }
    const snapshot = JSON.parse(readFileSync(resolve(process.cwd(), snapshotPath), "utf8")) as CanonicalGtmSnapshot;

    // --calls accepts ParsedCall JSON files (from `call parse --out`) and/or
    // manifest arrays [{path, dealId?}] linking calls to deals. Repeatable.
    const documents: CallDocument[] = [];
    const addParsedCall = (parsedPath: string, dealId?: string) => {
      const parsed = JSON.parse(readFileSync(resolve(process.cwd(), parsedPath), "utf8")) as ParsedCall & {
        segments?: Array<{ text?: string }>;
      };
      const text = [
        ...(parsed.segments ?? []).map((segment) => segment.text ?? ""),
        ...(parsed.insights ?? []).map((insight) => `${insight.text ?? ""} ${insight.evidence ?? ""}`),
      ].join("\n");
      documents.push({ id: parsed.id ?? parsedPath, text, dealId, occurredAt: parsed.evidence?.[0]?.capturedAt });
    };
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] !== "--calls") continue;
      const callsPath = rest[i + 1];
      if (!callsPath) throw new Error("--calls needs a path");
      const raw = JSON.parse(readFileSync(resolve(process.cwd(), callsPath), "utf8"));
      if (Array.isArray(raw)) {
        for (const entry of raw as Array<{ path: string; dealId?: string }>) addParsedCall(entry.path, entry.dealId);
      } else {
        addParsedCall(callsPath);
      }
    }

    const priorLabel = option(rest, "--prior-run");
    const priorSet = priorLabel ? await store.get(priorLabel) : null;
    if (priorLabel && !priorSet) throw new Error(`No observation run "${priorLabel}" for URGENT drift`);

    const stats = computeOverlayStats(config, snapshot, documents);
    const directives = computeDirectives(config, set, stats, {
      minMentions: numericOption(rest, "--min-mentions") ?? undefined,
      promoteLift: numericOption(rest, "--promote-lift") ?? undefined,
      priorSet: priorSet ?? undefined,
    });

    if (rest.includes("--json")) {
      console.log(JSON.stringify({ stats, directives }, null, 2));
      return;
    }
    console.log(overlayToMarkdown(stats, directives));

    if (saveRequested(rest)) {
      const taskAccount = option(rest, "--task-account");
      const taskDeal = option(rest, "--task-deal");
      if (!taskAccount && !taskDeal) {
        throw new Error(
          "--save needs --task-account <id> or --task-deal <id>: directives become approval-gated create_task operations, and the CRM needs a record to hang them on (your own company's account record works well)",
        );
      }
      const plan = directivesToPlan(
        config,
        set,
        directives,
        taskDeal ? { objectType: "deal", objectId: taskDeal } : { objectType: "account", objectId: taskAccount as string },
      );
      const stored = await createFilePlanStore().save(plan);
      console.log(`Saved plan ${stored.plan.id} (${directives.length} directive task(s); approve via \`plans approve\`)`);
    }
    return;
  }

  throw unknownSubcommandError("market", subcommand, MARKET_SUBCOMMANDS);
}
