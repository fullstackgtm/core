import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { credentialsDir, ensureSecureHomeDir, writeSecureFile } from "./credentials.ts";

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

// ---------------------------------------------------------------------------
// Entry + run record shapes

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
  artifacts: { planIds: string[]; runLabels: string[] };
  /**
   * Set when a governance gate refused to execute the command: the firing is
   * recorded for visibility but nothing ran. Reasons: "plan_not_approved"
   * (scheduled apply against a plan that is not approved — there is no flag
   * that relaxes this), "not_schedulable" (the stored argv no longer passes
   * the allowlist, e.g. after a hand edit of schedules.json).
   */
  noopReason?: "plan_not_approved" | "not_schedulable";
};

// Mirrors stableHash in rules.ts (FNV-1a); duplicated to keep schedule.ts
// importable without pulling the audit engine (the market/enrich precedent).
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function scheduleId(label: string, cron: string, argv: string[], createdAt: string): string {
  return `sch_${fnv1a(`${label}|${cron}|${argv.join(" ")}|${createdAt}`)}`;
}

// ---------------------------------------------------------------------------
// Governance: the schedulable allowlist

/**
 * Read/plan-side commands only. Their unattended output is plans in the
 * queue, run records, and reports — never CRM writes. `apply` is the single
 * exception, allowed only as `apply --plan-id <id>` (the plan store's
 * approval status is re-checked at run time; see docs/schedule.md).
 */
const SCHEDULABLE: Record<string, string[] | null> = {
  audit: null,
  snapshot: null,
  suggest: null,
  report: null,
  doctor: null,
  enrich: ["append", "refresh"],
  market: ["capture", "refresh"],
};

const ALLOWLIST_SUMMARY =
  "audit, snapshot, enrich append|refresh, market capture|refresh, suggest, report, doctor — " +
  "plus apply --plan-id <id> (re-checked approved at every firing)";

/**
 * Validate that an argv resolves to a schedulable fullstackgtm command.
 * Enforced at `schedule add` time AND re-checked at `schedule run` time (the
 * store is a user-editable JSON file). Throws with the full allowlist on
 * rejection; arbitrary shell is structurally impossible anyway (runs dispatch
 * in-process into the CLI router, never through a shell).
 */
export function validateSchedulableArgv(argv: string[]): void {
  const head = argv[0];
  if (!head) throw new Error("Nothing to schedule: the command is empty.");
  if (argv.includes("--profile")) {
    throw new Error(
      "Do not embed --profile in the scheduled command — schedules are already profile-scoped. " +
        "Pass --profile <name> to `schedule add` itself instead.",
    );
  }
  if (head === "apply") {
    const planIdIndex = argv.indexOf("--plan-id");
    const planId = planIdIndex === -1 ? undefined : argv[planIdIndex + 1];
    if (!planId || planId.startsWith("--")) {
      throw new Error(
        "apply is schedulable ONLY as `apply --plan-id <id> ...`: the plan must already exist in " +
          "the plan store, and its status is re-checked as approved at every firing. " +
          "Scheduling never auto-approves.",
      );
    }
    if (argv.includes("--plan") || argv.includes("--approve")) {
      throw new Error(
        "A scheduled apply cannot take --plan/--approve — file-based approval would bypass the " +
          "plan store's approval state. Use `apply --plan-id <id>` and approve via `plans approve`.",
      );
    }
    return;
  }
  if (!Object.hasOwn(SCHEDULABLE, head)) {
    throw new Error(
      `"${head}" is not schedulable. Schedulable commands are read/plan-side only: ${ALLOWLIST_SUMMARY}. ` +
        "Unattended runs accumulate proposals, never writes.",
    );
  }
  const subcommands = SCHEDULABLE[head];
  if (subcommands) {
    const sub = argv[1];
    if (!sub || !subcommands.includes(sub)) {
      throw new Error(
        `"${head}${sub ? ` ${sub}` : ""}" is not schedulable — only: ${subcommands
          .map((name) => `${head} ${name}`)
          .join(", ")}.`,
      );
    }
  }
}

/**
 * A schedule label is free text the operator chooses, but it is later
 * interpolated into a crontab comment line by `renderManagedBlock`. A newline
 * (or carriage return) would break out of the comment and inject an arbitrary
 * crontab entry on `schedule install`. Reject control characters at the entry
 * point so a label can never carry a second line; `renderManagedBlock` also
 * strips them defensively in case a hand-edited schedules.json slips one past.
 */
