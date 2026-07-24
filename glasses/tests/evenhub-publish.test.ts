import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs build script, no types
import { buildCreateVersionForm, dumpFlatYaml, extractDraftId, isJwtExpired, obfuscatePassword, parseArgs, parseFlatYaml, unwrapEnvelope, versionListContains } from "../scripts/evenhub-publish.mjs";

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

describe("obfuscatePassword", () => {
  it("XORs the password bytes with the repeating email bytes, then base64s", () => {
    // "ab" ^ "a" (key repeats): 0x61^0x61=0x00, 0x62^0x61=0x03
    expect(obfuscatePassword("a", "ab")).toBe(
      Buffer.from([0x00, 0x03]).toString("base64"),
    );
  });

  it("repeats the email key across a longer password", () => {
    const email = "me@x.co";
    const password = "correct horse battery staple";
    const key = Buffer.from(email, "utf8");
    const pwd = Buffer.from(password, "utf8");
    const expected = Buffer.from(pwd.map((b, i) => b ^ key[i % key.length]));
    expect(obfuscatePassword(email, password)).toBe(expected.toString("base64"));
  });
});

describe("isJwtExpired", () => {
  const now = 1_700_000_000;

  it("is fresh when exp is comfortably in the future", () => {
    expect(isJwtExpired(makeJwt({ exp: now + 600 }), now)).toBe(false);
  });

  it("is expired when exp has passed", () => {
    expect(isJwtExpired(makeJwt({ exp: now - 1 }), now)).toBe(true);
  });

  it("treats a token dying within the safety margin as expired", () => {
    expect(isJwtExpired(makeJwt({ exp: now + 10 }), now)).toBe(true);
  });

  it("treats malformed tokens and missing exp as expired", () => {
    expect(isJwtExpired("not-a-jwt", now)).toBe(true);
    expect(isJwtExpired(makeJwt({ sub: "x" }), now)).toBe(true);
  });
});

describe("flat yaml round-trip (credentials.yaml shape)", () => {
  it("parses the credential fields the evenhub CLI writes", () => {
    const creds = parseFlatYaml(
      [
        "email: dev@example.com",
        "role: 1",
        "access_token: aaa.bbb.ccc",
        "refresh_token: ddd.eee.fff",
        "access_token_expires_in: 600",
        "refresh_token_expires_in: 1209600",
      ].join("\n"),
    );
    expect(creds).toEqual({
      email: "dev@example.com",
      role: 1,
      access_token: "aaa.bbb.ccc",
      refresh_token: "ddd.eee.fff",
      access_token_expires_in: 600,
      refresh_token_expires_in: 1209600,
    });
  });

  it("strips quotes and survives a dump/parse round-trip", () => {
    expect(parseFlatYaml("email: 'a@b.c'\ntoken: \"t\"")).toEqual({
      email: "a@b.c",
      token: "t",
    });
    const obj = { email: "a@b.c", n: 42, skipMe: undefined };
    expect(parseFlatYaml(dumpFlatYaml(obj))).toEqual({ email: "a@b.c", n: 42 });
  });
});

describe("unwrapEnvelope", () => {
  it("returns data for code 0", () => {
    expect(unwrapEnvelope({ code: 0, data: { id: 7 } }, "x")).toEqual({ id: 7 });
  });

  it("throws with the portal message on non-zero code", () => {
    expect(() => unwrapEnvelope({ code: 3, message: "nope" }, "x")).toThrow(/code 3: nope/);
  });

  it("throws on a non-envelope response", () => {
    expect(() => unwrapEnvelope("<html>", "x")).toThrow(/unexpected response shape/);
  });
});

