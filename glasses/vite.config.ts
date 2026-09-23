import { defineConfig, type Plugin } from "vite";

// The vendored engines (src/vendor/*.cjs) are classic-script CommonJS that must
// stay byte-identical to turma/public/*.js (vendor.test.ts), so they can't be
// rewritten as ESM. `vite build` converts them through its commonjs transform,
// but the dev server serves source files as-is, and a raw CJS file has no
// `default` export — engines.ts's default import then kills the whole page
// (XERK-921). Wrap them in a CJS shim at serve time only; the bytes on disk are
// untouched and the production build keeps its own commonjs path.
const VENDOR_CJS = /\/src\/vendor\/[^/]+\.cjs(?:\?|$)/;

function vendorCjsDev(): Plugin {
  return {
    name: "turma-vendor-cjs-dev",
    apply: "serve",
    transform(code, id) {
      if (!VENDOR_CJS.test(id)) return null;
      return {
        code: `const module = { exports: {} };\nconst exports = module.exports;\n${code}\nexport default module.exports;\n`,
        map: null,
      };
    },
  };
}

// The packaged app is loaded from file:// paths inside the Even Realities
// phone app's WebView, so every asset reference must be relative.
export default defineConfig({
  base: "./",
  plugins: [vendorCjsDev()],
  build: {
    target: "es2022",
  },
});
