import { describe, expect, it } from "bun:test";
import { refreshLoginView, type PhoneLoginElements } from "./phone-login.ts";
import type { Config } from "../core/config.ts";

// DOM-less tests in the style of glasses/src/phone-login.test.ts: the elements
// are plain objects satisfying PhoneLoginElements, so no jsdom is needed.

function fakeInput(value = ""): HTMLInputElement {
  return { value } as unknown as HTMLInputElement;
}

function fakeButton(): HTMLButtonElement {
  return { disabled: false, textContent: "" } as unknown as HTMLButtonElement;
}

function fakeHidable(hidden: boolean): HTMLElement {
  return { hidden } as unknown as HTMLElement;
}

function fakeEls(o: { loginHidden: boolean }): PhoneLoginElements {
  return {
    login: fakeHidable(o.loginHidden),
    app: fakeHidable(!o.loginHidden),
    form: {} as HTMLFormElement,
    url: fakeInput(),
    user: fakeInput(),
    password: fakeInput(),
    submit: fakeButton(),
    error: fakeHidable(true),
  };
}

const CONFIG: Config = { hubUrl: "https://turma.example.com", user: "u", password: "", pollMs: 6000 };

describe("refreshLoginView", () => {
  it("fills the form and resets the submit button when the login card is newly revealed", () => {
    const els = fakeEls({ loginHidden: true });
    els.submit.disabled = true;
    els.submit.textContent = "Signing in…";

    refreshLoginView(els, CONFIG);

    expect(els.url.value).toBe("https://turma.example.com");
    expect(els.user.value).toBe("u");
    expect(els.password.value).toBe("");
    expect(els.submit.disabled).toBe(false);
    expect(els.submit.textContent).toBe("Sign in");
    expect(els.login.hidden).toBe(false);
    expect(els.app.hidden).toBe(true);
  });

  it("keeps an in-progress form untouched when the login card is already showing (XERK-215)", () => {
    // A turma:phase broadcast re-applies the view while the operator is
    // mid-form; their typed values must survive it.
    const els = fakeEls({ loginHidden: false });
    els.url.value = "https://half-typed.example";
    els.user.value = "malcolm";
    els.password.value = "hunter2";

    refreshLoginView(els, CONFIG);

    expect(els.url.value).toBe("https://half-typed.example");
    expect(els.user.value).toBe("malcolm");
    expect(els.password.value).toBe("hunter2");
    expect(els.login.hidden).toBe(false);
    expect(els.app.hidden).toBe(true);
  });

  it("leaves an in-flight sign-in's disabled submit button alone while the card is showing", () => {
    // The submit POST is in flight when a broadcast lands: re-enabling the
    // button would invite a duplicate submit.
    const els = fakeEls({ loginHidden: false });
    els.submit.disabled = true;
    els.submit.textContent = "Signing in…";

    refreshLoginView(els, CONFIG);

    expect(els.submit.disabled).toBe(true);
    expect(els.submit.textContent).toBe("Signing in…");
  });
});