describe("buildCreateVersionForm", () => {
  // Regression: versions/create must be multipart form data, exactly as the
  // portal frontend sends it — a JSON body is rejected with code 1001
  // "parameter parsing error".
  it("builds a FormData with draft_id and changelog", () => {
    const form = buildCreateVersionForm("d-123", "Turma v0.3.1");
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("draft_id")).toBe("d-123");
    expect(form.get("changelog")).toBe("Turma v0.3.1");
  });

  it("stringifies a numeric draft id", () => {
    expect(buildCreateVersionForm(42, "x").get("draft_id")).toBe("42");
  });

  it("omits changelog when empty or undefined, like the portal does", () => {
    expect(buildCreateVersionForm("d", "").has("changelog")).toBe(false);
    expect(buildCreateVersionForm("d", undefined).has("changelog")).toBe(false);
  });
});

describe("extractDraftId", () => {
  it("accepts a bare id or common field names", () => {
    expect(extractDraftId("d1")).toBe("d1");
    expect(extractDraftId(42)).toBe(42);
    expect(extractDraftId({ draft_id: "d2" })).toBe("d2");
    expect(extractDraftId({ draftId: "d3" })).toBe("d3");
    expect(extractDraftId({ id: "d4" })).toBe("d4");
    expect(extractDraftId({ other: 1 })).toBeUndefined();
    expect(extractDraftId(null)).toBeUndefined();
  });
});

describe("versionListContains", () => {
  // The idempotency guard: the release pipeline publishes before the git tag
  // exists, so a run that fails downstream retries at the same version — the
  // publish must detect the version already on the portal and skip.
  it("finds a version across plausible collection field names", () => {
    expect(versionListContains({ list: [{ version: "0.3.2" }] }, "0.3.2")).toBe(true);
    expect(versionListContains({ items: [{ version: "0.3.2" }] }, "0.3.2")).toBe(true);
    expect(versionListContains({ versions: [{ version: "0.3.2" }] }, "0.3.2")).toBe(true);
    expect(versionListContains({ records: [{ version: "0.3.2" }] }, "0.3.2")).toBe(true);
    expect(versionListContains([{ version: "0.3.2" }], "0.3.2")).toBe(true);
    expect(versionListContains(["0.3.2"], "0.3.2")).toBe(true);
  });

  it("is false for absent versions and unrecognized shapes", () => {
    expect(versionListContains({ list: [{ version: "0.3.1" }] }, "0.3.2")).toBe(false);
    expect(versionListContains({ list: [] }, "0.3.2")).toBe(false);
    expect(versionListContains({ total: 3 }, "0.3.2")).toBe(false);
    expect(versionListContains(null, "0.3.2")).toBe(false);
    expect(versionListContains("weird", "0.3.2")).toBe(false);
  });
});

describe("parseArgs", () => {
  it("applies repo defaults and captures overrides", () => {
    const opts = parseArgs([
      "--next-version",
      "0.3.8",
      "--changelog",
      "Private build 0.3.8",
      "--artifact",
      "your_g2app.ehpk",
      "--build-command",
      "npm run pack:remote",
      "--project-dir",
      "app",
      "--package-id",
      "com.example.app",
    ]);
    expect(opts).toEqual({
      projectDir: "app",
      artifact: "your_g2app.ehpk",
      buildCommand: "npm run pack:remote",
      packageId: "com.example.app",
      nextVersion: "0.3.8",
      changelog: "Private build 0.3.8",
      skipBuild: false,
      dryRun: false,
    });
  });

  it("defaults the artifact to the repo-root ../turma.ehpk", () => {
    expect(parseArgs(["--dry-run"]).artifact).toBe("../turma.ehpk");
  });

  it("requires a changelog unless dry-running", () => {
    expect(() => parseArgs([])).toThrow(/--changelog is required/);
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("validates the version shape and rejects unknown flags", () => {
    expect(() => parseArgs(["--next-version", "1.2", "--dry-run"])).toThrow(/x\.y\.z/);
    expect(() => parseArgs(["--frobnicate"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--changelog"])).toThrow(/requires a value/);
  });

  it("accepts boolean flags mixed with valued ones", () => {
    const opts = parseArgs(["--skip-build", "--dry-run", "--artifact", "x.ehpk"]);
    expect(opts.skipBuild).toBe(true);
    expect(opts.dryRun).toBe(true);
    expect(opts.artifact).toBe("x.ehpk");
  });
});
