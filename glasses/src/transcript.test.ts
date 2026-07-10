import { describe, expect, it } from "vitest";
import { emptyBuffer, mergeTail, prependHistory } from "./transcript.ts";
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
