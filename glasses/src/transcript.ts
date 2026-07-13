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
// is inherently that same text-only surface, so we match Concise by stripping
// those markers here, at ingest — the buffer, the typewriter reveal length, and
// render then all see the same clean, tool-free text. Only assistant turns
// carry the markers (tool_use blocks never appear in user turns, and
// tool_result blocks are already dropped upstream), so user text — which may
// legitimately contain brackets — is left untouched. Tool names are CapitalCase
// (Bash, WebFetch, AskUserQuestion) or MCP `server__tool` identifiers, always
// concatenated with no separator, matching the format `_entry_text` emits.
const TOOL_MARKER = /\[[A-Za-z][A-Za-z0-9_]*\]/g;

export function conciseText(text: string): string {
  return text.replace(TOOL_MARKER, "").replace(/[ \t]+$/gm, "").trim();
}

function conciseEntry(entry: TailEntry): TailEntry {
  if (entry.role !== "assistant") return entry;
  const text = conciseText(entry.text);
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