export function assertSingleLineLabel(label: string): void {
  if (hasControlChar(label)) {
    throw new Error(
      "A schedule --label cannot contain newlines or control characters " +
        "(they would inject lines into the managed crontab block). Use a plain single-line name.",
    );
  }
}

/**
 * True if the string contains any line-breaking or control character. Covers
 * C0 controls + DEL, plus the Unicode separators a non-cron parser might honor
 * (NEL U+0085, LS U+2028, PS U+2029, VT U+000B, FF U+000C) — defense-in-depth
 * for the future modal/aws scaffold renderers whose target formats may treat
 * those as line breaks.
 */
export function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/** Collapse any control/separator character to a space — last-resort guard at render time. */
function sanitizeCrontabComment(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029 ? " " : ch;
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/**
 * Validate every field of an entry that `renderManagedBlock` interpolates into
 * the crontab — not just the label. The EXECUTABLE line embeds `cron` and `id`
 * raw, and `schedule install` renders entries straight from schedules.json, so
 * a hand-edited (or otherwise tampered) entry with a newline in cron/id/profile
 * would inject a live crontab line. Refuse to render a tampered entry rather
 * than emit it. (Well-formed entries never trip this: cron is parser-validated,
 * id is an fnv1a hex hash, label is guarded at add-time.)
 */
function assertRenderableEntry(profile: string, entry: ScheduleEntry): void {
  const fields: Array<[string, string]> = [
    ["profile", profile],
    ["cron", entry.cron],
    ["id", entry.id],
    ["label", entry.label],
    ...entry.argv.map((token, i) => [`argv[${i}]`, token] as [string, string]),
  ];
  for (const [name, value] of fields) {
    if (hasControlChar(value)) {
      throw new Error(
        `Refusing to render schedule entry ${entry.id}: its ${name} contains a newline or control character. ` +
          "The schedules.json store has been tampered with or corrupted — repair it before installing.",
      );
    }
  }
}

/**
 * Split a `schedule add "<command>"` string into argv, honoring single and
 * double quotes (no escapes, no expansion — this is tokenization, not shell).
 */
export function tokenizeCommand(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += char;
    inToken = true;
  }
  if (quote) throw new Error(`Unclosed ${quote} quote in the scheduled command.`);
  if (inToken) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// Cron: minimal dependency-free 5-field parser

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

const CRON_FIELD_SPECS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
] as const;

export function parseCron(expression: string): CronExpression {
  // Reject non-ASCII whitespace and control chars: JS \s splits on U+00A0,
  // U+3000, etc., but Vixie cron's field separator is only space/tab. A source
  // carrying them would parse here yet be misparsed or rejected by `crontab -`.
  if (hasControlChar(expression) || /[^\x20-\x7e]/.test(expression)) {
    throw new Error(`Invalid cron expression "${expression}": only ASCII characters, space, and tab are allowed.`);
  }
  const fields = expression.trim().split(/[ \t]+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expression}": expected 5 fields ` +
        `(minute hour day-of-month month day-of-week), got ${fields.length}.`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeekRaw] = fields.map((field, index) =>
    parseCronField(field, CRON_FIELD_SPECS[index], expression),
  );
  // 7 is an accepted alias for Sunday; normalize so matching uses 0–6.
  const dayOfWeek = Array.from(new Set(dayOfWeekRaw.map((value) => (value === 7 ? 0 : value)))).sort(
    (a, b) => a - b,
  );
  return {
    source: expression.trim(),
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    dayOfMonthRestricted: fields[2] !== "*",
    dayOfWeekRestricted: fields[4] !== "*",
  };
}

