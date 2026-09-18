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
// bracketed `[ToolName]` marker for every tool_use block in an assistant turn
// — e.g. "done[Bash]", or a pure tool-call turn "[Read][Edit]". The
// Sessions-page web chat now renders its "Concise" verbosity by omitting tool
// actions entirely (only user/assistant message text shows). The glasses view
// is inherently that same text-only surface — it has no tool cards and no
// verbosity control — so we match Concise by stripping those markers here, at
// ingest, the buffer and render both seeing the same clean, tool-free text.
//
// XERK-862: strip ONLY a TRAILING run of markers, not any bracketed word. The
// old global strip deleted ANY `[Word]` from an assistant turn, so prose like
// "see the [notes] section" or "the plan [WIP]" lost its bracketed word
// outright. Within one transcript entry a turn's tool_use blocks sit at the end
// (the turn yields at the first tool call), so `_entry_text` puts a real marker
// run at the very END, abutting the text with no separator — while prose puts a
// space before its bracket. So we mirror the web/Android `degradedBlocks`
// (XERK-861) conditions: a trailing run of concatenated markers, each a
// plausible tool name (`-` covers hyphenated subagent types like qa-delta;
// MCP `server__tool` names carry underscores), and only when the run is NOT
// preceded by a space or tab. Only assistant turns are treated (user text keeps
// its brackets; `conciseEntry` already guards the role).
const TRAILING_MARKER_RUN = /(?:\[[A-Za-z][A-Za-z0-9_-]*\])+$/;

// Drop the trailing tool-marker run (if any) an assistant turn ends with,
// leaving bracketed prose and any non-trailing bracket untouched.
function stripTrailingMarkers(text: string): string {
  const m = TRAILING_MARKER_RUN.exec(text);
  if (!m) return text;
  const start = m.index;
  if (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) return text;
  return text.slice(0, start).replace(/\s+$/, "");
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
  const stripped = stripMarkdown(stripTrailingMarkers(text));
  return collapseBlankLines(stripped).replace(/[ \t]+$/gm, "").trim();
}

function conciseEntry(entry: TailEntry): TailEntry {
  // Assistant turns get the full concise treatment (tool markers + markdown +
  // blank-line collapse); user turns are the operator's own typed/dictated text
  // and carry no markdown or tool markers, but still have their blank lines
  // collapsed so a multi-line dictation doesn't reintroduce the gaps.
  const text = entry.role === "assistant" ? conciseText(entry.text) : collapseBlankLines(entry.text);
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
