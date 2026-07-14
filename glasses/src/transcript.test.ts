import { describe, expect, it } from "vitest";
import { conciseText, emptyBuffer, mergeTail, prependHistory } from "./transcript.ts";
import type { TailEntry } from "./types.ts";

function entry(id: string, text: string, role = "assistant"): TailEntry {
  return { id, role, text };
}

describe("mergeTail", () => {
  it("appends new entries onto an empty buffer, preserving order", () => {
    const buf = mergeTail(emptyBuffer(), [entry("1", "a"), entry("2", "b")]);
    expect(buf.entries.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("appends only the genuinely new entries from an overlapping window", () => {
    let buf = emptyBuffer();
    buf = mergeTail(buf, [entry("1", "a"), entry("2", "b"), entry("3", "c")]);
    // Next poll's tail overlaps (2, 3) and adds a new one (4).
    buf = mergeTail(buf, [entry("2", "b"), entry("3", "c"), entry("4", "d")]);
    expect(buf.entries.map((e) => e.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("updates an existing entry's text in place without duplicating or reordering", () => {
    let buf = emptyBuffer();
    buf = mergeTail(buf, [entry("1", "a"), entry("2", "still typing")]);
    buf = mergeTail(buf, [entry("2", "finished sentence"), entry("3", "c")]);
    expect(buf.entries.map((e) => e.id)).toEqual(["1", "2", "3"]);
    expect(buf.entries.find((e) => e.id === "2")?.text).toBe("finished sentence");
  });

  it("keeps the longer copy when a shorter one arrives for the same id", () => {
    // The live tail / history deliver a full message; a later heartbeat poll
    // ships the bounded per-message preview (a truncated prefix). The preview
    // must not clobber the full text back to truncated.
    let buf = emptyBuffer();
    buf = mergeTail(buf, [entry("1", "a full assistant response, all of it")]);
    buf = mergeTail(buf, [entry("1", "a full assistant respon")]); // preview prefix
    expect(buf.entries.find((e) => e.id === "1")?.text).toBe("a full assistant response, all of it");
  });

  it("treats an empty tail as a no-op", () => {
    let buf = emptyBuffer();
    buf = mergeTail(buf, [entry("1", "a")]);
    buf = mergeTail(buf, []);
    expect(buf.entries.map((e) => e.id)).toEqual(["1"]);
  });

  it("is stable when entries arrive out of the buffer's current order", () => {
    // Newest-tail entries are assumed newest-last per the brief; an id that's
    // already present keeps its original position even if it reappears.
    let buf = emptyBuffer();
    buf = mergeTail(buf, [entry("1", "a"), entry("2", "b"), entry("3", "c")]);
    buf = mergeTail(buf, [entry("1", "a-updated"), entry("3", "c-updated")]);
    expect(buf.entries.map((e) => e.id)).toEqual(["1", "2", "3"]);
    expect(buf.entries.find((e) => e.id === "1")?.text).toBe("a-updated");
    expect(buf.entries.find((e) => e.id === "3")?.text).toBe("c-updated");
  });
});

describe("prependHistory", () => {
  it("prepends older entries before the existing buffer", () => {
    let buf = emptyBuffer();
    buf = mergeTail(buf, [entry("3", "c"), entry("4", "d")]);
    buf = prependHistory(buf, [entry("1", "a"), entry("2", "b")], false);
    expect(buf.entries.map((e) => e.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("dedupes ids already present, keeping only the truly-older ones", () => {
    let buf = emptyBuffer();
    buf = mergeTail(buf, [entry("2", "b"), entry("3", "c")]);
    buf = prependHistory(buf, [entry("1", "a"), entry("2", "b-old")], false);
    // "2" was already known from the tail; history's copy is dropped, not
    // used to overwrite (history is a *supplement*, not authoritative).
    expect(buf.entries.map((e) => e.id)).toEqual(["1", "2", "3"]);
    expect(buf.entries.find((e) => e.id === "2")?.text).toBe("b");
  });

  it("sets hasMore false when the history response reports truncated=false", () => {
    let buf = emptyBuffer();
    buf = prependHistory(buf, [entry("1", "a")], false);
    expect(buf.hasMore).toBe(false);
  });

  it("sets hasMore true when the history response reports truncated=true", () => {
    let buf = emptyBuffer();
    buf = prependHistory(buf, [entry("2", "b")], true);
    expect(buf.hasMore).toBe(true);
  });

  it("starts with hasMore undefined until history has been fetched at least once", () => {
    expect(emptyBuffer().hasMore).toBeUndefined();
  });
});

describe("concise ingest (matches the web chat's Concise verbosity)", () => {
  it("strips inline [ToolName] markers from an assistant turn's text", () => {
    expect(conciseText("done[Bash]")).toBe("done");
    expect(conciseText("reading[Read]then[Edit]done")).toBe("readingthendone");
    expect(conciseText("[mcp__unifi__list]checking")).toBe("checking");
  });

  it("reduces a pure tool-call turn to empty text", () => {
    expect(conciseText("[Read][Edit]")).toBe("");
  });

  it("leaves ordinary text (including non-tool brackets) untouched", () => {
    expect(conciseText("the value at index [0] is 3")).toBe("the value at index [0] is 3");
    expect(conciseText("plain reply")).toBe("plain reply");
  });

  it("strips tool markers from assistant entries on the way into the buffer", () => {
    const buf = mergeTail(emptyBuffer(), [entry("1", "compiling[Bash]done")]);
    expect(buf.entries[0]?.text).toBe("compilingdone");
  });

  it("never rewrites user text (tool markers can't appear there, brackets are the user's)", () => {
    const buf = mergeTail(emptyBuffer(), [entry("1", "check [Read] the docs", "user")]);
    expect(buf.entries[0]?.text).toBe("check [Read] the docs");
  });

  it("strips markers on history entries too", () => {
    const buf = prependHistory(emptyBuffer(), [entry("1", "ran[Grep]nothing")], false);
    expect(buf.entries[0]?.text).toBe("rannothing");
  });

  it("keeps the shorter-preview clobber guard working on stripped lengths", () => {
    let buf = mergeTail(emptyBuffer(), [entry("1", "a full assistant response[Bash]")]);
    buf = mergeTail(buf, [entry("1", "a full assistant[Read]")]); // shorter preview
    expect(buf.entries.find((e) => e.id === "1")?.text).toBe("a full assistant response");
  });
});

describe("markdown de-noising (assistant text)", () => {
  it("strips bold markers and inline code fences that render as literal noise", () => {
    expect(conciseText("this is **important** and `code` here")).toBe("this is important and code here");
  });

  it("bares heading hashes and turns list bullets into •", () => {
    expect(conciseText("## Plan\n- first\n- second\n* third")).toBe("Plan\n• first\n• second\n• third");
  });

  it("drops blockquote markers and fenced-code fence lines (keeping the code)", () => {
    expect(conciseText("> quoted\n```js\nrun()\n```")).toBe("quoted\nrun()");
  });

  it("leaves snake_case identifiers and lone asterisks untouched", () => {
    // A coding agent's prose is full of these; treating _ or a single * as
    // emphasis would mangle real content.
    expect(conciseText("call my_helper_fn with *.ts globs")).toBe("call my_helper_fn with *.ts globs");
  });
});

describe("blank-line removal", () => {
  it("collapses empty lines within an assistant turn (markdown paragraph gaps)", () => {
    expect(conciseText("first paragraph\n\n\nsecond paragraph")).toBe("first paragraph\nsecond paragraph");
  });

  it("removes empty lines from a multi-line user turn too, without touching its text", () => {
    const buf = mergeTail(emptyBuffer(), [entry("1", "line one\n\nline two", "user")]);
    expect(buf.entries[0]?.text).toBe("line one\nline two");
  });

  it("leaves a single-line user turn (with brackets) exactly as typed", () => {
    const buf = mergeTail(emptyBuffer(), [entry("1", "check [Read] the docs", "user")]);
    expect(buf.entries[0]?.text).toBe("check [Read] the docs");
  });
});
