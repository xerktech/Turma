// Web ⇄ Android prose parity harness (XERK-2140).
//
// chat.js `renderProse` builds HTML; Android's `parseProse` (Prose.kt) builds a
// typed tree. To compare them, this module (1) generates ONE deterministic input
// corpus and (2) reads each web render back into the canonical tree that
// android's ProseParityTest.kt builds from parseProse. The pairs are committed
// as android/app/src/test/resources/prose-parity.json, so:
//   - prose-parity.test.js fails when chat.js (or this file) changes the
//     fixture without it being regenerated;
//   - ProseParityTest.kt fails when Prose.kt disagrees with the fixture.
// Regenerate with: node turma/tests/prose-parity.js
//
// The canonical tree folds away the differences that are DELIBERATE, and only
// those (each named in .claude/rules/chat-prose.md):
//   - lists are flat depth-tagged rows, and adjacent lists merge (Android keeps a
//     marker switch in one block where the web opens a second list);
//   - a paragraph of nothing but whitespace is dropped (Android's block spacing
//     replaces it), and adjacent text runs merge;
//   - the boundary newline the web keeps beside a raw SVG block is dropped.
//
// Canonical shapes (JSON):
//   block: ["p", spans] | ["code", lang, body] | ["h", level, spans] | ["hr"]
//        | ["q", blocks] | ["list", [[depth, marker, spans], …]]
//        | ["table", [cellSpans…], [align…], [[cellSpans…]…]] | ["svg", source]
//   span:  "text" | ["c", text] | ["a", label, url] | ["img", alt, url]
//        | ["s", "b"/"i"/"bi"/"x"…, spans]

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { renderProse } = require("../public/chat.js");

const FIXTURE = path.join(__dirname, "..", "..", "android", "app", "src", "test", "resources", "prose-parity.json");

// ---- corpus ---------------------------------------------------------------

// A small seeded PRNG (mulberry32), so the corpus is identical on every run and
// every machine — the fixture is only checkable if regenerating it is exact.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tokens weighted toward what the passes key on. The exotic whitespace and
// digits are where the JS and JVM character classes differ (`\s`, `\d`, `.`,
// `trim()`), which is the divergence class this harness exists to catch.
const ODD_SPACE = ["\u00a0", "\u2028", "\u2029", "\ufeff", "\u0085", "\u1680", "\u2003", "\u3000",
  "\u001c", "\u001f", "\u000b", "\u000c", "\u200b", "\u202f", "\u205f"];
const TOKENS = [
  ["a", 8], ["word", 6], ["x_y", 2], ["Z9", 2], ["\u00e9", 1], ["\u0663", 1], ["\uff11", 1], ["\ud83d\ude00", 1],
  [" ", 12], ["  ", 3], ["    ", 2], ["\t", 2], ["\n", 10], ["\n\n", 3], ["\r\n", 2], ["\r", 1],
  ["*", 6], ["**", 4], ["***", 2], ["~~", 3], ["~", 1], ["_", 1], ["`", 4], ["``", 1], ["```", 3],
  ["#", 2], ["## ", 3], ["###### ", 1], ["- ", 4], ["* ", 2], ["+ ", 1], ["1. ", 3], ["2) ", 1],
  ["---", 2], ["***\n", 1], ["> ", 3], [">", 1], ["|", 5], ["|---|", 2], [":-:", 1], ["\\|", 1],
  ["https://ex.am/p_(q)", 2], ["http://e.x/a.", 1], ["[lbl](https://u.v/w)", 2],
  ["![alt](https://i.j/k.png)", 1], ["![](data:image/png;base64,AA)", 1],
  ["<svg>", 2], ["<svg ", 1], ["</svg>", 2], ["</svg >", 1], ["<SVG>", 1], ["<\u017fvg>", 1], ["</\u017fvg>", 1], ["<b>", 1], ["&amp;", 1],
  ["\"'", 1], ["(", 1], [")", 1], ["[", 1], ["]", 1], ["!", 1], [".", 2], [":", 1],
  ["#!", 1], ["\ud83d", 1], ["\ude00", 1],
].concat(ODD_SPACE.map((s) => [s, 1]));
const TOTAL = TOKENS.reduce((n, t) => n + t[1], 0);

