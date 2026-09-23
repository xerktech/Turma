// XERK-934: `npm run dev` must serve the vendored classic scripts with a
// `default` export — engines.ts default-imports them, and Vite's own CJS
// interop only runs in `build`, so without vite.config.ts's dev plugin the
// simulator died at load. Tests and the build never go through the dev
// server, so this asks it directly.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEV = { root: ROOT, configFile: `${ROOT}/vite.config.ts`, server: { middlewareMode: true } };

describe("vite dev server", () => {
  let server: ViteDevServer;
  beforeAll(async () => {
    server = await createServer(DEV);
  });
  afterAll(() => server?.close());

  for (const file of ["chat.cjs", "board.cjs"]) {
    it(`serves src/vendor/${file} with its module.exports as the default`, async () => {
      const mod = await server.ssrLoadModule(`/src/vendor/${file}`);
      const cjs = createRequire(import.meta.url)(`./${file}`);
      expect(Object.keys(mod.default ?? {}).sort()).toEqual(Object.keys(cjs).sort());
    });
  }
});

describe("vite dev server leaves other .cjs queries alone", () => {
  it("does not wrap ?raw (it already has a default export)", async () => {
    const server = await createServer(DEV);
    try {
      const res = await server.transformRequest("/src/vendor/chat.cjs?raw");
      expect(res?.code.match(/export default/g)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
