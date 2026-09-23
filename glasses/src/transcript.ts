import { fontStrip, undrawable } from "./font.ts";
import type { TailEntry } from "./types.ts";

// Per-session accumulating transcript buffer. Polling delivers overlapping
// windows (the agent's cheap tail probe, `hub-agent.py:transcript_tail`)
// plus, on demand, an older page from GET .../history — this module merges
// both into one ordered, deduped buffer app.ts hands to render.ts.
export interface TranscriptBuffer {
  entries: TailEntry[];
  // undefined: history has never been fetched for this session (scrolling
  // above the top should trigger a fetch). true: the server has more history
  // than what's loaded. false: we've reached the beginning.
  hasMore?: boolean;
}

export function emptyBuffer(): TranscriptBuffer {
  return { entries: [] };
}

// The agent's cheap tail flattener (`hub-agent.py:_entry_text`) appends a
// bracketed `[ToolName]` marker for every tool_use block in an assistant turn,
// concatenated with no separator and always at the very END of the text —
// e.g. "done[Bash][Read]", or a pure tool-call turn "[Read][Edit]". The
// Sessions-page web chat renders its "Concise" verbosity by omitting tool
// actions entirely (only user/assistant message text shows). The glasses view
// is inherently that same text-only surface, so we match Concise by stripping
// those markers here, at ingest — the buffer and render then both see the same
// clean, tool-free text.
//
// We strip ONLY that TRAILING run, and only when it ABUTS its text — that is
// what tells a real marker apart from ordinary bracketed prose (XERK-862). A
// real marker is never preceded by a space or tab (prose "the plan [WIP]" or
// "see the [notes] section" puts a space before its bracket; a flattened marker
// abuts its text or a line break), and, being appended at the end, always sits
// at the tail. So "the plan [WIP]", "see [1]" and a mid-sentence "[notes]" all
// survive, while a real trailing "done[Bash][Read]" is still hidden. Names
// allow a hyphen for hyphenated subagent types (qa-delta) on top of the
// CapitalCase tools (Bash, WebFetch) and MCP `server__tool` identifiers.
//
// Only assistant turns carry the markers (tool_use blocks never appear in user
// turns, and tool_result blocks are already dropped upstream), so user text is
// left untouched by conciseEntry.
//
// Done with a hand-written reverse scan rather than a regex on purpose: an
// unanchored `(?:\[…\])+$` backtracks O(n²) on bracket-heavy text that does NOT
// end in a marker (e.g. "[x]"×N + ".") — a ReDoS on this per-poll ingest path,
// which has no length clamp (assistant entries run up to INPUT_MAX_CHARS). This
// scan is linear: it peels whole markers off the end and stops at the first
// char that isn't part of one, touching no character more than once.
function isNameChar(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "-";
}
function isAlpha(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}
function stripTrailingToolMarkers(text: string): string {
  let start = text.length; // start of the trailing marker run, walked leftward
  while (start > 0 && text[start - 1] === "]") {
    // A marker is `[` + a name (first char a letter, rest name-chars) + `]`.
    let j = start - 2;
    while (j >= 0 && isNameChar(text[j]!)) j--;
    if (j < 0 || text[j] !== "[" || !isAlpha(text[j + 1]!)) break; // not a marker
    start = j; // this marker spans [j, start-1]; keep peeling the one before it
  }
  if (start === text.length) return text; // no trailing marker run
  // A real marker abuts its text or a line break; ordinary prose ("the plan
  // [WIP]") puts a space/tab before its bracket, so a run so preceded is kept.
  if (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) return text;
  return text.slice(0, start);
}

