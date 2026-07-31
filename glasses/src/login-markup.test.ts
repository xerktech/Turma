import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Guards on index.html's login markup itself, as text.
//
// phone-login.test.ts drives `initPhoneLogin` with fake element objects, which
// is what keeps it DOM-less and fast — but it means it cannot see the real
// page's markup at all. Two of these invariants (the input's type, and the
// absence of `required`) were caught only by driving the built page in a real
// browser, because native constraint validation is a browser behaviour that no
// fake input reproduces: it vetoes submit *before* the JS handler runs, so the
// controller tests keep passing while the real form is dead.
const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

// The <input> tag carrying a given id, as raw text. Plain string scanning
// rather than a built-up `new RegExp(...)`: a non-literal regex trips
// Semgrep's detect-non-literal-regexp rule, and a literal-only match is both
// cheaper and one less thing to reason about.
function inputTag(id: string): string {
  const needle = `id="${id}"`;
  for (const chunk of html.split("<input")) {
    const end = chunk.indexOf(">");
    if (end === -1) continue;
    const tag = "<input" + chunk.slice(0, end + 1);
    if (tag.includes(needle)) return tag;
  }
  throw new Error(`no <input id="${id}"> in index.html`);
}

describe("login markup", () => {
  it("has a hub URL input — the field the login page collects the host in", () => {
    expect(() => inputTag("hub-url")).not.toThrow();
  });

  it("does not give the hub URL input type=url", () => {
    // type=url rejects a scheme-less "turma.example.com", which is exactly what
    // a phone keyboard invites and what normalizeHubUrl exists to repair. The
    // browser would veto submit before that code ever ran.
    expect(inputTag("hub-url")).not.toMatch(/type="url"/);
  });

  it("does not mark the hub URL input required", () => {
    // `required` hands the browser a veto on blank, pre-empting our own
    // "Enter the URL of your Turma hub." message with a native bubble.
    expect(inputTag("hub-url")).not.toMatch(/\brequired\b/);
  });

  it("keeps the URL keyboard via inputmode, having given up type=url", () => {
    expect(inputTag("hub-url")).toMatch(/inputmode="url"/);
  });

  it("ships no real host — the placeholder is an example", () => {
    expect(inputTag("hub-url")).toMatch(/placeholder="https:\/\/turma\.example\.com"/);
  });

  it("carries every id queryPhoneLoginElements looks up", () => {
    // A missing id throws at boot, inside a `void initPhoneLogin(...)` whose
    // rejection is silent — the form then falls back to a native GET submit.
    for (const id of [
      "login", "app", "dashboard", "login-form", "hub-url", "hub-user",
      "hub-password", "login-submit", "login-error", "sign-out", "app-user",
    ]) {
      expect(html, `missing id="${id}"`).toContain(`id="${id}"`);
    }
  });
});
