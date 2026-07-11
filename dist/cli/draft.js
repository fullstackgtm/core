// Extracted verbatim from src/cli.ts (mechanical split, no behavior change).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFilePlanStore } from "../planStore.js";
import { resolveLlmCredential } from "../llm.js";
import { createFileSignalStore } from "../signals.js";
import { createFileJudgeStore } from "../judge.js";
import { authorOpeners, DEFAULT_DRAFT_PROMPT, DRAFT_CHANNELS, draft } from "../draft.js";
import { numericOption, option, resolveLlmBaseUrls, saveRequested } from "./shared.js";
import { compactPlan, verbosePlanRequested } from "./planOutput.js";
/**
 * `draft` — author ONE trigger-grounded opener per hot judge decision as a
 * governed create_task plan. Structurally a proposal: never sends, never writes
 * a CRM record. With --save the plan is staged needs_approval for plans approve
 * -> apply.
 */
export async function draftCommand(args) {
    // Help-before-network: catch --help/-h BEFORE any config/credential/LLM call.
    if (args.includes("--help") || args.includes("-h")) {
        console.log(`Usage:
  fullstackgtm draft [--from-judge latest|<runLabel>] [--min-score 80] [--prompt <path>] [--channel email|linkedin|task] [--save]

Author one trigger-grounded opener per hot judge decision (decision=send,
score>=min) as a governed create_task plan. The opener's first line must contain
a verbatim span of the why-now trigger or the draft is rejected. Never sends —
--save stages a needs_approval plan for \`plans approve\` -> \`apply\`. Without an
LLM key it emits a clearly-labeled stub rather than fake authored copy.`);
        return;
    }
    const fromJudge = option(args, "--from-judge") ?? "latest";
    const minScore = numericOption(args, "--min-score") ?? 80;
    const promptPath = option(args, "--prompt");
    const channelArg = option(args, "--channel") ?? "task";
    if (!DRAFT_CHANNELS.includes(channelArg)) {
        throw new Error(`--channel must be one of ${DRAFT_CHANNELS.join(", ")} (got "${channelArg}").`);
    }
    const channel = channelArg;
    const save = saveRequested(args);
    // Load the JudgeRun.
    const judgeStore = createFileJudgeStore();
    const judgeRun = fromJudge === "latest" ? await judgeStore.latestRun() : await judgeStore.getRun(fromJudge);
    if (!judgeRun) {
        throw new Error(`No judge run "${fromJudge}" — run \`fullstackgtm icp judge --save\` first.`);
    }
    // Rebuild the signalsById map the openers ground in: from the referenced signal
    // run, falling back to every stored signal.
    const signalStore = createFileSignalStore();
    const signalRun = await signalStore.getRun(judgeRun.signalRunLabel);
    const signals = signalRun ? signalRun.signals : await signalStore.allSignals();
    const signalsById = new Map(signals.map((s) => [s.id, s]));
    // LLM resolution (optional — no-key path is the honestly-degraded stub).
    const cred = resolveLlmCredential();
    const model = option(args, "--model") ?? undefined;
    const llm = cred
        ? { ...cred, ...resolveLlmBaseUrls(), ...(model ? { model } : {}) }
        : undefined;
    const promptTemplate = promptPath ? readFileSync(resolve(process.cwd(), promptPath), "utf8") : DEFAULT_DRAFT_PROMPT;
    const openers = await authorOpeners({
        decisions: judgeRun.decisions,
        signalsById,
        minScore,
        promptTemplate,
        llm,
    });
    const { plan, drafts, rejected } = draft({
        decisions: judgeRun.decisions,
        signalsById,
        minScore,
        channel,
        openers,
    });
    if (args.includes("--json")) {
        console.log(JSON.stringify({ drafts, rejected }, null, 2));
    }
    else if (verbosePlanRequested(args)) {
        console.log(JSON.stringify({ drafts, rejected }, null, 2));
        console.log(compactPlan(plan, { saved: save }));
    }
    else {
        console.log(compactPlan(plan, { saved: save }));
    }
    const stale = drafts.filter((d) => d.staleTrigger);
    console.error(`${drafts.length} opener(s) staged as create_task proposals (channel ${channel}, min score ${minScore})` +
        `${rejected.length ? `; ${rejected.length} rejected (ungrounded first line)` : ""}` +
        `${stale.length ? `; ${stale.length} flagged staleTrigger` : ""}` +
        `${llm ? "" : " — DETERMINISTIC stub (no LLM key)"}. A draft is a proposal; nothing is sent.`);
    if (save) {
        await createFilePlanStore().save(plan);
        console.error(`Saved plan ${plan.id} (status ${plan.status}). Review: \`fullstackgtm plans show ${plan.id}\`, ` +
            `then \`fullstackgtm plans approve ${plan.id} --operations all\` and either ` +
            `\`fullstackgtm apply --plan-id ${plan.id} --provider <name>\` (log the touch as a CRM task) or ` +
            `\`fullstackgtm apply --plan-id ${plan.id} --channel outbox\` (render to the outbox for a sender — transmits nothing).`);
    }
    else {
        console.error("(not saved — re-run with --save to stage the plan for plans approve -> apply)");
    }
}
