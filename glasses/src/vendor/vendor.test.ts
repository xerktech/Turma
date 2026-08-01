import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Board, Chat, renderTranscript } from "./engines.ts";

// The vendored engines must stay byte-identical to the web source of truth, so
// the phone renders exactly what the web/Android show and never silently drifts.
// Re-copy `turma/public/<name>.js` -> `glasses/src/vendor/<name>.cjs` if this fails.
const pairs: [string, string][] = [
  ["chat.cjs", "../../../turma/public/chat.js"],
  ["board.cjs", "../../../turma/public/board.js"],
];

describe("vendored engines", () => {
  for (const [vendored, source] of pairs) {
    it(`${vendored} is byte-identical to its turma/public source`, () => {
      const v = readFileSync(fileURLToPath(new URL(vendored, import.meta.url)), "utf8");
      const s = readFileSync(fileURLToPath(new URL(source, import.meta.url)), "utf8");
      expect(v).toBe(s);
    });
  }

  it("chat.js renders a rich transcript (bubbles + tool card + thinking)", () => {
    const html = renderTranscript(
      [
        { id: "u1", role: "user", text: "run the tests" },
        {
          id: "a1",
          role: "assistant",
          blocks: [
            { t: "thinking", text: "let me run them" },
            { t: "tool_use", id: "t1", name: "Bash", input: "npm test" },
            { t: "tool_result", forId: "t1", text: "ok" },
            { t: "text", text: "All passing." },
          ],
        },
      ],
      { preset: "verbose", show: { thinking: true, tools: true, outputs: true } }
    );
    expect(html).toContain("run the tests");
    expect(html).toContain("All passing.");
    expect(html).toMatch(/action-card/); // the tool card
    expect(html).toContain("Bash");
  });

  it("chat.js verbosity hides thinking + tools when concise", () => {
    const entries = [{ id: "a1", role: "assistant", blocks: [{ t: "thinking", text: "secret" }, { t: "tool_use", id: "t1", name: "Bash", input: "ls" }, { t: "text", text: "done" }] }];
    const html = renderTranscript(entries, { preset: "concise", show: { thinking: false, tools: false, outputs: false } });
    expect(html).toContain("done");
    expect(html).not.toContain("secret");
    expect(html).not.toMatch(/action-card/);
  });

  it("chat.js renders a copy button on a fenced code block (XERK-183)", () => {
    const html = renderTranscript(
      [{ id: "a1", role: "assistant", blocks: [{ t: "text", text: "```sh\nnpm ci\n```" }] }],
      { preset: "verbose", show: { thinking: true, tools: true, outputs: true } }
    );
    expect(html).toContain('class="md-code-wrap"');
    expect(html).toContain('class="md-copy"');
    // Chat.copyCodeClick is exposed so the phone's root listener can delegate to it.
    expect(typeof Chat.copyCodeClick).toBe("function");
  });

  it("board.js merges sites and assigns unique org colors", () => {
    const agents = [
      { key: "h1", jira: { siteKey: "acme.atlassian.net", available: true, fetchedAt: "2026-08-01T00:00:00Z", tickets: [{ key: "A-1", summary: "x", statusCategory: "todo", updated: "2026-08-01T00:00:00Z" }] } },
    ];
    const sites = Board.mergeSites(agents);
    expect(sites.length).toBe(1);
    expect(sites[0]?.siteKey).toBe("acme.atlassian.net");
    const colors = Board.orgColorMap(sites.map((s) => s.siteKey));
    expect(colors.get("acme.atlassian.net")).toMatch(/var\(--s\d\)/);
  });

  it("board.js renders a board with the ticket", () => {
    const agents = [
      { key: "h1", jira: { siteKey: "acme.atlassian.net", available: true, fetchedAt: "2026-08-01T00:00:00Z", tickets: [{ key: "A-1", summary: "Fix login", statusCategory: "todo", status: "To Do", updated: "2026-08-01T00:00:00Z", project: "A" }] } },
    ];
    const sites = Board.mergeSites(agents);
    const html = Board.boardHtml(sites, "", { now: 1_700_000_000_000, allKeys: ["acme.atlassian.net"] });
    expect(html).toContain("Fix login");
    expect(html).toContain("A-1");
  });
});
