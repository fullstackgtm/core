/**
 * The schedule layer (spec: docs/schedule.md in the monorepo): declare once
 * that a fullstackgtm command should run on a cadence, materialize the timers
 * through a provider (MVP: the user crontab), and keep an append-only run
 * history. Horizontal on purpose — no feature namespace owns cron logic.
 *
 * The governance invariant: **scheduling never auto-approves.** Schedulable
 * commands are read/plan-side; `apply` is schedulable only as
 * `apply --plan-id <id>` and the plan's approved status is re-checked at
 * every firing. Unattended runs accumulate proposals, never surprise writes.
 */
export type ScheduleProvider = "local";
export type ScheduleEntry = {
    id: string;
    label: string;
    /** Fullstackgtm command argv (no binary name, no --profile) — never shell. */
    argv: string[];
    /** 5-field cron expression (minute hour day-of-month month day-of-week). */
    cron: string;
    provider: ScheduleProvider;
    enabled: boolean;
    createdAt: string;
};
export type ScheduleRunTrigger = "cron" | "manual";
export type ScheduleRunRecord = {
    scheduleId: string;
    firedAt: string;
    completedAt: string;
    trigger: ScheduleRunTrigger;
    exitCode: number;
    /** Last ~50 lines of the command's stdout+stderr. */
    outputTail: string;
    /** Plan ids / enrich run labels the firing produced (store-diffed). */
    artifacts: {
        planIds: string[];
        runLabels: string[];
    };
    /**
     * Set when a governance gate refused to execute the command: the firing is
     * recorded for visibility but nothing ran. Reasons: "plan_not_approved"
     * (scheduled apply against a plan that is not approved — there is no flag
     * that relaxes this), "not_schedulable" (the stored argv no longer passes
     * the allowlist, e.g. after a hand edit of schedules.json),
     * "duplicate_firing" (a cron-triggered run already recorded in this minute
     * — launchd can double-trigger the Vixie dom+dow OR corner).
     */
    noopReason?: "plan_not_approved" | "not_schedulable" | "duplicate_firing";
};
export declare function scheduleId(label: string, cron: string, argv: string[], createdAt: string): string;
/**
 * Validate that an argv resolves to a schedulable fullstackgtm command.
 * Enforced at `schedule add` time AND re-checked at `schedule run` time (the
 * store is a user-editable JSON file). Throws with the full allowlist on
 * rejection; arbitrary shell is structurally impossible anyway (runs dispatch
 * in-process into the CLI router, never through a shell).
 */
export declare function validateSchedulableArgv(argv: string[]): void;
/**
 * A schedule label is free text the operator chooses, but it is later
 * interpolated into a crontab comment line by `renderManagedBlock`. A newline
 * (or carriage return) would break out of the comment and inject an arbitrary
 * crontab entry on `schedule install`. Reject control characters at the entry
 * point so a label can never carry a second line; `renderManagedBlock` also
 * strips them defensively in case a hand-edited schedules.json slips one past.
 */
export declare function assertSingleLineLabel(label: string): void;
/**
 * True if the string contains any line-breaking or control character. Covers
 * C0 controls + DEL, plus the Unicode separators a non-cron parser might honor
 * (NEL U+0085, LS U+2028, PS U+2029, VT U+000B, FF U+000C) — defense-in-depth
 * for the future modal/aws scaffold renderers whose target formats may treat
 * those as line breaks.
 */
export declare function hasControlChar(value: string): boolean;
/**
 * Split a `schedule add "<command>"` string into argv, honoring single and
 * double quotes (no escapes, no expansion — this is tokenization, not shell).
 */
export declare function tokenizeCommand(text: string): string[];
export type CronExpression = {
    source: string;
    minute: number[];
    hour: number[];
    dayOfMonth: number[];
    month: number[];
    /** 0–6, Sunday = 0 (an input 7 normalizes to 0). */
    dayOfWeek: number[];
    /** Vixie-cron day semantics: when BOTH are restricted, either may match. */
    dayOfMonthRestricted: boolean;
    dayOfWeekRestricted: boolean;
};
export declare function parseCron(expression: string): CronExpression;
/** True when the expression fires in `date`'s minute (local time, like cron). */
export declare function cronMatches(cron: CronExpression, date: Date): boolean;
/**
 * The next firing strictly after `after` (local time). Throws when the
 * expression never fires (e.g. "0 0 31 2 *") — `schedule add` calls this once
 * so impossible expressions are rejected up front with a clear error.
 */
export declare function nextCronFiring(cron: CronExpression, after: Date): Date;
/**
 * Expected firings strictly inside (fromExclusive, toExclusive), capped — the
 * input to missed-firing detection, never to catch-up execution.
 */
export declare function expectedFirings(cron: CronExpression, fromExclusive: Date, toExclusive: Date, cap?: number): Date[];
/**
 * Missed firings since the last run record (or the entry's creation when no
 * run has ever fired): expected firings with no run record in their minute.
 * Local cron has no catch-up — a laptop asleep at firing time skips the run —
 * so this is visibility only; nothing is re-executed.
 */
export declare function computeMissedFirings(entry: Pick<ScheduleEntry, "cron" | "createdAt">, runs: ScheduleRunRecord[], now?: Date, cap?: number): {
    missed: Date[];
    capped: boolean;
};
export declare function schedulesPath(baseDir?: string): string;
export declare function scheduleRunsDir(baseDir?: string): string;
export interface ScheduleStore {
    add(entry: ScheduleEntry): Promise<ScheduleEntry>;
    list(): Promise<ScheduleEntry[]>;
    get(id: string): Promise<ScheduleEntry | null>;
    remove(id: string): Promise<boolean>;
    setEnabled(id: string, enabled: boolean): Promise<ScheduleEntry>;
}
/**
 * Schedule entries as one small JSON file per profile, sibling to plans and
 * enrich runs. `directory` overrides the profile home (tests).
 */
