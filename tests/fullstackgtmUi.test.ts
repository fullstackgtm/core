import assert from "node:assert/strict";
import test from "node:test";
import {
  animationEnabled,
  box,
  colorEnabled,
  createChecklist,
  createStatusLine,
  formatBar,
  formatCount,
  formatDuration,
  paint,
  scoreColor,
  sparkline,
  statusGlyph,
  stripAnsi,
  table,
} from "../src/cli/ui.ts";

type FakeStream = {
  isTTY?: boolean;
  columns?: number;
  chunks: string[];
  write(chunk: string): boolean;
};

function fakeStream(isTTY: boolean, columns = 80): FakeStream {
  return {
    isTTY,
    columns,
    chunks: [],
    write(chunk: string) {
      this.chunks.push(chunk);
      return true;
    },
  };
}

test("colorEnabled: TTY on, piped off, NO_COLOR/CI/dumb win, FORCE_COLOR overrides", () => {
  assert.equal(colorEnabled(fakeStream(true), {}), true);
  assert.equal(colorEnabled(fakeStream(false), {}), false);
  assert.equal(colorEnabled(fakeStream(true), { NO_COLOR: "" }), false);
  assert.equal(colorEnabled(fakeStream(true), { NO_COLOR: "1" }), false);
  assert.equal(colorEnabled(fakeStream(true), { CI: "true" }), false);
  assert.equal(colorEnabled(fakeStream(true), { TERM: "dumb" }), false);
  assert.equal(colorEnabled(fakeStream(false), { FORCE_COLOR: "1" }), true);
  assert.equal(colorEnabled(fakeStream(true), { FORCE_COLOR: "0" }), false);
});

test("animationEnabled: needs a TTY; FORCE_COLOR does NOT force animation", () => {
  assert.equal(animationEnabled(fakeStream(true), {}), true);
  assert.equal(animationEnabled(fakeStream(false), {}), false);
  assert.equal(animationEnabled(fakeStream(false), { FORCE_COLOR: "1" }), false);
  assert.equal(animationEnabled(fakeStream(true), { NO_COLOR: "1" }), false);
  assert.equal(animationEnabled(fakeStream(true), { CI: "1" }), false);
});

test("paint: styles wrap when enabled, identity when disabled", () => {
  const on = paint(true);
  const off = paint(false);
  assert.equal(on.green("hi"), "\u001b[32mhi\u001b[0m");
  assert.equal(on.dim("hi"), "\u001b[2mhi\u001b[0m");
  assert.equal(off.green("hi"), "hi");
  assert.equal(off.bold("hi"), "hi");
  assert.equal(stripAnsi(on.bold(on.red("x"))), "x");
});

