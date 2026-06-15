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
     * the allowlist, e.g. after a hand edit of schedules.json).
     */
    noopReason?: "plan_not_approved" | "not_schedulable";
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
