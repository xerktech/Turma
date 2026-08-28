#!/usr/bin/env node
/**
 * Build the Qwen native-log corpus for the XERK-508 [Qwen][S1] projector tests
 * from the REAL Qwen Code 0.22.2 output captured by the [Qwen G0] spike
 * (`docs/qwen-g0/corpus/*.jsonl`) — the G1 no-mock lesson: assert against shapes
 * real Qwen actually emits, never this repo's guess.
 *
 * Unlike dsh (whose corpus is synthesised from its own message constructors),
 * Qwen's native log was captured directly, so this script simply concatenates the
 * two recorded sessions' rows into one JSON array the Python and JS tests both
 * consume. Regenerate with:
 *
 *   node agent/tests/qwen_corpus_gen.mjs > agent/tests/qwen_corpus.json
 *
 * The two sessions between them exercise every surface + system shape the
 * projector must handle: user text, assistant reasoning (`thought:true`) + text +
 * `functionCall` (deferred `tool_search`, `write_file`, `run_shell_command`),
 * `tool_result` `functionResponse` on the success, OS-error and hard-denied
 * (PreToolUse hook) paths, and the `system` subtypes (attribution/file-history/
 * ui_telemetry/slash_command) that must project to nothing.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS_DIR = join(HERE, '..', '..', 'docs', 'qwen-g0', 'corpus')

// In capture order: the write-and-deny session, then the hard-deny session.
const FILES = ['session-A-write-and-deny.jsonl', 'session-B-hard-deny.jsonl']

const events = []
for (const f of FILES) {
  const text = readFileSync(join(CORPUS_DIR, f), 'utf8')
  for (const line of text.split('\n')) {
    if (line.trim()) events.push(JSON.parse(line))
  }
}

process.stdout.write(JSON.stringify(events, null, 2) + '\n')
