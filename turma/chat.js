// turma chat store — durable, searchable conversations for the /chat page.
//
// A ChatGPT-style chat page (turma/public/chat.html) talks to the same LiteLLM
// instance that already serves Whisper (see server.js LITELLM_*), and its
// history lives here: a node:sqlite DB (Node core, no npm) with a `conversations`
// table, a `messages` table, and an FTS5 `messages_fts` index for instant
// full-text search across everything the user has ever chatted.
//
// Unlike archive.js (whose organized .jsonl files are canonical and whose DB is
// a disposable index), here the DB IS the source of truth — chat has no external
// file to rebuild from — so it lives on the durable /data volume in WAL mode.
// The scaffolding (openDb/closeDb/tx, the FTS5 table + snippet() search) is
// modeled on archive.js, and the FTS query builder is reused from it verbatim.
//
// stdlib + node:sqlite only, matching the hub's zero-npm-dependency stance.
// (node:sqlite prints an ExperimentalWarning to stderr; that's expected.)

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
// Reuse the archive's safe FTS5 MATCH builder — same need (turn free text into a
// prefix-AND query without letting punctuation reach the FTS parser). Requiring
// archive.js is cheap: it opens its own DB lazily, so this has no side effects.
const { ftsQuery } = require("./archive.js");

const CHAT_DB = process.env.CHAT_DB || "/data/chat.db";

// ---- database ---------------------------------------------------------------

let db = null;

function createSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS conversations(
     id TEXT PRIMARY KEY,
     title TEXT, model TEXT,
     createdAt INTEGER, updatedAt INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS messages(
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     convId TEXT NOT NULL,
     role TEXT, content TEXT, model TEXT,
     truncated INTEGER DEFAULT 0, ts INTEGER)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(convId, id)`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
     content, convId UNINDEXED, msgId UNINDEXED, role UNINDEXED, ts UNINDEXED)`);
}

// Open (once) and ensure the schema. The DB is the source of truth (no file
// rebuild like archive.js), so a missing DB simply starts empty.
function openDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(CHAT_DB), { recursive: true });
  db = new DatabaseSync(CHAT_DB);
  db.exec("PRAGMA journal_mode=WAL");
  createSchema();
  return db;
}

// Test seam / graceful shutdown: drop the handle so a later openDb() re-opens.
function closeDb() {
  if (db) { try { db.close(); } catch { /* already closed */ } db = null; }
}

// node:sqlite's DatabaseSync has no .transaction() helper (unlike
// better-sqlite3), so wrap a unit of work in BEGIN/COMMIT by hand. Not nested.
function tx(fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
    throw e;
  }
}

function newId() {
  return crypto.randomBytes(12).toString("hex");
}
function isValidId(id) {
  return typeof id === "string" && /^[0-9a-f]{24,}$/.test(id);
}

// ---- write ------------------------------------------------------------------

// Create an empty conversation and return its full (message-less) record.
function createConversation(title, model) {
  openDb();
  const now = Date.now();
  const id = newId();
  db.prepare("INSERT INTO conversations(id,title,model,createdAt,updatedAt) VALUES(?,?,?,?,?)")
    .run(id, (title || "New chat").slice(0, 200), model || null, now, now);
  return { id, title: (title || "New chat").slice(0, 200), model: model || null, createdAt: now, updatedAt: now, messages: [] };
}

// Update a conversation's title/model and bump updatedAt. Any field left
// undefined is preserved. Returns false if the conversation is unknown.
function touchConversation(id, { title, model } = {}) {
  openDb();
  if (!isValidId(id)) return false;
  const row = db.prepare("SELECT id FROM conversations WHERE id=?").get(id);
  if (!row) return false;
  const sets = ["updatedAt=?"];
  const args = [Date.now()];
  if (title != null) { sets.push("title=?"); args.push(String(title).slice(0, 200)); }
  if (model != null) { sets.push("model=?"); args.push(String(model)); }
  args.push(id);
  db.prepare(`UPDATE conversations SET ${sets.join(", ")} WHERE id=?`).run(...args);
  return true;
}

