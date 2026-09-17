import { defineConfig } from "vitest/config";

// Keep the mobile server off the desktop's legacy origin; taking that port can
// redirect an existing WebView to another application.
const DEV_PORT = 1430;

export default defineConfig({
  clearScreen: false,
  resolve: {
    alias: { "@": new URL("../src", import.meta.url).pathname },
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    // A phone on the LAN loads the dev server from the device, so it cannot be
    // bound to loopback the way the desktop dev server is.
    host: "0.0.0.0",
    fs: { allow: [".."] },
  },
  build: {
    target: "es2021",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
