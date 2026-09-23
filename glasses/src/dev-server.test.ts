import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";

// XERK-921: the dev server must hand the vendored CJS engines to the browser
// with a default export, or engines.ts's default import kills the page. This
// drives the real dev-server transform (vite.config.ts), not vitest's own CJS
// interop, which would pass with no shim at all.
const root = fileURLToPath(new URL("..", import.meta.url));

describe("vite dev server: vendored engines", () => {
  let server: ViteDevServer;
  beforeAll(async () => {
    server = await createServer({ root, configFile: `${root}vite.config.ts`, logLevel: "silent", server: { hmr: false, ws: false } });
  });
  afterAll(async () => { await server?.close(); });

  for (const [file, probe] of [["board.cjs", "categoryOf"], ["chat.cjs", "buildItems"]] as const) {
    it(`serves ${file} as ESM with a working default export`, async () => {
      const out = await server.transformRequest(`/src/vendor/${file}`);
      expect(out?.code).toMatch(/\nexport default module\.exports;\n/);
      // Evaluate what the browser would get: the default export is module.exports.
      const api = new Function(`${out!.code.replace(/\nexport default module\.exports;\n/, "\n")}\nreturn module.exports;`)();
      expect(typeof api[probe]).toBe("function");
    });

    it(`keeps ${file}'s line numbers (the prefix adds no line)`, async () => {
      const out = await server.transformRequest(`/src/vendor/${file}`);
      const disk = readFileSync(`${root}src/vendor/${file}`, "utf8");
      const lineOf = (src: string) => src.split("\n").findIndex((l) => l.includes(`function ${probe}(`));
      expect(lineOf(disk)).toBeGreaterThan(0);
      expect(lineOf(out!.code)).toBe(lineOf(disk));
    });
  }
});
