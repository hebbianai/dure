import { defineConfig } from "vite";

/** The design-QA harness. Serves `qa/` with the app's own modules behind it. */
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  server: { port: 1439, strictPort: true },
  resolve: { alias: { "@": new URL("../../src", import.meta.url).pathname } },
});
