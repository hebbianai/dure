import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonAtomically } from "./atomic-json.mjs";

describe("atomic JSON output", () => {
  it("creates a complete document and rejects non-JSON values", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dure-json-output-"));
    try {
      const output = resolve(root, "nested", "draft.json");
      await writeJsonAtomically(
        output,
        { schemaVersion: 1 },
        { allowedRoot: root },
      );
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
        schemaVersion: 1,
      });
      await expect(
        writeJsonAtomically(resolve(root, "undefined.json"), undefined, {
          allowedRoot: root,
        }),
      ).rejects.toThrow("must be serializable");
      expect(await readdir(root)).toEqual(["nested"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes its partial file when the final rename fails", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dure-json-output-"));
    try {
      const output = resolve(root, "blocked.json");
      await mkdir(output);
      await expect(
        writeJsonAtomically(output, { schemaVersion: 1 }, { allowedRoot: root }),
      ).rejects.toThrow();
      expect(await readdir(root)).toEqual(["blocked.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