function pick(r) {
  // Now and then any BMP code unit at all, lone surrogates included, so a class
  // nobody thought to list still gets sampled.
  if (r() < 0.06) return String.fromCharCode(Math.floor(r() * 0x10000));
  let x = r() * TOTAL;
  for (const [t, w] of TOKENS) { if ((x -= w) < 0) return t; }
  return TOKENS[0][0];
}

// Hand-written shapes the random walk rarely builds whole: a real table, a
// nested list, a fenced block, an SVG document, constructs indented by exotic
// whitespace. Each is also mutated below.
const SEEDS = [
  "# Title\n\nSome **bold** and *it* and `code` text.\n\n- one\n- two\n  - nested\n1. first\n2. second",
  "| a | b |\n|:--|--:|\n| `x` | **y** |\n| 1 |",
  "```js\nconst a = 1;\n```\nafter",
  "````\n```\ninner\n````",
  "text\n<svg viewBox=\"0 0 1 1\"><rect/></svg>\nmore",
  "```svg\n<svg><circle/></svg>\n```",
  "> quote\n> > nested\n> - item",
  "- a\n  wrapped\n- b\n\n- c",
  "1. a\n- b\n3. c",
  "## H #\n---\n***\n___",
  "see https://example.com/Foo_(bar)). and [x](https://y.z)",
  "***both*** ~~gone~~ *a **b** c*",
  "\u00a0# nbsp heading\n\u3000- ideographic bullet\n\ufeff```\nbom fence\n```",
  "## H\u0085\n- item\u2028still\n> q\u2029q",
  "a\u001c*b*\u001c\n\u001f```\nx\n```",
  "| a\u00a0| b |\n|---|---|\n|\u3000x | y\ufeff|",
  "1\u0663. arabic digit\n\uff11. fullwidth digit",
  "<\u017fvg></\u017fvg>\n<svg>\ud800</svg>\n```\n<svg>\udc00a</svg>\n```",
  "`` \u001c `` `` \u1680 `` ``\u00a0x\u00a0``",
];

function mutate(r, s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const x = r();
    if (x < 0.06) { out.push(pick(r)); }               // insert
    else if (x < 0.1) { i++; }                           // delete
    else if (x < 0.13) { out.push(pick(r)); i++; }      // replace
    else { out.push(s[i]); i++; }
  }
  return out.join("");
}

const RANDOM_CASES = Number(process.env.PROSE_PARITY_CASES) || 4000;
const SEED_MUTATIONS = 60;

function corpus() {
  const r = rng(Number(process.env.PROSE_PARITY_SEED) || 2140);
  const out = SEEDS.slice();
  for (const s of SEEDS) for (let k = 0; k < SEED_MUTATIONS; k++) out.push(mutate(r, s));
  for (let k = 0; k < RANDOM_CASES; k++) {
    const n = 1 + Math.floor(r() * (Number(process.env.PROSE_PARITY_LEN) || 24));
    let s = "";
    for (let j = 0; j < n; j++) s += pick(r);
    out.push(s);
  }
  return out;
}

// ---- web HTML → canonical tree --------------------------------------------

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
function unesc(s) { return s.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]); }

// renderProse's output is a closed vocabulary: every `<` in it is a tag the
// renderer wrote (all text went through esc()), so a tag scan is exact.
function tokenize(html) {
  const toks = [];
  const re = /<(\/?)([a-zA-Z0-9]+)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[4] != null) { toks.push({ text: unesc(m[4]) }); continue; }
    const attrs = {};
    const ar = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = ar.exec(m[3]))) attrs[a[1]] = a[2] == null ? "" : unesc(a[2]);
    toks.push({ close: m[1] === "/", tag: m[2].toLowerCase(), attrs });
  }
  return toks;
}

const BLOCK_TAGS = new Set(["div", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "blockquote", "ul", "ol", "table"]);

