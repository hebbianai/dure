import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone project: engine tests run via `pnpm design:coverage:test`, not the
// frontend gate; the design project owns them.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["design/engine/**/*.test.ts"],
    environment: "node",
  },
});
