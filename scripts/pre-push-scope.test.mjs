import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("local Git hooks", () => {
  for (const hookName of ["pre-commit", "pre-push"]) {
    it(`${hookName} is intentionally non-blocking`, () => {
      const hookPath = path.join(repositoryRoot, ".githooks", hookName);
      const source = fs.readFileSync(hookPath, "utf8");

      expect(source).toContain("exit 0");
      expect(source).not.toMatch(/\b(?:git|node|pnpm|cargo)\b/);

      const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-hook-input-"));
      const inputPath = path.join(root, "refs");
      fs.writeFileSync(
        inputPath,
        "refs/heads/probe 1111111111111111111111111111111111111111 refs/heads/main 2222222222222222222222222222222222222222\n",
      );
      const input = fs.openSync(inputPath, "r");
      let result;
      try {
        // The hook may exit without reading stdin; a file avoids a parent-side EPIPE.
        result = spawnSync("sh", [hookPath, "origin", "unused"], {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: [input, "pipe", "pipe"],
          timeout: 1_000,
        });
      } finally {
        fs.closeSync(input);
        fs.rmSync(root, { recursive: true, force: true });
      }

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });
  }
});
