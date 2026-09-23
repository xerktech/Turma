import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAdvW } from "@evenrealities/pretext";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Every non-ASCII character the glasses sources can put on the G2 display must
// exist in the firmware font (XERK-923). The G2 renders through LVGL with a
// fixed fallback chain (evenroster -> evenroster_crylgrek -> cn -> evenemoji);
// a codepoint none of them carry draws as a blank — "✗ that host is offline"
// lost its marker, and the simulator logged `glyph dsc. not found for U+2717`.
// `@evenrealities/pretext` ships Even's own per-glyph table for that chain, and
// `getAdvW` returns 0 for a codepoint the chain lacks.
//
// Scans source literals rather than rendered output so a new one is caught the
// day it lands, not the day some test happens to render it. It walks the
// TypeScript syntax tree — string, template and JSX text, escapes decoded — so
// comments never count and a `//` or `/*` inside a string, a `\u2717` escape,
// or a `${}` template can't hide one. It covers source literals only: session
// content arriving from the hub is not sanitised here. The phone WebView
// (phone/, phone-login.ts) and the vendored web chat engine (vendor/) render
// in a browser with system fonts, so they are out of scope.
const SRC = new URL(".", import.meta.url).pathname;
const PHONE_ONLY = new Set(["phone", "vendor", "phone-login.ts"]);

function glassesSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (PHONE_ONLY.has(d.name)) return [];
    const p = join(dir, d.name);
    if (d.isDirectory()) return glassesSources(p);
    return d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") ? [p] : [];
  });
}

function literalText(file: string): string {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const parts: string[] = [];
  const visit = (node: ts.Node): void => {
    // StringLiteralLike = "…", '…' and `…` with no substitutions; a `${}`
    // template splits into a head, middles and a tail.
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      parts.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return parts.join("\n");
}

describe("G2 font coverage", () => {
  it("has a glyph for every non-ASCII character in the glasses sources", () => {
    const missing: string[] = [];
    for (const file of glassesSources(SRC)) {
      const seen = new Set(literalText(file).match(/[^\x00-\x7f]/gu) ?? []);
      for (const ch of seen) {
        const cp = ch.codePointAt(0)!;
        if (getAdvW(cp) === 0) {
          missing.push(`${file.slice(SRC.length)}: ${ch} U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("flags the glyphs the firmware font is known to lack", () => {
    // Pins the table itself: if pretext ever stopped reporting ✗/✓ as absent,
    // the scan above would pass vacuously.
    expect(getAdvW(0x2717)).toBe(0); // ✗
    expect(getAdvW(0x2713)).toBe(0); // ✓
    expect(getAdvW("x".codePointAt(0)!)).toBeGreaterThan(0);
    expect(getAdvW("√".codePointAt(0)!)).toBeGreaterThan(0);
  });
});
