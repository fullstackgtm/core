// Terminal presentation layer — zero-dependency by design (this package ships
// with no runtime deps and holds CRM credentials; every avoided dependency is
// supply-chain surface we don't carry).
//
// The contract that keeps the agent surface safe:
//   - stdout NEVER carries ANSI bytes unless stdout itself is an interactive
//     TTY. Piped/redirected/--json output is byte-identical to the unstyled CLI.
//   - Animation (spinners, progress, checklists) goes to stderr ONLY, and only
//     when stderr is an interactive TTY. Non-TTY runs render nothing — no
//     frame spam in CI logs or agent transcripts.
//   - NO_COLOR (https://no-color.org), TERM=dumb, and CI disable styling;
//     FORCE_COLOR (non-"0") re-enables it, matching the wider ecosystem.

import type { ProgressEvent, ProgressListener, ProgressSnapshot } from "../progress.ts";

type StreamLike = {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): boolean;
};

export type UiEnv = Record<string, string | undefined>;

/** Should `stream` receive color/ANSI styling at all? */
export function colorEnabled(
  stream: StreamLike | undefined = process.stdout,
  env: UiEnv = process.env,
): boolean {
  if (env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR !== undefined) return true;
  if (env.NO_COLOR !== undefined) return false;
  if (env.TERM === "dumb") return false;
  if (env.CI !== undefined) return false;
  return Boolean(stream?.isTTY);
}

/**
 * Should `stream` receive live single-line repaints (spinners, bars)?
 * Stricter than color: FORCE_COLOR opts into color codes, not into cursor
 * animation — repaint sequences in a captured log are never what anyone wants.
 */
export function animationEnabled(
  stream: StreamLike | undefined = process.stderr,
  env: UiEnv = process.env,
): boolean {
  if (env.NO_COLOR !== undefined) return false;
  if (env.TERM === "dumb") return false;
  if (env.CI !== undefined) return false;
  return Boolean(stream?.isTTY);
}

const CODES = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
} as const;

export type StyleName = keyof Omit<typeof CODES, "reset">;

export type Paint = Record<StyleName, (text: string) => string> & {
  enabled: boolean;
};

/**
 * Style functions for one stream: identity functions when styling is off, so
 * call sites never branch. `paint(colorEnabled(process.stdout))`.
 */
export function paint(enabled: boolean): Paint {
  const entry = (code: string) =>
    enabled ? (text: string) => `${code}${text}${CODES.reset}` : (text: string) => text;
  return {
    enabled,
    bold: entry(CODES.bold),
    dim: entry(CODES.dim),
    red: entry(CODES.red),
    green: entry(CODES.green),
    yellow: entry(CODES.yellow),
    blue: entry(CODES.blue),
    magenta: entry(CODES.magenta),
    cyan: entry(CODES.cyan),
  };
}

export const GLYPH = {
  ok: "✓",
  warn: "!",
  fail: "✗",
  pending: "○",
  bullet: "●",
} as const;

/** `✓` in green / `!` in yellow / `✗` in red — or the bare glyph unstyled. */
export function statusGlyph(state: "ok" | "warn" | "fail" | "pending", p: Paint): string {
  if (state === "ok") return p.green(GLYPH.ok);
  if (state === "warn") return p.yellow(GLYPH.warn);
  if (state === "fail") return p.red(GLYPH.fail);
  return p.dim(GLYPH.pending);
}

/** Color banding for 0–100 scores: ≥80 green, ≥60 yellow, else red. */
export function scoreColor(score: number, p: Paint): string {
  const text = String(score);
  if (score >= 80) return p.green(text);
  if (score >= 60) return p.yellow(text);
  return p.red(text);
}

const SPARKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** Min–max normalized sparkline: [42, 51, 68, 81] → "▁▃▅█". */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values
    .map((value) => {
      const fraction = span === 0 ? 0.5 : (value - min) / span;
      return SPARKS[Math.min(SPARKS.length - 1, Math.floor(fraction * SPARKS.length))];
    })
    .join("");
}