// Append one message, index it for search, and bump the conversation's
// updatedAt in one transaction. Returns the new message id (or null if the
// conversation is unknown).
function appendMessage(id, role, content, { model, truncated } = {}) {
  openDb();
  if (!isValidId(id)) return null;
  const conv = db.prepare("SELECT id FROM conversations WHERE id=?").get(id);
  if (!conv) return null;
  const now = Date.now();
  const text = String(content == null ? "" : content);
  return tx(() => {
    const info = db.prepare(
      "INSERT INTO messages(convId,role,content,model,truncated,ts) VALUES(?,?,?,?,?,?)"
    ).run(id, role || null, text, model || null, truncated ? 1 : 0, now);
    const msgId = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO messages_fts(content,convId,msgId,role,ts) VALUES(?,?,?,?,?)")
      .run(text, id, msgId, role || null, now);
    db.prepare("UPDATE conversations SET updatedAt=? WHERE id=?").run(now, id);
    return msgId;
  });
}

// Delete a conversation, its messages, and their FTS rows. Returns whether it
// existed.
function deleteConversation(id) {
  openDb();
  if (!isValidId(id)) return false;
  const existed = !!db.prepare("SELECT id FROM conversations WHERE id=?").get(id);
  if (!existed) return false;
  tx(() => {
    db.prepare("DELETE FROM messages_fts WHERE convId=?").run(id);
    db.prepare("DELETE FROM messages WHERE convId=?").run(id);
    db.prepare("DELETE FROM conversations WHERE id=?").run(id);
  });
  return true;
}

// ---- read -------------------------------------------------------------------

// Conversation metadata, newest-first, with a message count. Cheap enough to
// serve the whole sidebar (single user, modest volume).
function listConversations(opts) {
  openDb();
  opts = opts || {};
  const limit = Math.min(Math.max(parseInt(opts.limit || 500, 10) || 500, 1), 1000);
  const rows = db.prepare(`
    SELECT c.id, c.title, c.model, c.createdAt, c.updatedAt,
           (SELECT COUNT(*) FROM messages m WHERE m.convId=c.id) AS messageCount
    FROM conversations c
    ORDER BY c.updatedAt DESC, c.id DESC
    LIMIT ?`).all(limit);
  return { conversations: rows };
}

// One conversation with its messages in order. null when unknown.
function getConversation(id) {
  openDb();
  if (!isValidId(id)) return null;
  const c = db.prepare("SELECT id,title,model,createdAt,updatedAt FROM conversations WHERE id=?").get(id);
  if (!c) return null;
  const messages = db.prepare(
    "SELECT role, content, model, truncated, ts FROM messages WHERE convId=? ORDER BY id ASC"
  ).all(id).map((m) => ({
    role: m.role, content: m.content, model: m.model || undefined,
    truncated: m.truncated ? true : undefined, ts: m.ts,
  }));
  return { id: c.id, title: c.title, model: c.model, createdAt: c.createdAt, updatedAt: c.updatedAt, messages };
}

// Full-text search across every message. Returns one hit per conversation (its
// best-ranked matching message), ranked, with a <mark>-highlighted snippet.
function searchConversations(query, opts) {
  openDb();
  const match = ftsQuery(query);
  if (!match) return { query: String(query || ""), results: [] };
  const limit = Math.min(Math.max(parseInt((opts && opts.limit) || 50, 10) || 50, 1), 200);
  const rows = db.prepare(`
    SELECT f.convId AS convId, f.role AS role, f.ts AS ts,
           c.title AS title, c.model AS model, c.updatedAt AS updatedAt,
           snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet,
           rank AS rnk
    FROM messages_fts f JOIN conversations c ON c.id = f.convId
    WHERE messages_fts MATCH ?
    ORDER BY rank
    LIMIT ?`).all(match, limit * 8);

  // One result per conversation, preserving rank order (best match first).
  const seen = new Set();
  const results = [];
  for (const r of rows) {
    if (seen.has(r.convId)) continue;
    seen.add(r.convId);
    results.push({
      id: r.convId, title: r.title || null, model: r.model || null,
      updatedAt: r.updatedAt, role: r.role || null, ts: r.ts || null,
      snippet: r.snippet || "",
    });
    if (results.length >= limit) break;
  }
  return { query: String(query || ""), results };
}

module.exports = {
  CHAT_DB,
  openDb, closeDb, isValidId, newId,
  createConversation, touchConversation, appendMessage, deleteConversation,
  listConversations, getConversation, searchConversations,
};