function parseCronField(
  field: string,
  spec: (typeof CRON_FIELD_SPECS)[number],
  expression: string,
): number[] {
  const values = new Set<number>();
  const fail = (problem: string): never => {
    throw new Error(`Invalid cron expression "${expression}": ${spec.name} field "${field}" ${problem}.`);
  };
  if (field === "") fail("is empty");
  for (const part of field.split(",")) {
    const slashed = part.split("/");
    if (slashed.length > 2) fail(`has more than one "/" in "${part}"`);
    const [rangeText, stepText] = slashed;
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        fail(`has an invalid step "/${stepText}" (steps are positive integers)`);
      }
      step = Number(stepText);
    }
    let low: number;
    let high: number;
    if (rangeText === "*") {
      low = spec.min;
      high = spec.max;
    } else if (/^\d+$/.test(rangeText)) {
      low = Number(rangeText);
      // Vixie semantics: "N/step" means N through the field max, stepped.
      high = stepText !== undefined ? spec.max : low;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(rangeText);
      if (!range) return fail(`has an unsupported token "${part}" (use *, numbers, lists, ranges, steps)`);
      low = Number(range[1]);
      high = Number(range[2]);
      if (low > high) fail(`has a range "${rangeText}" that starts after it ends`);
    }
    if (low < spec.min || high > spec.max) {
      fail(`is out of range (${spec.min}–${spec.max})`);
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return Array.from(values).sort((a, b) => a - b);
}

function cronDayMatches(cron: CronExpression, date: Date): boolean {
  if (!cron.month.includes(date.getMonth() + 1)) return false;
  const domMatch = cron.dayOfMonth.includes(date.getDate());
  const dowMatch = cron.dayOfWeek.includes(date.getDay());
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return domMatch || dowMatch;
  if (cron.dayOfMonthRestricted) return domMatch;
  if (cron.dayOfWeekRestricted) return dowMatch;
  return true;
}

/** True when the expression fires in `date`'s minute (local time, like cron). */
export function cronMatches(cron: CronExpression, date: Date): boolean {
  return (
    cron.minute.includes(date.getMinutes()) &&
    cron.hour.includes(date.getHours()) &&
    cronDayMatches(cron, date)
  );
}

/**
 * The next firing strictly after `after` (local time). Throws when the
 * expression never fires (e.g. "0 0 31 2 *") — `schedule add` calls this once
 * so impossible expressions are rejected up front with a clear error.
 */
export function nextCronFiring(cron: CronExpression, after: Date): Date {
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  // Day-level iteration; 4 years + 1 day covers schedules that only fire on
  // a leap day. Hour/minute lists are sorted, so the first hit is the answer.
  for (let dayOffset = 0; dayOffset <= 1462; dayOffset += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOffset);
    if (!cronDayMatches(cron, day)) continue;
    const sameDay = dayOffset === 0;
    for (const hour of cron.hour) {
      if (sameDay && hour < start.getHours()) continue;
      for (const minute of cron.minute) {
        if (sameDay && hour === start.getHours() && minute < start.getMinutes()) continue;
        return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
      }
    }
  }
  throw new Error(`Cron expression "${cron.source}" never fires (no matching date within 4 years).`);
}

/**
 * Expected firings strictly inside (fromExclusive, toExclusive), capped — the
 * input to missed-firing detection, never to catch-up execution.
 */
export function expectedFirings(
  cron: CronExpression,
  fromExclusive: Date,
  toExclusive: Date,
  cap = 100,
): Date[] {
  const firings: Date[] = [];
  let cursor = fromExclusive;
  while (firings.length < cap) {
    let next: Date;
    try {
      next = nextCronFiring(cron, cursor);
    } catch {
      break; // an expression that never fires has nothing to miss
    }
    if (next.getTime() >= toExclusive.getTime()) break;
    firings.push(next);
    cursor = next;
  }
  return firings;
}

/**
 * Missed firings since the last run record (or the entry's creation when no
 * run has ever fired): expected firings with no run record in their minute.
 * Local cron has no catch-up — a laptop asleep at firing time skips the run —
 * so this is visibility only; nothing is re-executed.
 */
export function computeMissedFirings(
  entry: Pick<ScheduleEntry, "cron" | "createdAt">,
  runs: ScheduleRunRecord[],
  now: Date = new Date(),
  cap = 100,
): { missed: Date[]; capped: boolean } {
  const cron = parseCron(entry.cron);
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
  const baseline = new Date(lastRun ? lastRun.firedAt : entry.createdAt);
  const expected = expectedFirings(cron, baseline, now, cap);
  const firedMinutes = new Set(
    runs.map((run) => {
      const fired = new Date(run.firedAt);
      fired.setSeconds(0, 0);
      return fired.getTime();
    }),
  );
  const missed = expected.filter((firing) => !firedMinutes.has(firing.getTime()));
  return { missed, capped: expected.length >= cap };
}