/** `formatBar(0.67)` → "▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱" (clamped to [0,1]). */
export function formatBar(fraction: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/** 950 → "950ms"; 12_400 → "12s"; 84_000 → "1m 24s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

/** 12345 → "12,345" (fixed en-US grouping — output must not vary by host locale). */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Rounded-corner frame around pre-rendered lines. `width` is measured on the
 * raw text, so style the CONTENT only after framing (or pass unstyled lines) —
 * ANSI codes inside `lines` would inflate the measured width.
 */
export function box(lines: string[], p: Paint, title?: string): string[] {
  const inner = Math.max(
    ...lines.map((line) => line.length),
    title ? title.length + 2 : 0,
  );
  const top = title
    ? `╭─ ${title} ${"─".repeat(Math.max(0, inner - title.length - 1))}╮`
    : `╭${"─".repeat(inner + 2)}╮`;
  const bottom = `╰${"─".repeat(inner + 2)}╯`;
  return [
    p.dim(top),
    ...lines.map((line) => `${p.dim("│")} ${line.padEnd(inner)} ${p.dim("│")}`),
    p.dim(bottom),
  ];
}

/**
 * Left-aligned columns with two-space gutters. Rows may be ragged; widths are
 * measured on raw cell text, so pass unstyled cells and style whole lines, or
 * style via the optional per-column painters (applied AFTER padding).
 */
export function table(
  rows: string[][],
  painters?: Array<((cell: string) => string) | null>,
): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) => {
        const padded = index === row.length - 1 ? cell : cell.padEnd(widths[index]);
        const painterFn = painters?.[index];
        return painterFn ? painterFn(padded) : padded;
      })
      .join("  ")
      .trimEnd(),
  );
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;
const CLEAR_LINE = "\r\u001b[2K";

export type StatusLine = {
  /** Replace the line's text (next frame repaints it). */
  set(text: string): void;
  /** Stop animating; optionally leave a final static line (else clear). */
  done(finalText?: string): void;
  readonly active: boolean;
};

const NOOP_STATUS: StatusLine = { set() {}, done() {}, active: false };

/**
 * One live spinner line on stderr, repainted in place. Returns an inert no-op
 * outside an interactive TTY, so call sites never branch. `done()` always
 * clears the animation; pass `finalText` to leave a plain summary line behind.
 */
export function createStatusLine(
  stream: StreamLike = process.stderr,
  env: UiEnv = process.env,
): StatusLine {
  if (!animationEnabled(stream, env)) return NOOP_STATUS;
  let text = "";
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const render = () => {
    const columns = stream.columns ?? 80;
    const line = `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${text}`;
    stream.write(CLEAR_LINE + (line.length >= columns ? `${line.slice(0, columns - 2)}…` : line));
  };

  const status: StatusLine = {
    set(next: string) {
      text = next;
      if (!timer) {
        // The timer only advances the spinner frame; text changes repaint
        // immediately so progress is never a tick behind the work.
        timer = setInterval(() => {
          frame += 1;
          render();
        }, SPINNER_INTERVAL_MS);
        // Never hold the event loop open: a forgotten spinner must not stop
        // the CLI from exiting.
        timer.unref?.();
      }
      render();
    },
    done(finalText?: string) {
      if (timer) clearInterval(timer);
      timer = null;
      stream.write(CLEAR_LINE);
      if (finalText !== undefined) stream.write(`${finalText}\n`);
    },
    active: true,
  };
  return status;
}

/**
 * A status line that re-renders itself every second with the elapsed time —
 * for single long waits (an LLM call) where nothing else ticks. `label`
 * receives the formatted elapsed time. Inert outside an interactive TTY.
 */
export function startElapsedStatus(
  label: (elapsed: string) => string,
  stream: StreamLike = process.stderr,
  env: UiEnv = process.env,
): { done(finalText?: string): void; active: boolean } {
  const status = createStatusLine(stream, env);
  if (!status.active) return { done() {}, active: false };
  const started = Date.now();
  const refresh = () => status.set(label(formatDuration(Date.now() - started)));
  refresh();
  const timer = setInterval(refresh, 1000);
  timer.unref?.();
  return {
    done(finalText?: string) {
      clearInterval(timer);
      status.done(finalText);
    },
    active: true,
  };
}

