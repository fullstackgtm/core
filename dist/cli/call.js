// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { patchPlanToMarkdown } from "../format.js";
import { createFilePlanStore } from "../planStore.js";
import { normalizeTranscript, parseCall, suggestCallDeal } from "../calls.js";
import { classifyCall, rubricForCallType, rubricPresets, CALL_TYPES, CALL_TYPE_IDS } from "../callTypes.js";
import { DEFAULT_RUBRIC, classifyCallLlm, extractInsightsLlm, parseRubric, resolveLlmCredential, scoreCallLlm } from "../llm.js";
import { option, readSnapshot, requireLlmCredential, saveRequested } from "./shared.js";
import { startElapsedStatus } from "./ui.js";
export async function callCommand(args) {
    const [subcommand, ...rest] = args;
    if (args.includes("--help") || args.includes("-h")) {
        console.log(`call parse    --transcript <file> [--title t] [--source s] [--model m] [--deterministic] [--json|--ndjson] [--out <path>]
call classify --transcript <file>|--call <parsed.json> [--llm] [--deterministic] [--json] [--list]
call score    --transcript <file>|--call <parsed.json> [--call-type <t>] [--rubric <rubric.json>] [--model m] [--json|--out <path>] [--list-rubrics]
call link     --attendees <a@x.com,...> | --domain <x.com>  [source options] [--json]
call plan     --transcript <file>|--call <parsed.json> --deal <id> [source options] [--save|--json]

classify picks the call type (deterministic signals; --llm for a model tiebreak).
score auto-selects the type-specific rubric from that classification unless you
pass --call-type or --rubric. Call types: ${CALL_TYPE_IDS.join(", ")}.

parse/score default to LLM extraction (Anthropic or OpenAI key via env,
\`login anthropic|openai\`, or a one-time prompt). parse --deterministic is the
free keyword baseline and classify --deterministic needs no key.
score always needs a key (scoring is LLM work).`);
        return;
    }
    const loadParsedCall = async () => {
        const callPath = option(rest, "--call");
        if (callPath) {
            return JSON.parse(readFileSync(resolve(process.cwd(), callPath), "utf8"));
        }
        const transcriptPath = option(rest, "--transcript");
        if (!transcriptPath)
            throw new Error(`call ${subcommand} requires --transcript <file> or --call <parsed.json>`);
        const raw = readFileSync(resolve(process.cwd(), transcriptPath), "utf8");
        const source = option(rest, "--source");
        const base = {
            title: option(rest, "--title") ?? undefined,
            sourceSystem: source,
            capturedAt: new Date().toISOString(),
        };
        if (rest.includes("--deterministic")) {
            return parseCall(raw, base);
        }
        // LLM extraction is the default: bring-your-own-key (Anthropic or OpenAI).
        const credential = await requireLlmCredential();
        const normalized = normalizeTranscript(raw);
        // Elapsed-time spinner on interactive terminals while the model works.
        const wait = startElapsedStatus((elapsed) => `Extracting insights · ${credential.provider} · ${elapsed}`);
        let extraction;
        try {
            extraction = await extractInsightsLlm(normalized, {
                ...credential,
                model: option(rest, "--model") ?? undefined,
                title: base.title,
            });
        }
        finally {
            wait.done();
        }
        const { insights, model } = extraction;
        return parseCall(raw, {
            ...base,
            insights,
            extractor: `llm:${credential.provider}:${model}`,
        });
    };
    // Reconstruct plain transcript text from either a --transcript file (any
    // dialect, normalized) or a parsed --call JSON. Shared by classify + score.
    const loadTranscriptText = () => {
        const transcriptPath = option(rest, "--transcript");
        if (transcriptPath) {
            return normalizeTranscript(readFileSync(resolve(process.cwd(), transcriptPath), "utf8"));
        }
        const callPath = option(rest, "--call");
        if (!callPath)
            throw new Error(`call ${subcommand} requires --transcript <file> or --call <parsed.json>`);
        const parsed = JSON.parse(readFileSync(resolve(process.cwd(), callPath), "utf8"));
        return parsed.segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join("\n");
    };
    if (subcommand === "classify") {
        if (rest.includes("--list")) {
            const lines = CALL_TYPES.map((d) => `${d.id.padEnd(22)} ${d.name} — ${d.definition}`);
            console.log(rest.includes("--json") ? JSON.stringify(CALL_TYPES, null, 2) : lines.join("\n"));
            return;
        }
        const transcriptText = loadTranscriptText();
        const title = option(rest, "--title") ?? undefined;
        const deterministic = classifyCall(transcriptText);
        // LLM tiebreak: explicit --llm, or auto when the deterministic pass is unsure
        // and a key is available (never required — deterministic always answers).
        const wantLlm = rest.includes("--llm") || (!rest.includes("--deterministic") && deterministic.confidence !== "high" && Boolean(resolveLlmCredential()));
        let result = deterministic;
        if (wantLlm) {
            const credential = await requireLlmCredential("score");
            const llm = await classifyCallLlm(transcriptText, CALL_TYPES, {
                ...credential,
                model: option(rest, "--model") ?? undefined,
                title,
            });
            result = { type: llm.type, confidence: "high", reason: llm.reason, method: "llm", model: llm.model };
        }
        if (rest.includes("--json")) {
            console.log(JSON.stringify(result, null, 2));
            return;
        }
        const def = CALL_TYPES.find((d) => d.id === result.type);
        console.log(`Call type: ${def?.name ?? result.type} (${result.type})`);
        console.log(`Confidence: ${result.confidence} · via ${result.method}${result.model ? ` (${result.model})` : ""}`);
        console.log(`Why: ${result.reason}`);
        if (result.method === "deterministic" && deterministic.candidates.length > 1) {
            const others = deterministic.candidates.slice(1, 4).map((c) => `${c.type} (${c.score})`).join(", ");
            console.log(`Other matches: ${others}`);
        }
        console.log(`\nScore it with this rubric: fullstackgtm call score ${option(rest, "--transcript") ? `--transcript ${option(rest, "--transcript")}` : `--call ${option(rest, "--call")}`} --call-type ${result.type}`);
        return;
    }
    if (subcommand === "parse") {
        const parsed = await loadParsedCall();
        const outPath = option(rest, "--out");
        if (outPath)
            writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(parsed, null, 2)}\n`);
        if (rest.includes("--ndjson")) {
            // One flat row per insight — warehouse-friendly (e.g. Snowflake COPY).
            for (const insight of parsed.insights) {
                console.log(JSON.stringify({
                    call_id: parsed.id,
                    call_title: parsed.title ?? null,
                    source_system: parsed.sourceSystem,
                    extractor: parsed.extractor,
                    type: insight.type,
                    title: insight.title,
                    text: insight.text,
                    evidence: insight.evidence,
                    speaker: insight.speaker ?? null,
                    confidence: insight.confidence,
                    importance: insight.importance,
                }));
            }
            return;
        }
        if (rest.includes("--json") || outPath) {
            if (!outPath)
                console.log(JSON.stringify(parsed, null, 2));
            return;
        }
        console.log(`Call ${parsed.id}${parsed.title ? ` — ${parsed.title}` : ""} (${parsed.sourceSystem})`);
        console.log(`${parsed.segments.length} segments · ${parsed.insights.length} insights (${parsed.summary.highImportance} high-importance)\n`);
        for (const insight of parsed.insights) {
            console.log(`[${insight.type}] (importance ${insight.importance}) ${insight.text}`);
        }
        return;
    }
    if (subcommand === "link") {
        const attendees = option(rest, "--attendees");
        const domain = option(rest, "--domain");
        if (!attendees && !domain)
            throw new Error("call link requires --attendees <emails,comma-separated> and/or --domain <example.com>");
        const snapshot = await readSnapshot(rest);
        const suggestion = suggestCallDeal(snapshot, {
            attendeeEmails: attendees?.split(",").map((e) => e.trim()).filter(Boolean),
            domain: domain ?? undefined,
        });
        if (rest.includes("--json")) {
            console.log(JSON.stringify(suggestion, null, 2));
        }
        else {
            const marker = suggestion.confidence === "high" ? "✓" : suggestion.confidence === "low" ? "~" : "✗";
            console.log(`${marker} [${suggestion.confidence}] ${suggestion.dealId ?? "no match"}${suggestion.dealName ? ` — ${suggestion.dealName}` : ""}`);
            console.log(`    ${suggestion.reason}`);
        }
        if (suggestion.confidence === "none")
            process.exitCode = 1;
        return;
    }
    if (subcommand === "plan") {
        const dealId = option(rest, "--deal");
        if (!dealId)
            throw new Error("call plan requires --deal <dealId> (use `call link` to find it)");
        const parsed = await loadParsedCall();
        const snapshot = await readSnapshot(rest);
        const deal = snapshot.deals.find((row) => row.id === dealId);
        if (!deal)
            throw new Error(`Deal ${dealId} is not in the snapshot — check the id or the snapshot source.`);
        const nextSteps = parsed.insights.filter((insight) => insight.type === "next_step");
        if (nextSteps.length === 0) {
            console.log("No next-step insights in this call — nothing to plan. (Other insight types are evidence, not writes.)");
            return;
        }
        const [top, ...others] = nextSteps;
        const proposed = top.text.trim().slice(0, 255);
        const current = deal.nextStep?.trim() ?? "";
        const plan = buildCallPlan(parsed, deal, proposed, current, others.slice(0, 3));
        if (saveRequested(rest)) {
            await createFilePlanStore().save(plan);
            console.log(`Saved plan ${plan.id}. Review with \`fullstackgtm plans show ${plan.id}\`, approve with \`fullstackgtm plans approve ${plan.id} --operations <ids|all>\`, then \`fullstackgtm apply --plan-id ${plan.id} --provider <name>\`.`);
            return;
        }
        console.log(rest.includes("--json") ? JSON.stringify(plan, null, 2) : patchPlanToMarkdown(plan));
        return;
    }
    if (subcommand === "score") {
        if (rest.includes("--list-rubrics")) {
            console.log(JSON.stringify(rubricPresets(), null, 2));
            return;
        }
        // Explicit-rubric problems surface before any credential or API work.
        const rubricPath = option(rest, "--rubric");
        let rubric;
        if (rubricPath) {
            const rubricRaw = readFileSync(resolve(process.cwd(), rubricPath), "utf8");
            try {
                rubric = parseRubric(rubricRaw);
            }
            catch (error) {
                throw new Error(`${rubricPath} is not a valid rubric: ${error instanceof Error ? error.message : String(error)} Expected JSON like { "scale": 5, "dimensions": [{ "name": "...", "weight": 1, "rubric": "..." }] }.`);
            }
        }
        const callTypeOpt = option(rest, "--call-type");
        if (callTypeOpt && !CALL_TYPE_IDS.includes(callTypeOpt)) {
            throw new Error(`Unknown --call-type "${callTypeOpt}". One of: ${CALL_TYPE_IDS.join(", ")}.`);
        }
        const credential = await requireLlmCredential("score");
        const transcriptPath = option(rest, "--transcript");
        let transcriptText;
        let title = option(rest, "--title") ?? undefined;
        if (transcriptPath) {
            transcriptText = normalizeTranscript(readFileSync(resolve(process.cwd(), transcriptPath), "utf8"));
        }
        else {
            const callPath = option(rest, "--call");
            if (!callPath)
                throw new Error("call score requires --transcript <file> or --call <parsed.json>");
            const parsed = JSON.parse(readFileSync(resolve(process.cwd(), callPath), "utf8"));
            transcriptText = parsed.segments
                .map((segment) => (segment.speaker ? `${segment.speaker}: ${segment.text}` : segment.text))
                .join("\n");
            title = title ?? parsed.title;
        }
        // Rubric selection: explicit --rubric wins, then --call-type, else the
        // deterministic classifier picks the type-specific preset. No generic
        // discovery rubric silently applied to a renewal anymore.
        if (!rubric) {
            const type = callTypeOpt ?? classifyCall(transcriptText).type;
            rubric = rubricForCallType(type, DEFAULT_RUBRIC);
            if (!rest.includes("--json")) {
                const how = callTypeOpt ? `--call-type ${callTypeOpt}` : `auto-classified as ${type}`;
                console.error(`Scoring with the "${rubric.name ?? "Generic"}" rubric (${how}). Override with --rubric <file> or --call-type <type>.`);
            }
        }
        const scoreWait = startElapsedStatus((elapsed) => `Scoring against "${rubric?.name ?? "Generic"}" · ${credential.provider} · ${elapsed}`);
        let scorecard;
        try {
            scorecard = await scoreCallLlm(transcriptText, rubric, {
                ...credential,
                model: option(rest, "--model") ?? undefined,
                title,
            });
        }
        finally {
            scoreWait.done();
        }
        const outPath = option(rest, "--out");
        if (outPath)
            writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(scorecard, null, 2)}\n`);
        if (rest.includes("--json")) {
            console.log(JSON.stringify(scorecard, null, 2));
            return;
        }
        console.log(renderScorecard(scorecard, title));
        return;
    }
    throw new Error(`call supports: parse, classify, link, plan, score (got ${subcommand ?? "nothing"})`);
}
function renderScorecard(scorecard, title) {
    const bandText = scorecard.band ? ` — ${scorecard.band.label}` : "";
    const rubricLine = scorecard.rubricName ? `Rubric: ${scorecard.rubricName}${scorecard.callType ? ` (${scorecard.callType})` : ""}` : "";
    const lines = [
        `# Coaching Scorecard${title ? ` — ${title}` : ""}`,
        "",
        `**Overall: ${scorecard.overallScore}/${scorecard.scale}${bandText}** (model: ${scorecard.model})`,
        ...(scorecard.band?.meaning ? [`> ${scorecard.band.meaning}`] : []),
        ...(rubricLine ? ["", `_${rubricLine}_`] : []),
        "",
        "| Dimension | Score | | Coaching note |",
        "| --- | --- | --- | --- |",
    ];
    for (const dim of scorecard.dimensions) {
        const filled = Math.round((dim.score / dim.maxScore) * 5);
        const bar = "█".repeat(filled) + "░".repeat(5 - filled);
        lines.push(`| ${dim.name} | ${dim.score}/${dim.maxScore} | ${bar} | ${dim.coachingNote} |`);
    }
    if (scorecard.highlights.length) {
        lines.push("", "**Highlights**");
        for (const h of scorecard.highlights)
            lines.push(`- ${h}`);
    }
    if (scorecard.missedItems.length) {
        lines.push("", "**Missed**");
        for (const m of scorecard.missedItems)
            lines.push(`- ${m}`);
    }
    return lines.join("\n");
}
function buildCallPlan(parsed, deal, proposed, current, extraNextSteps) {
    const findings = [];
    const operations = [];
    const nextStepEvidence = parsed.evidence.filter((item) => item.metadata?.insightType === "next_step");
    const evidenceIds = nextStepEvidence.map((item) => item.id);
    if (current.toLowerCase() !== proposed.toLowerCase()) {
        findings.push({
            id: `finding_${parsed.id.replace(/^call_/, "")}_${deal.id}`,
            objectType: "deal",
            objectId: deal.id,
            ruleId: "call-next-step-not-reflected-in-crm",
            type: "call_next_step_not_reflected_in_crm",
            title: "Call agreed a next step the CRM does not reflect",
            severity: "warning",
            summary: current
                ? `The call produced "${proposed}" but ${deal.name}'s next step still reads "${current}".`
                : `The call produced "${proposed}" but ${deal.name} has no next step set.`,
            recommendation: "Review the evidence and approve the next-step update.",
            evidenceIds,
            currentCrmValue: current || null,
            proposedValue: proposed,
        });
        operations.push({
            id: `op_${parsed.id.replace(/^call_/, "")}_next`,
            objectType: "deal",
            objectId: deal.id,
            operation: "set_field",
            field: "nextStep",
            beforeValue: current || null,
            afterValue: proposed,
            reason: `Call evidence: ${nextStepEvidence[0]?.text.slice(0, 200) ?? proposed}`,
            sourceRuleOrPolicy: "call_intelligence.next_step",
            riskLevel: "high",
            approvalRequired: true,
            rollback: "Restore the previous deal next step (the before value) if the update is wrong.",
            evidenceIds,
        });
    }
    for (const [index, extra] of extraNextSteps.entries()) {
        operations.push({
            id: `op_${parsed.id.replace(/^call_/, "")}_task${index}`,
            objectType: "deal",
            objectId: deal.id,
            operation: "create_task",
            field: "follow_up_task",
            beforeValue: null,
            afterValue: extra.text.trim().slice(0, 255),
            reason: `Additional commitment from the call: ${extra.evidence.slice(0, 160)}`,
            sourceRuleOrPolicy: "call_intelligence.follow_up",
            riskLevel: "low",
            approvalRequired: true,
            rollback: "Close or delete the created task.",
        });
    }
    return {
        id: `patch_plan_${parsed.id.replace(/^call_/, "")}${deal.id.slice(-4)}`,
        title: `Call evidence plan${parsed.title ? ` — ${parsed.title}` : ""} → ${deal.name}`,
        createdAt: new Date().toISOString(),
        status: "needs_approval",
        dryRun: true,
        summary: `${findings.length} finding(s) and ${operations.length} proposed operation(s) from call ${parsed.id}.`,
        findings,
        evidence: parsed.evidence,
        operations,
    };
}