function canonWeb(html) {
  const toks = tokenize(html);
  let p = 0;
  const peek = () => toks[p];
  const expectClose = (tag) => {
    const t = toks[p++];
    if (!t || !t.close || t.tag !== tag) throw new Error("expected </" + tag + "> at token " + (p - 1) + " in " + html);
  };
  const isBlockStart = (t) => t && !t.close && (BLOCK_TAGS.has(t.tag) ||
    (t.tag === "img" && /\bmd-svg\b/.test(t.attrs.class || "")));

  // Inline content up to a closing tag (or a block start at the top level).
  function inline(stopTag, stopAtList) {
    const spans = [];
    for (;;) {
      const t = peek();
      if (!t) break;
      if (stopAtList && !t.close && (t.tag === "ul" || t.tag === "ol")) break;
      if (t.close) { if (t.tag === stopTag || !stopTag) break; throw new Error("stray </" + t.tag + "> in " + html); }
      if (t.text != null) { spans.push(t.text); p++; continue; }
      if (!stopTag && isBlockStart(t)) break;
      p++;
      if (t.tag === "code") {
        let s = "";
        while (peek() && peek().text != null) s += toks[p++].text;
        expectClose("code");
        spans.push(["c", s]);
      } else if (t.tag === "a") {
        let s = "";
        while (peek() && peek().text != null) s += toks[p++].text;
        expectClose("a");
        spans.push(["a", s, t.attrs.href]);
      } else if (t.tag === "img") {
        spans.push(["img", t.attrs.alt, t.attrs.src]);
      } else if (t.tag === "strong" || t.tag === "em" || t.tag === "del") {
        let style = t.tag === "strong" ? "b" : t.tag === "em" ? "i" : "x";
        // `***x***` is <strong><em>…</em></strong> on the web and ONE Styled(bold,
        // italic) on Android; only that exact pairing folds.
        const n = peek();
        if (t.tag === "strong" && n && !n.close && n.tag === "em" && /\bmd-em\b/.test(n.attrs.class || "") &&
            /\bmd-strong\b/.test(t.attrs.class || "") && bothShape(p)) {
          p++;
          const inner = inline("em");
          expectClose("em");
          expectClose("strong");
          spans.push(["s", "bi", inner]);
          continue;
        }
        const inner = inline(t.tag);
        expectClose(t.tag);
        spans.push(["s", style, inner]);
      } else {
        throw new Error("unexpected inline <" + t.tag + "> in " + html);
      }
    }
    return spans;
  }

  // renderEmph writes the opener and closer of `***` in one go, so the <em> it
  // opens closes immediately before the matching </strong>. Distinguish that
  // from `**<em>…</em> more**` by finding where the <em> closes.
  function bothShape(at) {
    let depth = 0;
    for (let q = at; q < toks.length; q++) {
      const t = toks[q];
      if (t.text != null) continue;
      if (t.tag !== "em") continue;
      if (!t.close) depth++;
      else if (--depth === 0) { const n = toks[q + 1]; return !!n && n.close && n.tag === "strong"; }
    }
    return false;
  }

  // A web list nests <ul>/<ol> inside the open <li>; Android flattens it to
  // depth-tagged rows with the marker resolved (ordered numbering continues from
  // `start`, as the browser derives it).
  function listItems(rows, depth) {
    const t = toks[p++];
    let num = t.tag === "ol" ? (t.attrs.start != null ? parseInt(t.attrs.start, 10) : 1) : 0;
    for (;;) {
      const n = peek();
      if (n && n.close && n.tag === t.tag) { p++; break; }
      if (!n || n.close || n.tag !== "li") throw new Error("expected <li> in " + html);
      p++;
      rows.push([depth, t.tag === "ol" ? num + "." : depth > 0 ? "\u25e6" : "\u2022", inline("li", true)]);
      while (peek() && !peek().close && (peek().tag === "ul" || peek().tag === "ol")) listItems(rows, depth + 1);
      expectClose("li");
      if (t.tag === "ol") num++;
    }
  }

  function blocks(stopTag) {
    const out = [];
    let para = [];
    const flushPara = () => { if (para.length) { out.push(["p", para]); para = []; } };
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.close && t.tag === stopTag) break;
      if (t.close) throw new Error("stray </" + t.tag + "> in " + html);
      if (!isBlockStart(t)) { para.push(...inline(null)); continue; }
      flushPara();
      p++;
      if (t.tag === "div") {
        // <div class="md-code-wrap"><button>…</button><pre data-lang><code>…</code></pre></div>
        let depth = 1, lang = "", body = "", inCode = false;
        while (depth > 0) {
          const k = toks[p++];
          if (k.text != null) { if (inCode) body += k.text; continue; }
          if (k.tag === "div") depth += k.close ? -1 : 1;
          else if (k.tag === "pre" && !k.close) lang = k.attrs["data-lang"] || "";
          else if (k.tag === "code") inCode = !k.close;
        }
        out.push(["code", lang, body]);
      } else if (/^h[1-6]$/.test(t.tag)) {
        const spans = inline(t.tag);
        expectClose(t.tag);
        out.push(["h", Number(t.tag[1]), spans]);
      } else if (t.tag === "hr") {
        out.push(["hr"]);
      } else if (t.tag === "blockquote") {
        const inner = blocks("blockquote");
        expectClose("blockquote");
        out.push(["q", inner]);
      } else if (t.tag === "ul" || t.tag === "ol") {
        p--;
        const rows = [];
        listItems(rows, 0);
        out.push(["list", rows]);
      } else if (t.tag === "table") {
        const header = [], aligns = [], rows = [];
        let row = null, section = null;
        for (;;) {
          const k = toks[p++];
          if (k.close && k.tag === "table") break;
          if (k.text != null) throw new Error("text in table structure: " + html);
          if (k.tag === "thead" || k.tag === "tbody") { section = k.close ? null : k.tag; continue; }
          if (k.tag === "tr") { if (!k.close) row = []; else if (section === "tbody") rows.push(row); continue; }
          if ((k.tag === "th" || k.tag === "td") && !k.close) {
            const m = /text-align:(\w+)/.exec(k.attrs.style || "");
            if (k.tag === "th") aligns.push(m ? m[1] : "");
            const cell = inline(k.tag);
            expectClose(k.tag);
            (k.tag === "th" ? header : row).push(normSpans(cell));
          }
        }
        out.push(["table", header, aligns, rows]);
      } else if (t.tag === "img") {
        out.push(["svg", decodeURIComponent(t.attrs.src.replace(/^data:image\/svg\+xml,/, ""))]);
      }
    }
    flushPara();
    return out;
  }

  return normBlocks(blocks(null), true);
}