// ---------------------------------------------------------------------------
// Stores: schedules.json + schedule/runs/<id>/<timestamp>.json

export function schedulesPath(baseDir?: string): string {
  return join(baseDir ?? credentialsDir(), "schedules.json");
}

export function scheduleRunsDir(baseDir?: string): string {
  return join(baseDir ?? credentialsDir(), "schedule", "runs");
}

type SchedulesFile = { version: 1; schedules: ScheduleEntry[] };

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
export function createFileScheduleStore(directory?: string): ScheduleStore {
  const path = () => schedulesPath(directory);

  function read(): SchedulesFile {
    try {
      const parsed = JSON.parse(readFileSync(path(), "utf8"));
      if (parsed && typeof parsed === "object" && parsed.version === 1 && Array.isArray(parsed.schedules)) {
        return parsed as SchedulesFile;
      }
    } catch {
      // Missing or unreadable file falls through to an empty store.
    }
    return { version: 1, schedules: [] };
  }

  function write(file: SchedulesFile) {
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
    else ensureSecureHomeDir();
    writeSecureFile(path(), `${JSON.stringify(file, null, 2)}\n`);
  }

  function mustFind(file: SchedulesFile, id: string): ScheduleEntry {
    const entry = file.schedules.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`No schedule with id ${id}. List entries with \`fullstackgtm schedule list\`.`);
    return entry;
  }

  return {
    async add(entry) {
      const file = read();
      if (file.schedules.some((candidate) => candidate.id === entry.id)) {
        throw new Error(`Schedule ${entry.id} already exists.`);
      }
      file.schedules.push(entry);
      write(file);
      return entry;
    },
    async list() {
      return read().schedules;
    },
    async get(id) {
      return read().schedules.find((candidate) => candidate.id === id) ?? null;
    },
    async remove(id) {
      const file = read();
      const remaining = file.schedules.filter((candidate) => candidate.id !== id);
      if (remaining.length === file.schedules.length) return false;
      write({ ...file, schedules: remaining });
      return true;
    },
    async setEnabled(id, enabled) {
      const file = read();
      const entry = mustFind(file, id);
      entry.enabled = enabled;
      write(file);
      return entry;
    },
  };
}

export interface ScheduleRunStore {
  record(run: ScheduleRunRecord): Promise<ScheduleRunRecord>;
  /** Run records for one schedule, oldest first; `limit` keeps the newest N. */
  list(scheduleId: string, limit?: number): Promise<ScheduleRunRecord[]>;
}

export function createFileScheduleRunStore(directory?: string): ScheduleRunStore {
  const baseDir = () => directory ?? scheduleRunsDir();

  function dirFor(scheduleId: string) {
    if (!/^[\w.-]+$/.test(scheduleId)) throw new Error(`Invalid schedule id: ${scheduleId}`);
    return join(baseDir(), scheduleId);
  }

  return {
    async record(run) {
      const dir = dirFor(run.scheduleId);
      if (!directory) ensureSecureHomeDir();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // ISO timestamps carry ":" — sanitize for the filename, keep the record verbatim.
      const fileName = `${run.firedAt.replace(/[:.]/g, "-")}.json`;
      writeSecureFile(join(dir, fileName), `${JSON.stringify(run, null, 2)}\n`);
      return run;
    },
    async list(scheduleId, limit) {
      let names: string[] = [];
      try {
        names = readdirSync(dirFor(scheduleId)).filter((name) => name.endsWith(".json"));
      } catch {
        return [];
      }
      const runs = names
        .sort()
        .map((name) => {
          try {
            return JSON.parse(readFileSync(join(dirFor(scheduleId), name), "utf8")) as ScheduleRunRecord;
          } catch {
            return null;
          }
        })
        .filter((run): run is ScheduleRunRecord => run !== null);
      return limit !== undefined && limit >= 0 ? runs.slice(-limit) : runs;
    },
  };
}

// ---------------------------------------------------------------------------
// Local provider: sentinel-delimited managed crontab block

export type CrontabIo = {
  /** Current crontab content; "" when the user has none. */
  read(): string;
  write(content: string): void;
};

/**
 * The real user crontab via `crontab -l` / `crontab -`. Everything above this
 * function takes a CrontabIo so tests inject fakes and never touch it.
 */
