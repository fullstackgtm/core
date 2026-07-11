// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).
import { readFileSync, writeFileSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { resolveLlmCredential } from "../llm.js";
import { fitThreshold, icpFromAnswers, icpToCrustdataFilters, icpToExploriumFilters, INTERVIEW_SPEC } from "../icp.js";
import { createFileSignalStore, DEFAULT_SIGNALS_CONFIG } from "../signals.js";
import { createFileJudgeStore, DEFAULT_JUDGE_PROMPT, judgeRunId, judgeSignals } from "../judge.js";
import { DEFAULT_GOLDEN_NOW_ISO, DEFAULT_GOLDEN_SET, DEFAULT_MIN_ACCURACY, defaultJudgeFn, gradeAgainstOutcomes, gradeJudge, parseGoldenSet } from "../judgeEval.js";
import { loadIcp, numericOption, option, readSecret, readSnapshot, resolveLlmBaseUrls, saveRequested } from "./shared.js";
import { createStatusLine } from "./ui.js";
import { box, colorEnabled, paint, truncateToWidth } from "./ui.js";
import { getCredential, storeCredential } from "../credentials.js";
import { deriveWebsiteIcp, icpReviewSegments, OPENROUTER_API_BASE } from "../icpDerive.js";
import { unknownSubcommandError } from "./suggest.js";
function renderJudgeDecisions(decisions) {
    if (decisions.length === 0)
        return "No accounts cleared the score threshold.";
    const lines = [`ICP decisions (${decisions.length})`, ""];
    for (const decision of decisions) {
        const target = decision.contact?.email || decision.contact?.title;
        lines.push(`${decision.decision.toUpperCase().padEnd(7)} ${String(decision.score).padStart(3)}  ${decision.accountDomain}${target ? ` · ${target}` : ""}`);
        if (decision.whyNow)
            lines.push(`            ${decision.whyNow.replace(/\s+/g, " ").trim()}`);
        if (decision.play)
            lines.push(`            Next: ${decision.play.replace(/\s+/g, " ").trim()}`);
    }
    return lines.join("\n");
}
function updateReviewSegment(icp, id, raw) {
    const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
    if (id === "threshold")
        return { ...icp, scoring: { ...icp.scoring, threshold: Number(raw) } };
    if (["industries", "employeeBands", "geos", "technologies"].includes(id)) {
        return { ...icp, firmographics: { ...icp.firmographics, [id]: values } };
    }
    if (["titleKeywords", "jobLevels", "departments"].includes(id)) {
        return { ...icp, persona: { ...icp.persona, [id]: values } };
    }
    return { ...icp, signals: { ...icp.signals, intentTopics: values } };
}
function renderDerivedIcp(result, selected = -1) {
    const p = paint(colorEnabled());
    const segments = icpReviewSegments(result.icp);
    const contentWidth = Math.min(88, Math.max(64, (process.stdout.columns ?? 92) - 4));
    const valueWidth = contentWidth - 18;
    const segmentLines = segments.flatMap((segment, index) => {
        const words = segment.value.split(/\s+/);
        const wrapped = [];
        let line = "";
        for (const word of words) {
            if (!line || line.length + word.length + 1 <= valueWidth)
                line += `${line ? " " : ""}${word}`;
            else {
                wrapped.push(line);
                line = word;
            }
        }
        if (line)
            wrapped.push(line);
        const prefix = `${index === selected ? "›" : " "} ${segment.label.padEnd(15)} `;
        return (wrapped.length ? wrapped : ["—"]).map((value, lineIndex) => `${lineIndex === 0 ? prefix : " ".repeat(18)}${truncateToWidth(value, valueWidth)}`);
    });
    const lines = [
        truncateToWidth(`${result.company.name}  ${result.company.domain}`, contentWidth),
        `${Math.round(result.confidence * 100)}% confidence · ${result.derivation.model}`,
        "",
        ...segmentLines,
        "",
        selected >= 0 ? "↑/↓ select · enter edit · s save · q cancel" : `${result.evidence.length} website-verifiable evidence quote(s)`,
    ];
    return box(lines, p, "ICP preview").join("\n");
}
async function resolveIcpDeriveLlm(args) {
    const requested = option(args, "--provider")?.toLowerCase();
    if (requested && !["openrouter", "openai", "anthropic"].includes(requested)) {
        throw new Error(`icp derive --provider must be openrouter, openai, or anthropic; got "${requested}".`);
    }
    const openRouterKey = process.env.OPENROUTER_API_KEY ?? getCredential("openrouter")?.accessToken;
    const normal = resolveLlmCredential();
    if ((!requested || requested === "openrouter") && openRouterKey) {
        return { provider: "openai", apiKey: openRouterKey, openaiBaseUrl: OPENROUTER_API_BASE };
    }
    if (requested === "openai" || requested === "anthropic") {
        const envKey = requested === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
        const key = envKey ?? getCredential(requested)?.accessToken;
        if (key)
            return { provider: requested, apiKey: key, ...resolveLlmBaseUrls() };
    }
    if (normal && (!requested || requested === normal.provider))
        return { ...normal, ...resolveLlmBaseUrls() };
    const provider = requested;
    if (!process.stdin.isTTY || process.env.CI) {
        throw new Error("ICP derivation needs an LLM key. Run one of:\n" +
            "  fullstackgtm login openrouter\n  fullstackgtm login openai\n  fullstackgtm login anthropic\n" +
            "Then rerun the same icp derive command.");
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = provider ?? ((await rl.question("LLM provider [openrouter/openai/anthropic] (openrouter): ")).trim().toLowerCase() || "openrouter");
    rl.close();
    if (!['openrouter', 'openai', 'anthropic'].includes(answer))
        throw new Error(`Unknown LLM provider "${answer}".`);
    const selectedProvider = answer;
    const key = await readSecret(`${selectedProvider} API key`);
    if (!key)
        throw new Error(`No ${answer} API key provided.`);
    const now = new Date().toISOString();
    storeCredential(selectedProvider, { kind: "api_key", accessToken: key, createdAt: now, updatedAt: now });
    console.error(`Stored ${selectedProvider} key in the active FullStackGTM profile.`);
    return selectedProvider === "openrouter"
        ? { provider: "openai", apiKey: key, openaiBaseUrl: OPENROUTER_API_BASE }
        : { provider: selectedProvider, apiKey: key };
}
async function reviewDerivedIcp(result) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
        return result;
    let current = result;
    let selected = 0;
    let paintedLines = 0;
    const render = (promptLines = 0) => {
        const output = renderDerivedIcp(current, selected);
        if (paintedLines > 0)
            process.stdout.write(`\u001b[${paintedLines + promptLines}A\r\u001b[0J`);
        process.stdout.write(`${output}\n`);
        paintedLines = output.split("\n").length;
    };
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    render();
    return new Promise((resolveReview) => {
        const finish = (value) => {
            process.stdin.off("keypress", onKey);
            process.stdin.setRawMode?.(false);
            process.stdin.pause();
            resolveReview(value);
        };
        const onKey = async (_input, key) => {
            const segments = icpReviewSegments(current.icp);
            if (key.ctrl && key.name === "c" || key.name === "q")
                return finish(null);
            if (key.name === "up") {
                selected = (selected - 1 + segments.length) % segments.length;
                return render();
            }
            if (key.name === "down") {
                selected = (selected + 1) % segments.length;
                return render();
            }
            if (key.name === "s")
                return finish(current);
            if (key.name !== "return")
                return;
            process.stdin.off("keypress", onKey);
            process.stdin.setRawMode?.(false);
            const segment = segments[selected];
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            const answer = await rl.question(`\n${segment.label} [${segment.value}]: `);
            rl.close();
            if (answer.trim())
                current = { ...current, icp: updateReviewSegment(current.icp, segment.id, answer) };
            emitKeypressEvents(process.stdin);
            // readline.close() pauses its input stream. Resume it before restoring
            // raw keypress handling or Node sees no active input and exits after the
            // first field edit instead of returning to the ICP review card.
            process.stdin.resume();
            process.stdin.setRawMode?.(true);
            process.stdin.on("keypress", onKey);
            render(2);
        };
        process.stdin.on("keypress", onKey);
    });
}
/**
 * `icp` — develop and inspect the Ideal Customer Profile that targets acquire.
 * The CLI can't run AskUserQuestion itself; `icp interview` emits the question
 * spec an agent (Claude Code / Codex) drives with its AskUserQuestion tool, then
 * `icp set` writes icp.json from the collected answers.
 */
export async function icpCommand(args) {
    const [sub, ...rest] = args;
    // Help-before-network: catch --help/-h anywhere in argv (so `icp --help`,
    // `icp judge --help`, `icp eval --help` all print usage before any work).
    if (!sub || args.includes("--help") || args.includes("-h")) {
        console.log(`Usage:
  fullstackgtm icp interview                      emit the interview spec (an agent drives it with AskUserQuestion)
  fullstackgtm icp derive --domain <site> [--model <id>] [--out icp.json] [--json]
                                                derive an evidence-backed ICP from a public website (OpenRouter/OpenAI/Anthropic)
  fullstackgtm icp set <answers.json> [--name <n>] [--out <path>]   write icp.json from interview answers
  fullstackgtm icp show [--icp <path>]            render the ICP + the discovery filters it produces
  fullstackgtm icp judge [--signals-from latest|<label>] [--with-history] [--prompt <path>] [--min-score 0] [--save]   rank unjudged signals into send/nurture/skip decisions (timing x fit x memory)
  fullstackgtm icp eval [--golden <path>|default] [--against-outcomes] [--min-accuracy 0.8] [--json]   grade the judge: golden-set accuracy and/or hot>cold calibration; exits 2 below the bar

The ICP makes \`enrich acquire\` targeted, not random: it generates each
provider's discovery filters (Explorium, pipe0/Crustdata) AND scores every
discovered prospect for fit — only above-threshold leads become create_record
ops. Develop one by interview, then \`enrich acquire\` picks up ./icp.json.
\`icp judge\` ranks fresh signals (from \`signals fetch --save\`) into send/nurture/skip;
\`icp eval\` is the probabilistic-judgment gate before any apply.`);
        return;
    }
    if (sub === "interview") {
        console.log(JSON.stringify({
            questions: INTERVIEW_SPEC,
            instructions: "Ask each question with AskUserQuestion (multiSelect per .multiSelect). For each answer, collect the chosen options' .value arrays and concat them under the question's .id. Then run `fullstackgtm icp set <answers.json>` with that flattened object.",
        }, null, 2));
        return;
    }
    if (sub === "derive") {
        const domain = option(rest, "--domain");
        if (!domain)
            throw new Error("Usage: fullstackgtm icp derive --domain <company.com> [--out icp.json] [--json]");
        const llm = await resolveIcpDeriveLlm(rest);
        const status = createStatusLine();
        let derived;
        try {
            derived = await deriveWebsiteIcp({
                domain,
                llm,
                model: option(rest, "--model") ?? undefined,
                onProgress: (event) => status.set(event.message),
            });
        }
        finally {
            status.done();
        }
        const reviewedInteractively = !rest.includes("--json") && !rest.includes("--no-interactive") && Boolean(process.stdin.isTTY && process.stdout.isTTY);
        if (!rest.includes("--json") && !rest.includes("--no-interactive")) {
            const reviewed = await reviewDerivedIcp(derived);
            if (!reviewed)
                throw new Error("ICP review cancelled; no file was written.");
            derived = reviewed;
        }
        const out = option(rest, "--out");
        if (out) {
            const path = resolve(process.cwd(), out);
            writeFileSync(path, `${JSON.stringify(derived.icp, null, 2)}\n`);
            console.error(`Wrote reviewed ICP to ${path}. Next: fullstackgtm enrich acquire --source clay --icp ${path}`);
        }
        if (rest.includes("--json"))
            console.log(JSON.stringify(derived, null, 2));
        else if (!reviewedInteractively)
            console.log(renderDerivedIcp(derived));
        return;
    }
    if (sub === "set") {
        const file = rest.find((a) => !a.startsWith("--"));
        if (!file)
            throw new Error("Usage: fullstackgtm icp set <answers.json> [--name <n>] [--out <path>]");
        const answers = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
        const icp = icpFromAnswers(option(rest, "--name") ?? "ICP", answers);
        const out = resolve(process.cwd(), option(rest, "--out") ?? "icp.json");
        writeFileSync(out, `${JSON.stringify(icp, null, 2)}\n`);
        console.log(`Wrote ${out} — ${icp.persona.titleKeywords?.length ?? 0} title keyword(s), ` +
            `${icp.firmographics.employeeBands?.length ?? 0} size band(s), fit threshold ${fitThreshold(icp)}.`);
        return;
    }
    if (sub === "show") {
        const icp = loadIcp(rest);
        if (!icp)
            throw new Error("No ICP found (icp.json in cwd, or pass --icp <path>). Build one: fullstackgtm icp interview.");
        console.log(JSON.stringify({
            icp,
            exploriumFilters: icpToExploriumFilters(icp),
            crustdataFilters: icpToCrustdataFilters(icp),
            fitThreshold: fitThreshold(icp),
        }, null, 2));
        return;
    }
    if (sub === "judge") {
        // The parent icpCommand already caught --help/-h before any work, so we can
        // flag-parse then act (no network until judgeSignals, and only with a key).
        const signalsFrom = option(rest, "--signals-from") ?? "latest";
        const withHistory = rest.includes("--with-history");
        const promptPath = option(rest, "--prompt");
        const minScore = numericOption(rest, "--min-score") ?? 0;
        const save = saveRequested(rest);
        // 1) Load signals from the signal store.
        const signalStore = createFileSignalStore();
        const signalRun = signalsFrom === "latest" ? await signalStore.latestRun() : await signalStore.getRun(signalsFrom);
        if (!signalRun) {
            throw new Error(`No signal run "${signalsFrom}" — run \`fullstackgtm signals fetch --save\` first.`);
        }
        const unjudged = signalRun.signals.filter((s) => !s.judgedBy);
        if (unjudged.length === 0)
            throw new Error(`Signal run "${signalRun.runLabel}" has no unjudged signals.`);
        // 2) Optional inputs: ICP (may be undefined), snapshot, outcomes + config.
        //    The snapshot is loaded whenever a source is given (--provider/--input/
        //    --demo/--sample) — it resolves each decision's CRM target (accountId +
        //    best contact) so `draft` can write against a real record. --with-history
        //    additionally enables the memory + fit scoring inputs.
        const icp = loadIcp(rest);
        const config = DEFAULT_SIGNALS_CONFIG;
        const outcomes = await signalStore.listOutcomes();
        const hasSnapshotSource = Boolean(option(rest, "--provider")) ||
            Boolean(option(rest, "--input")) ||
            rest.includes("--demo") ||
            rest.includes("--sample");
        const snapshot = withHistory || hasSnapshotSource ? await readSnapshot(rest) : undefined;
        // 3) Resolve the LLM seam ONLY if a key already exists (deterministic baseline
        //    otherwise — never PROMPT here; judge must run key-free).
        const cred = resolveLlmCredential();
        const baseUrls = resolveLlmBaseUrls();
        const model = option(rest, "--model") ?? undefined;
        const llm = cred
            ? { ...cred, ...baseUrls, ...(model ? { model } : {}) }
            : undefined;
        const promptTemplate = llm
            ? promptPath
                ? readFileSync(resolve(process.cwd(), promptPath), "utf8")
                : DEFAULT_JUDGE_PROMPT
            : undefined;
        // 4) Judge. Interactive terminals get a per-account stderr status line
        // (LLM judging is the slow path); inert otherwise.
        const judgeStatus = createStatusLine();
        let decisions;
        try {
            decisions = await judgeSignals({
                signals: unjudged,
                outcomes,
                config,
                icp,
                snapshot,
                withHistory,
                promptTemplate,
                llm,
                onAccount: judgeStatus.active
                    ? (done, total, domain) => judgeStatus.set(`Judging account ${done + 1}/${total} · ${domain}${llm ? ` · ${llm.provider}` : " · deterministic"}`)
                    : undefined,
            });
        }
        finally {
            judgeStatus.done();
        }
        decisions = decisions.filter((d) => d.score >= minScore);
        // 5) Ranked decisions to stdout (JSON), guidance to stderr.
        console.log(rest.includes("--json") || rest.includes("--verbose") ? JSON.stringify(decisions, null, 2) : renderJudgeDecisions(decisions));
        console.error(`Judged ${unjudged.length} signal(s) across ${new Set(decisions.map((d) => d.accountDomain)).size} account(s): ` +
            `${decisions.filter((d) => d.decision === "send").length} send, ` +
            `${decisions.filter((d) => d.decision === "nurture").length} nurture, ` +
            `${decisions.filter((d) => d.decision === "skip").length} skip` +
            `${llm ? "" : " (deterministic — no LLM key; run `login anthropic|openai` for why-now + play)"}.`);
        // 6) --save: persist a JudgeRun + stamp consumed signals judgedBy.
        if (save) {
            const runLabel = option(rest, "--label") ?? `judge-${new Date().toISOString().slice(0, 10)}`;
            const store = createFileJudgeStore();
            await store.appendRun({
                id: judgeRunId(runLabel),
                runLabel,
                signalRunLabel: signalRun.runLabel,
                createdAt: new Date().toISOString(),
                decisions,
            });
            const judgedIds = new Set(decisions.flatMap((d) => d.evidence));
            for (const s of signalRun.signals)
                if (judgedIds.has(s.id))
                    s.judgedBy = runLabel;
            await signalStore.updateRun(signalRun);
            console.error(`Saved judge run "${runLabel}" (${decisions.length} decisions); stamped ${judgedIds.size} signals judgedBy. ` +
                `Next: \`fullstackgtm draft --from-judge ${runLabel} --save\`.`);
        }
        else {
            console.error("(not saved — re-run with --save to persist a judge run and stamp the consumed signals)");
        }
        return;
    }
    if (sub === "eval") {
        // The parent icpCommand already caught --help/-h before any work. The whole
        // command is read-only: it grades, never emits a plan, never touches a provider.
        const goldenArg = option(rest, "--golden") ?? "default";
        const againstOutcomes = rest.includes("--against-outcomes");
        const minAccuracy = numericOption(rest, "--min-accuracy") ?? DEFAULT_MIN_ACCURACY;
        const asJson = rest.includes("--json");
        if (againstOutcomes) {
            // The empirical gate: hot decisions must book strictly more than cold.
            const judgeStore = createFileJudgeStore();
            const labelArg = option(rest, "--from-judge");
            const judgeRun = labelArg ? await judgeStore.getRun(labelArg) : await judgeStore.latestRun();
            if (!judgeRun) {
                throw new Error(`No judge run ${labelArg ? `"${labelArg}"` : "to grade"} — run \`fullstackgtm icp judge --save\` first.`);
            }
            const outcomes = await createFileSignalStore().listOutcomes();
            const cal = gradeAgainstOutcomes(judgeRun.decisions, outcomes);
            if (asJson) {
                console.log(JSON.stringify(cal, null, 2));
            }
            else {
                console.log(`Outcome calibration (judge run "${judgeRun.runLabel}"):\n` +
                    `  hot book rate:  ${(cal.hotBookRate * 100).toFixed(1)}% over ${cal.hotCount} hot account(s)\n` +
                    `  cold book rate: ${(cal.coldBookRate * 100).toFixed(1)}% over ${cal.coldCount} cold account(s)\n` +
                    `  calibrated:     ${cal.calibrated ? "yes (hot > cold)" : "NO (hot did not strictly beat cold)"}`);
            }
            console.error(cal.calibrated
                ? "Calibrated: hot scores book strictly more than cold — the judge earns its interrupt."
                : "NOT calibrated: hot did not strictly beat cold. Tune the rubric before scheduling apply behind this gate.");
            if (!cal.calibrated)
                process.exitCode = 2;
            return;
        }
        // The golden-set gate (default). Resolve "default" BEFORE any file read.
        // The default set is graded on its own pinned clock (its firstSeen stamps
        // are relative to DEFAULT_GOLDEN_NOW_ISO) — wall time would let freshness
        // decay flip the "fresh → send" rows as the calendar advances.
        const rows = goldenArg === "default"
            ? DEFAULT_GOLDEN_SET
            : parseGoldenSet(readFileSync(resolve(process.cwd(), goldenArg), "utf8"));
        const gradeNow = goldenArg === "default" ? new Date(DEFAULT_GOLDEN_NOW_ISO) : new Date();
        const result = await gradeJudge(rows, defaultJudgeFn({ icp: loadIcp(rest), now: gradeNow }));
        if (asJson) {
            console.log(JSON.stringify(result, null, 2));
        }
        else {
            const c = result.confusion;
            console.log(`Golden-set grade (${rows.length} row(s)):\n` +
                `  accuracy:  ${(result.accuracy * 100).toFixed(1)}%  (bar ${(minAccuracy * 100).toFixed(0)}%)\n` +
                `  precision: ${(result.precision * 100).toFixed(1)}%\n` +
                `  recall:    ${(result.recall * 100).toFixed(1)}%\n` +
                `  confusion: tp=${c.truePositive} fp=${c.falsePositive} tn=${c.trueNegative} fn=${c.falseNegative}`);
        }
        if (result.accuracy < minAccuracy) {
            console.error(`Judge accuracy ${(result.accuracy * 100).toFixed(1)}% is below the ${(minAccuracy * 100).toFixed(0)}% bar — exit 2.`);
            process.exitCode = 2;
        }
        else {
            console.error(`Judge passes the golden-set gate (${(result.accuracy * 100).toFixed(1)}% >= ${(minAccuracy * 100).toFixed(0)}%).`);
        }
        return;
    }
    throw unknownSubcommandError("icp", sub, ["interview", "set", "show", "judge", "eval"]);
}
