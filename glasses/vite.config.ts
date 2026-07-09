import { defineConfig } from "vite";

// The packaged app is loaded from file:// paths inside the Even Realities
// phone app's WebView, so every asset reference must be relative.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
  },
});
