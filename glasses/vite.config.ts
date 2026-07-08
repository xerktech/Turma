import { defineConfig } from "vite";

// The glasses UI is composed as plain text and pushed to the G2 over the Even
// Hub SDK, so there's nothing framework-specific to configure. In the browser
// (npm run dev) the app renders into a simulated 576x288 display via the DOM
// backend — see src/display/dom.ts.
export default defineConfig({
  root: ".",
  build: { outDir: "dist", target: "es2020" },
});