// Markdown syntax renders as literal noise on the tiny monochrome display: the
// glasses can't show weight, so bold `**…**` and inline `` `code` `` fences add
// nothing but the fence characters themselves, which eat scarce width. Heading
// hashes, list bullets, and blockquote markers are line-anchored structural
// syntax we normalize to something legible (a bullet •, bare heading text)
// rather than strip outright, and fenced-code fence lines are dropped entirely
// (the code inside stays). Underscores and single asterisks are deliberately
// left ALONE: a coding agent's prose is full of snake_case identifiers and
// glob/`*` characters that aren't emphasis and must not be mangled.
function stripMarkdown(text: string): string {
  const lines = text.split("\n").map((line) => {
    if (/^\s*```/.test(line)) return ""; // fenced-code fence -> drop the fence line
    return line
      .replace(/^\s{0,3}#{1,6}\s+/, "") // heading hashes -> bare heading text
      .replace(/^(\s*)[-*+]\s+/, "$1• ") // list bullet -> •
      .replace(/^\s{0,3}>\s?/, ""); // blockquote marker
  });
  return lines
    .join("\n")
    .replace(/`([^`]+)`/g, "$1") // inline code fences
    .replace(/\*\*([^*]+)\*\*/g, "$1"); // bold
}

// Drops blank / whitespace-only lines entirely so a message reads as one
// compact block instead of a wall punctuated by markdown's paragraph gaps —
// vertical space is scarce on the 10-line canvas. Line breaks BETWEEN non-empty
// lines (paragraph boundaries, hard-wrapped list items) are preserved; only the
// empty rows go.
function collapseBlankLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n");
}

export function conciseText(text: string): string {
  const stripped = stripMarkdown(stripTrailingToolMarkers(text));
  return collapseBlankLines(stripped).replace(/[ \t]+$/gm, "").trim();
}

function conciseEntry(entry: TailEntry): TailEntry {
  // Assistant turns get the full concise treatment (tool markers + markdown +
  // blank-line collapse); user turns are the operator's own typed/dictated text
  // and carry no markdown or tool markers, but still have their blank lines
  // collapsed so a multi-line dictation doesn't reintroduce the gaps.
  const trimmed = entry.role === "assistant" ? conciseText(entry.text) : collapseBlankLines(entry.text);
  // THEN made drawable by the G2 font (font.ts). In this order the trims see
  // exactly the raw text — a dropped glyph can't turn prose into a tool marker
  // or a code span into literal backticks — and what the font empties is just
  // re-tidied. A turn the TRIMS emptied (tool-only "[Read]") stays empty so
  // render skips it; one the FONT emptied (emoji-only) says "?".
  const safe = fontStrip(trimmed);
  const text =
    safe === trimmed ? trimmed : undrawable(trimmed, collapseBlankLines(safe).replace(/[ \t]+$/gm, "").trim());
  return text === entry.text ? entry : { ...entry, text };
}

// Merges a freshly-polled tail into the buffer: an entry already present (by
// id) is updated in place only when the incoming copy is at least as long as
// the stored one — transcript entries only grow (a streaming assistant turn
// appends; a finished message is fixed), so a SHORTER incoming copy is the
// heartbeat's bounded per-message preview (TAIL_MSG_CHARS) landing after the
// live tail / history already delivered the full message, and must not clobber
// it back to truncated. New ids are appended in the order they appear in
// `tail`, which the agent guarantees is oldest-to-newest.
export function mergeTail(buffer: TranscriptBuffer, tail: TailEntry[]): TranscriptBuffer {
  if (tail.length === 0) return buffer;
  const entries = buffer.entries.slice();
  const indexById = new Map(entries.map((e, i) => [e.id, i]));
  for (const raw of tail) {
    const incoming = conciseEntry(raw);
    const existingIndex = indexById.get(incoming.id);
    if (existingIndex !== undefined) {
      const existing = entries[existingIndex];
      if (existing && incoming.text.length >= existing.text.length) {
        entries[existingIndex] = incoming;
      }
    } else {
      indexById.set(incoming.id, entries.length);
      entries.push(incoming);
    }
  }
  return { ...buffer, entries };
}

// Prepends an older page of history fetched from GET .../history. Entries
// whose id is already known (from a prior tail merge or an earlier history
// page) are dropped rather than used to overwrite — the live tail is always
// treated as more current than a history snapshot. `truncated` (from the
// history response) becomes `hasMore`.
export function prependHistory(
  buffer: TranscriptBuffer,
  entries: TailEntry[],
  truncated: boolean
): TranscriptBuffer {
  const known = new Set(buffer.entries.map((e) => e.id));
  const older = entries.filter((e) => !known.has(e.id)).map(conciseEntry);
  return { entries: [...older, ...buffer.entries], hasMore: truncated };
}