export function systemCrontabIo(): CrontabIo {
  return {
    read() {
      const result = spawnSync("crontab", ["-l"], { encoding: "utf8" });
      if (result.error) throw new Error(`Cannot run \`crontab\`: ${result.error.message}`);
      if (result.status !== 0) {
        // "no crontab for <user>" exits 1: an empty crontab, not a failure.
        if (/no crontab/i.test(result.stderr ?? "")) return "";
        throw new Error(`\`crontab -l\` failed: ${(result.stderr ?? "").trim()}`);
      }
      return result.stdout ?? "";
    },
    write(content) {
      const result = spawnSync("crontab", ["-"], { input: content, encoding: "utf8" });
      if (result.error) throw new Error(`Cannot run \`crontab\`: ${result.error.message}`);
      if (result.status !== 0) {
        throw new Error(`crontab rejected the rendered block: ${(result.stderr ?? "").trim()}`);
      }
    },
  };
}

export function crontabSentinels(profile: string): { open: string; close: string } {
  return {
    open: `# >>> fullstackgtm ${profile} >>>`,
    close: `# <<< fullstackgtm ${profile} <<<`,
  };
}

/**
 * Render the managed block for one profile. Every line invokes
 * `... schedule run <id> --profile <profile> --trigger cron` — the single
 * provider entry point — so the crontab a user audits never contains anything
 * but fullstackgtm dispatch (no arbitrary shell, ever).
 */
export function renderManagedBlock(
  profile: string,
  entries: ScheduleEntry[],
  cliInvocation: string,
): string {
  // cliInvocation is spliced raw into the executable line; it is built from
  // process.execPath, the script path, and FSGTM_HOME (cli.ts), so a newline in
  // FSGTM_HOME would inject a crontab line. Validate it like the entry fields —
  // single-quote shell-escaping does NOT defend cron's line parser.
  if (hasControlChar(cliInvocation)) {
    throw new Error(
      "Refusing to render the managed crontab: the resolved CLI invocation (node path, script path, " +
        "or FSGTM_HOME) contains a newline or control character. Check $FSGTM_HOME.",
    );
  }
  const { open, close } = crontabSentinels(profile);
  const lines = [
    open,
    "# Managed by `fullstackgtm schedule install` — replaced wholesale on re-install; do not edit.",
  ];
  for (const entry of entries) {
    // Refuse to render any entry whose interpolated fields carry a control char
    // — the executable line below embeds cron/id raw, so a tampered store could
    // otherwise inject a live crontab line. The comment line is additionally
    // sanitized so a benign-but-messy label can't break it.
    assertRenderableEntry(profile, entry);
    lines.push(sanitizeCrontabComment(`# ${entry.label} (${entry.id}): ${entry.argv.join(" ")}`));
    lines.push(`${entry.cron} ${cliInvocation} schedule run ${entry.id} --profile ${profile} --trigger cron`);
  }
  lines.push(close);
  return lines.join("\n");
}

/**
 * Replace (or with `block: null`, remove) the profile's managed block in the
 * crontab content, byte-for-byte preserving everything outside the sentinels.
 * Idempotent: re-applying the same block yields identical content.
 */
export function replaceManagedBlock(existing: string, profile: string, block: string | null): string {
  const { open, close } = crontabSentinels(profile);
  const lines = existing.split("\n");
  const start = lines.indexOf(open);
  const end = lines.indexOf(close);
  let before: string[];
  let after: string[];
  if (start !== -1 && end !== -1 && end > start) {
    before = lines.slice(0, start);
    after = lines.slice(end + 1);
  } else if (start !== -1 || end !== -1) {
    throw new Error(
      `The crontab contains a damaged fullstackgtm block for profile "${profile}" ` +
        "(one sentinel without its pair). Repair it by hand, then re-run install.",
    );
  } else {
    before = lines;
    after = [];
  }
  const merged = [...before];
  if (block !== null) {
    if (merged.length > 0 && merged[merged.length - 1].trim() !== "") merged.push("");
    merged.push(...block.split("\n"));
  }
  merged.push(...after);
  while (merged.length > 0 && merged[0].trim() === "") merged.shift();
  while (merged.length > 0 && merged[merged.length - 1].trim() === "") merged.pop();
  if (merged.length === 0) return "";
  return `${merged.join("\n")}\n`;
}
