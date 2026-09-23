import { defineConfig, type Plugin } from "vite";

// src/vendor/*.cjs are the dashboard's classic scripts, vendored byte-identical
// and default-imported by engines.ts. `vite build` converts them via its
// commonjs plugin, but the dev server does no CJS interop for source files
// (optimizeDeps only pre-bundles node_modules), so dev served them raw with no
// `default` export and the app died at load (XERK-934). Give them a `module`
// to assign to and export it. Their only CJS surface is `module.exports = …`.
function vendoredCjsInDev(): Plugin {
  return {
    name: "turma-vendored-cjs-dev",
    apply: "serve",
    transform(code, id) {
      // Only the module itself — `?raw`/`?url` already carry their own default.
      const [path = "", query = ""] = id.split("?");
      if (!/\/src\/vendor\/[^/]+\.cjs$/.test(path)) return null;
      if (!/^(import)?(&?t=\d+)?$/.test(query)) return null;
      return {
        code: `const module = { exports: {} }; ${code}\nexport default module.exports;\n`,
        map: null,
      };
    },
  };
}

// The packaged app is loaded from file:// paths inside the Even Realities
// phone app's WebView, so every asset reference must be relative.
export default defineConfig({
  base: "./",
  plugins: [vendoredCjsInDev()],
  build: {
    target: "es2022",
  },
});
