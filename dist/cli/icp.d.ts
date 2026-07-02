/**
 * `icp` — develop and inspect the Ideal Customer Profile that targets acquire.
 * The CLI can't run AskUserQuestion itself; `icp interview` emits the question
 * spec an agent (Claude Code / Codex) drives with its AskUserQuestion tool, then
 * `icp set` writes icp.json from the collected answers.
 */
export declare function icpCommand(args: string[]): Promise<void>;
