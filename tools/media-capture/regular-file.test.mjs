import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRegularFileNoFollow } from "./regular-file.mjs";

describe("regular-file reads without symlink traversal", () => {
  it("reads current bytes and rejects symbolic links", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dure-regular-file-"));
    try {
      const file = resolve(root, "evidence.mdx");
      const link = resolve(root, "linked-evidence.mdx");
      await writeFile(file, "first proof\n", "utf8");
      expect((await readRegularFileNoFollow(file)).toString("utf8")).toBe(
        "first proof\n",
      );
      await writeFile(file, "second proof\n", "utf8");
      expect((await readRegularFileNoFollow(file)).toString("utf8")).toBe(
        "second proof\n",
      );
      await symlink(file, link);
      await expect(readRegularFileNoFollow(link)).rejects.toThrow(
        "not a regular file",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