export type Checklist = {
  update(id: string, state: "pending" | "running" | "ok" | "warn" | "fail", note?: string): void;
  /** Stop animating and erase the board (callers print their own summary). */
  done(): void;
  readonly active: boolean;
};

const NOOP_CHECKLIST: Checklist = { update() {}, done() {}, active: false };

/**
 * A multi-line live board — one line per item, each flipping ○ → ⠹ → ✓ as work
 * progresses (the audit rule registry renders through this). Repaints with
 * cursor-up; erases itself on done() so the verb's real output owns stdout.
 */
export function createChecklist(
  items: Array<{ id: string; label: string }>,
  stream: StreamLike = process.stderr,
  env: UiEnv = process.env,
): Checklist {
  if (!animationEnabled(stream, env) || items.length === 0) return NOOP_CHECKLIST;
  const p = paint(true);
  const states = new Map<string, { state: "pending" | "running" | "ok" | "warn" | "fail"; note?: string }>(
    items.map((item) => [item.id, { state: "pending" as const }]),
  );
  let frame = 0;
  let painted = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const labelWidth = Math.max(...items.map((item) => item.label.length));

  const render = () => {
    const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    const lines = items.map((item) => {
      const entry = states.get(item.id)!;
      const glyph =
        entry.state === "running" ? p.cyan(spin) : statusGlyph(entry.state, p);
      const note = entry.note ? `  ${p.dim(entry.note)}` : "";
      const label = entry.state === "pending" ? p.dim(item.label.padEnd(labelWidth)) : item.label.padEnd(labelWidth);
      return `  ${glyph} ${label}${note}`;
    });
    const up = painted > 0 ? `\u001b[${painted}A` : "";
    stream.write(`${up}${lines.map((line) => `\u001b[2K${line}`).join("\n")}\n`);
    painted = lines.length;
  };

  const start = () => {
    if (!timer) {
      timer = setInterval(() => {
        frame += 1;
        render();
      }, SPINNER_INTERVAL_MS);
      timer.unref?.();
    }
  };

  return {
    update(id, state, note) {
      const entry = states.get(id);
      if (!entry) return;
      entry.state = state;
      entry.note = note;
      start();
      render();
    },
    done() {
      if (timer) clearInterval(timer);
      timer = null;
      if (painted > 0) {
        // Erase the board: cursor up over every painted line, clear each.
        stream.write(`\u001b[${painted}A${"\u001b[2K\n".repeat(painted)}\u001b[${painted}A`);
        painted = 0;
      }
    },
    active: true,
  };
}

export type ProgressRenderer = {
  /**
   * Feed to `createProgressEmitter` (compose with the broker streaming
   * listener via `composeListeners` when the run should also heartbeat).
   */
  listener: ProgressListener;
  /** Stop animating and erase the board (callers print their own summary). */
  done(): void;
  readonly active: boolean;
};

const NOOP_RENDERER: ProgressRenderer = { listener: () => {}, done() {}, active: false };

/**
 * Adapter from the shared progress vocabulary (src/progress.ts) to the
 * existing TTY primitives: `stage` events advance a live checklist (○ → ⠹ →
 * ✓), while `items` / `note` / `opResult` / `meter` events annotate the
 * running stage ("contacts 1,200/4,800", the apply ticker tallies, a fuel
 * gauge). Outside an interactive TTY this is an inert no-op — piped/CI/agent
 * output stays byte-identical (streaming listeners composed alongside still
 * run; rendering is presentation only).
 */
export function createProgressRenderer(
  stages: readonly string[],
  stream: StreamLike = process.stderr,
  env: UiEnv = process.env,
): ProgressRenderer {
  const board = createChecklist(
    stages.map((stage) => ({ id: stage, label: stage })),
    stream,
    env,
  );
  if (!board.active) return NOOP_RENDERER;
  let current: string | null = null;
  const noteFor = (event: ProgressEvent, snapshot: ProgressSnapshot): string | undefined => {
    if (event.kind === "items") {
      return event.total !== undefined
        ? `${formatCount(event.done)}/${formatCount(event.total)}`
        : formatCount(event.done);
    }
    if (event.kind === "note") return event.note;
    if (event.kind === "opResult") {
      return `${GLYPH.ok} ${formatCount(snapshot.opsApplied)} applied · ${formatCount(snapshot.opsFailed)} failed · ${formatCount(snapshot.opsSkipped)} skipped`;
    }
    if (event.kind === "meter") {
      const fraction = event.budget > 0 ? event.spent / event.budget : 0;
      return `${formatBar(fraction, 10)} ${formatCount(event.spent)}/${formatCount(event.budget)} ${event.unit}`;
    }
    return undefined;
  };
  return {
    listener(event, snapshot) {
      if (event.kind === "stage") {
        // Advance the board: close out the previous stage, spin the new one.
        if (current && current !== event.stage) board.update(current, "ok");
        current = event.stage;
        board.update(current, "running");
        return;
      }
      // Events for a stage the board doesn't know (e.g. a nested pull inside a
      // larger flow) are ignored by createChecklist's unknown-id no-op.
      if (current) board.update(current, "running", noteFor(event, snapshot));
    },
    done() {
      board.done();
    },
    active: true,
  };
}

/** Truncate to `max` display characters, ending in "…" when cut. */
export function truncateToWidth(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "…";
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** critical → red, warning → yellow, info → dim. */
export function severityWord(word: string, p: Paint): string {
  if (word === "critical") return p.red(word);
  if (word === "warning") return p.yellow(word);
  return p.dim(word);
}

/** needs_approval → yellow, approved/applied → green, rejected → red. */
export function planStatusWord(status: string, p: Paint): string {
  if (status === "needs_approval") return p.yellow(status);
  if (status === "approved" || status === "applied") return p.green(status);
  if (status === "rejected") return p.red(status);
  return status;
}

/**
 * Interactive-terminal styling for the patch-plan markdown that `audit` and
 * `plans show` print: headings bold, severities banded, and the core diff —
 * current value red, proposed value green (placeholders yellow: they need a
 * human before they can be written). Line-level and additive — with paint
 * disabled the text passes through untouched, so piped output is unchanged.
 * One deliberate text change in rich mode: finding headlines render
 * terminal-bold instead of markdown-bold (the ** markers drop).
 */
export function stylizePlanMarkdown(text: string, p: Paint): string {
  if (!p.enabled) return text;
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("# ") || line.startsWith("## ")) return p.bold(line);
      // Rule-summary table severity cell: "| stale-deal | 50 | warning |"
      const cell = line.match(/^(\| .+ \| \d+ \| )(critical|warning|info)( \|)$/);
      if (cell) return `${cell[1]}${severityWord(cell[2], p)}${cell[3]}`;
      // Finding headline: "- **Deal has no valid owner** (warning, planned)"
      const headline = line.match(/^- \*\*(.+)\*\* \((critical|warning|info)(, .+)$/);
      if (headline) return `- ${p.bold(headline[1])} (${severityWord(headline[2], p)}${headline[3]}`;
      // The diff at the heart of the plan: what is → what would be written.
      const current = line.match(/^(\s*- Current CRM value: )(.*)$/);
      if (current) return `${current[1]}${p.red(current[2])}`;
      const proposed = line.match(/^(\s*- Proposed value: )(.*)$/);
      if (proposed) {
        const value = proposed[2];
        return `${proposed[1]}${value.startsWith("requires_human") ? p.yellow(value) : p.green(value)}`;
      }
      if (line.startsWith("Status: ")) {
        return `Status: ${planStatusWord(line.slice("Status: ".length), p)}`;
      }
      if (line.startsWith("Dry run: ")) return p.dim(line);
      return line;
    })
    .join("\n");
}

/** Strip ANSI escape sequences (test helper + safety net for width math). */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}