export declare function createFileScheduleStore(directory?: string): ScheduleStore;
export interface ScheduleRunStore {
    record(run: ScheduleRunRecord): Promise<ScheduleRunRecord>;
    /** Run records for one schedule, oldest first; `limit` keeps the newest N. */
    list(scheduleId: string, limit?: number): Promise<ScheduleRunRecord[]>;
}
export declare function createFileScheduleRunStore(directory?: string): ScheduleRunStore;
export type CrontabIo = {
    /** Current crontab content; "" when the user has none. */
    read(): string;
    write(content: string): void;
};
/**
 * The real user crontab via `crontab -l` / `crontab -`. Everything above this
 * function takes a CrontabIo so tests inject fakes and never touch it.
 */
export declare function systemCrontabIo(): CrontabIo;
export declare function crontabSentinels(profile: string): {
    open: string;
    close: string;
};
/**
 * Render the managed block for one profile. Every line invokes
 * `... schedule run <id> --profile <profile> --trigger cron` — the single
 * provider entry point — so the crontab a user audits never contains anything
 * but fullstackgtm dispatch (no arbitrary shell, ever).
 */
export declare function renderManagedBlock(profile: string, entries: ScheduleEntry[], cliInvocation: string): string;
/**
 * Replace (or with `block: null`, remove) the profile's managed block in the
 * crontab content, byte-for-byte preserving everything outside the sentinels.
 * Idempotent: re-applying the same block yields identical content.
 */
export declare function replaceManagedBlock(existing: string, profile: string, block: string | null): string;
/**
 * One launchd StartCalendarInterval dict: every present key must match (AND),
 * a missing key is a wildcard, and an array of dicts fires when ANY dict
 * matches. Weekday 0 is Sunday, as in cron.
 */
export type LaunchdCalendarInterval = {
    Minute?: number;
    Hour?: number;
    Day?: number;
    Weekday?: number;
    Month?: number;
};
/**
 * Compile a cron expression to StartCalendarInterval dicts. Full-range fields
 * (`*`, but also spellings like `0-59`) are omitted (launchd wildcard); the
 * rest cross-product, capped so a dense expression cannot render a megabyte
 * plist. Vixie day semantics: when day-of-month AND day-of-week are both
 * restricted, either may match — launchd ANDs keys within one dict, so that
 * becomes the union of a Day dict set and a Weekday dict set. A date matching
 * both sets makes launchd trigger twice in the same minute; the run entry
 * point drops the second via isDuplicateCronFiring.
 */
export declare function cronToCalendarIntervals(cron: CronExpression, cap?: number): LaunchdCalendarInterval[];
/**
 * True when a cron-triggered run was already recorded in `firedAt`'s minute.
 * The `schedule run` entry point checks this for trigger:cron so a launchd
 * double-trigger (dom+dow OR corner above) records a duplicate_firing no-op
 * instead of running the command twice. Manual runs are never deduplicated.
 */
export declare function isDuplicateCronFiring(runs: ScheduleRunRecord[], firedAt: string): boolean;
/** Reverse-DNS namespace for one profile's agents; install/uninstall own this prefix wholesale. */
export declare function launchdAgentPrefix(profile: string): string;
export declare function launchdLabel(profile: string, scheduleEntryId: string): string;
/**
 * Render one LaunchAgent plist. ProgramArguments is an argv array — launchd
 * execs it directly, no shell, so there is no quoting/injection surface at
 * all (values are XML-escaped for the document, nothing more).
 */
export declare function renderLaunchdPlist(options: {
    label: string;
    programArguments: string[];
    calendarIntervals: LaunchdCalendarInterval[];
    environment?: Record<string, string>;
    standardOutPath?: string;
    standardErrorPath?: string;
}): string;
export type LaunchdIo = {
    /** Plist file names currently in the agents directory. */
    list(): string[];
    write(fileName: string, content: string): void;
    remove(fileName: string): void;
    /** Load one agent plist into the user's gui domain; throws on failure. */
    bootstrap(fileName: string): void;
    /** Best-effort unload by label; a label that is not loaded is not an error. */
    bootout(label: string): void;
};
/**
 * The real ~/Library/LaunchAgents + launchctl. Everything above takes a
 * LaunchdIo so tests inject fakes and never touch the user's agents.
 */
export declare function systemLaunchdIo(agentsDirOverride?: string): LaunchdIo;
/**
 * Materialize enabled entries as one LaunchAgent each, replacing the
 * profile's com.fullstackgtm.<profile>.* fleet wholesale (stale agents are
 * booted out and deleted; plists outside the prefix are never touched).
 * `cliArgv` is the argv-array analog of the crontab invocation line.
 */
export declare function installLaunchdAgents(profile: string, entries: ScheduleEntry[], cliArgv: string[], io: LaunchdIo, options?: {
    environment?: Record<string, string>;
    logDir?: string;
}): {
    installed: string[];
    removed: string[];
};
/** Boot out and delete every agent in the profile's prefix; returns the removed labels. */
export declare function uninstallLaunchdAgents(profile: string, io: LaunchdIo): string[];