// ---- canonical normalisation (shared shape rules) -------------------------

function normSpans(spans) {
  const out = [];
  for (const s of spans) {
    if (typeof s === "string") {
      if (s === "") continue;
      if (typeof out[out.length - 1] === "string") out[out.length - 1] += s;
      else out.push(s);
    } else if (s[0] === "s") {
      out.push(["s", s[1], normSpans(s[2])]);
    } else {
      out.push(s);
    }
  }
  return out;
}

const JS_BLANK = /^\s*$/;
function spansBlank(spans) {
  return spans.every((s) => typeof s === "string" && JS_BLANK.test(s));
}

// `web` applies the one web-only fold: the boundary newline renderSvgAndText
// keeps on either side of a raw SVG block, which Android's block spacing replaces.
function normBlocks(blocks, web) {
  let out = [];
  for (const b of blocks) {
    if (b[0] === "p") out.push(["p", normSpans(b[1])]);
    else if (b[0] === "h") out.push(["h", b[1], normSpans(b[2])]);
    else if (b[0] === "q") out.push(["q", normBlocks(b[1], web)]);
    else if (b[0] === "list") out.push(["list", b[1].map((r) => [r[0], r[1], normSpans(r[2])])]);
    else out.push(b);
  }
  if (web) {
    for (let i = 0; i < out.length; i++) {
      if (out[i][0] !== "svg") continue;
      const prev = out[i - 1], next = out[i + 1];
      if (prev && prev[0] === "p") trimEdge(prev[1], false);
      if (next && next[0] === "p") trimEdge(next[1], true);
    }
  }
  out = out.filter((b) => !(b[0] === "p" && spansBlank(b[1])));
  const merged = [];
  for (const b of out) {
    const last = merged[merged.length - 1];
    if (b[0] === "list" && last && last[0] === "list") last[1].push(...b[1]);
    else merged.push(b);
  }
  return merged;
}

function trimEdge(spans, leading) {
  const i = leading ? 0 : spans.length - 1;
  if (typeof spans[i] !== "string") return;
  const t = leading ? spans[i].replace(/^\n/, "") : spans[i].replace(/\n$/, "");
  if (t === "") spans.splice(i, 1); else spans[i] = t;
}

function buildFixture() {
  return corpus().map((input) => ({ input, web: canonWeb(renderProse(input)) }));
}

function serialize(cases) {
  return "[\n" + cases.map((c) => JSON.stringify(c)).join(",\n") + "\n]\n";
}

module.exports = { corpus, canonWeb, buildFixture, serialize, FIXTURE };

if (require.main === module) {
  const cases = buildFixture();
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, serialize(cases));
  console.log("wrote " + cases.length + " cases to " + path.relative(process.cwd(), FIXTURE));
}