test("statusGlyph and scoreColor band correctly", () => {
  const off = paint(false);
  assert.equal(statusGlyph("ok", off), "✓");
  assert.equal(statusGlyph("warn", off), "!");
  assert.equal(statusGlyph("fail", off), "✗");
  assert.equal(statusGlyph("pending", off), "○");
  const on = paint(true);
  assert.match(scoreColor(85, on), /\u001b\[32m/); // green
  assert.match(scoreColor(65, on), /\u001b\[33m/); // yellow
  assert.match(scoreColor(42, on), /\u001b\[31m/); // red
  assert.equal(scoreColor(85, off), "85");
});

test("sparkline normalizes min–max and handles flat/empty series", () => {
  assert.equal(sparkline([]), "");
  assert.equal(sparkline([5]), "▅");
  assert.equal(sparkline([5, 5, 5]), "▅▅▅");
  const line = sparkline([0, 25, 50, 75, 100]);
  assert.equal(line.length, 5);
  assert.equal(line[0], "▁");
  assert.equal(line[4], "█");
});

test("formatBar clamps and fills proportionally", () => {
  assert.equal(formatBar(0, 4), "▱▱▱▱");
  assert.equal(formatBar(1, 4), "▰▰▰▰");
  assert.equal(formatBar(0.5, 4), "▰▰▱▱");
  assert.equal(formatBar(-1, 4), "▱▱▱▱");
  assert.equal(formatBar(2, 4), "▰▰▰▰");
});

test("formatDuration and formatCount", () => {
  assert.equal(formatDuration(950), "950ms");
  assert.equal(formatDuration(12_400), "12s");
  assert.equal(formatDuration(84_000), "1m 24s");
  assert.equal(formatCount(12345), "12,345");
});

test("box frames content with rounded corners and even width", () => {
  const off = paint(false);
  const lines = box(["alpha", "much longer line"], off);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^╭─+╮$/);
  assert.match(lines[3], /^╰─+╯$/);
  const widths = new Set(lines.map((line) => line.length));
  assert.equal(widths.size, 1, "all box lines share one width");
  assert.match(lines[1], /│ alpha +│/);
  const titled = box(["x"], off, "Next step");
  assert.match(titled[0], /╭─ Next step ─*╮/);
});

test("table aligns ragged rows and trims trailing space", () => {
  const rows = table([
    ["id", "state", "ops"],
    ["plan-1234", "needs_approval", "12"],
    ["p2", "approved", "3"],
  ]);
  assert.equal(rows[1], "plan-1234  needs_approval  12");
  assert.equal(rows[2], "p2         approved        3");
  for (const row of rows) assert.equal(row, row.trimEnd());
});

test("statusLine is a no-op without a TTY and repaints in place with one", async () => {
  const piped = fakeStream(false);
  const noop = createStatusLine(piped, {});
  noop.set("working…");
  noop.done("finished");
  assert.equal(noop.active, false);
  assert.equal(piped.chunks.length, 0, "no bytes written to a piped stream");

  const tty = fakeStream(true);
  const live = createStatusLine(tty, {});
  assert.equal(live.active, true);
  live.set("pulling contacts… 100 fetched");
  live.set("pulling contacts… 200 fetched");
  live.done("done: 200 contacts");
  const output = tty.chunks.join("");
  assert.match(output, /\r\u001b\[2K/, "repaints via clear-line");
  assert.match(output, /pulling contacts/);
  assert.match(output, /done: 200 contacts\n$/);
});

test("statusLine truncates to the terminal width", () => {
  const tty = fakeStream(true, 24);
  const live = createStatusLine(tty, {});
  live.set("x".repeat(100));
  live.done();
  const longest = Math.max(...tty.chunks.map((chunk) => stripAnsi(chunk).length));
  assert.ok(longest <= 25, `line fits 24 columns (saw ${longest})`);
});

test("truncateToWidth caps text with an ellipsis", async () => {
  const { truncateToWidth } = await import("../src/cli/ui.ts");
  assert.equal(truncateToWidth("short", 10), "short");
  assert.equal(truncateToWidth("exactly-10", 10), "exactly-10");
  assert.equal(truncateToWidth("a very long plan summary", 10), "a very lo…");
  assert.equal(truncateToWidth("a very long plan summary", 10).length, 10);
  assert.equal(truncateToWidth("trailing  space", 11), "trailing…", "no dangling gap before the ellipsis");
  assert.equal(truncateToWidth("xy", 1), "…");
  assert.equal(truncateToWidth("xy", 0), "");
});

test("stylizePlanMarkdown: severity banding + value diff, passthrough when disabled", async () => {
  const { stylizePlanMarkdown } = await import("../src/cli/ui.ts");
  const sample = [
    "# GTM hygiene audit patch plan",
    "Status: needs_approval",
    "| stale-deal | 50 | warning |",
    "- **Deal has no valid owner** (critical, planned)",
    "  - Current CRM value: user_departed_0",
    "  - Proposed value: requires_human_owner_selection",
    "  - Proposed value: 2026-07-01",
  ].join("\n");

  assert.equal(stylizePlanMarkdown(sample, paint(false)), sample, "plain mode is byte-identical");

  const rich = stylizePlanMarkdown(sample, paint(true));
  // The only text change styling makes: finding headlines render terminal-bold
  // instead of markdown-bold (the ** markers drop).
  assert.equal(
    stripAnsi(rich),
    sample.replace("- **Deal has no valid owner** (", "- Deal has no valid owner ("),
  );
  assert.match(rich, /\u001b\[33mwarning\u001b\[0m/, "table severity banded");
  assert.match(rich, /\u001b\[31mcritical\u001b\[0m/, "headline severity banded");
  assert.match(rich, /\u001b\[31muser_departed_0\u001b\[0m/, "current value reads as removed");
  assert.match(rich, /\u001b\[33mrequires_human_owner_selection\u001b\[0m/, "placeholder reads as needs-a-human");
  assert.match(rich, /\u001b\[32m2026-07-01\u001b\[0m/, "concrete proposed value reads as added");
  assert.match(rich, /\u001b\[33mneeds_approval\u001b\[0m/, "status banded");
});

test("checklist renders states, then erases itself on done()", () => {
  const tty = fakeStream(true);
  const board = createChecklist(
    [
      { id: "a", label: "missing-owner" },
      { id: "b", label: "stale-lifecycle" },
    ],
    tty,
    {},
  );
  assert.equal(board.active, true);
  board.update("a", "running");
  board.update("a", "ok", "12 findings");
  board.update("b", "fail", "boom");
  board.done();
  const output = tty.chunks.join("");
  assert.match(output, /missing-owner/);
  assert.match(output, /12 findings/);
  assert.match(stripAnsi(output), /✗/);
  assert.match(output, /\u001b\[2A/, "erases the two painted lines");

  const piped = fakeStream(false);
  const inert = createChecklist([{ id: "a", label: "x" }], piped, {});
  inert.update("a", "ok");
  inert.done();
  assert.equal(inert.active, false);
  assert.equal(piped.chunks.length, 0);
});
