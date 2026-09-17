import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createEntryCommand, filesPaneTitle } from "./filesPane";

it.skipIf(process.platform === "win32")("creates nested entries literally in the selected folder", () => {
  const root = mkdtempSync(join(tmpdir(), "dure-file-create-"));
  try {
    for (const kind of ["file", "dir"] as const) {
      const name = `nested 'folder'/${kind} $(literal)`;
      execFileSync("/bin/sh", ["-c", createEntryCommand(root, name, kind)]);
      expect(existsSync(join(root, name))).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("uses the nearest matching project on the exact host, without reordering projects", () => {
  const projects = [
    { id: "parent", name: "Parent", path: "/repo", kind: "local" as const, isRepo: true },
    { id: "nested", name: "Nested", path: "/repo/nested/", kind: "local" as const, isRepo: true },
    { id: "remote", name: "Remote", path: "/repo", kind: "ssh" as const, sshHostId: "host", isRepo: true },
  ];
  expect(filesPaneTitle({ source: "local", cwd: "/repo/nested/child", label: "" }, projects)).toBe("Nested");
  expect(filesPaneTitle({ source: "ssh", hostId: "host", cwd: "/repo/nested", label: "" }, projects)).toBe("Remote");
  expect(filesPaneTitle({ source: "ssh", hostId: "other", cwd: "/repo/.worktrees/task", label: "" }, projects)).toBe("repo");
  expect(filesPaneTitle(null, projects)).toBeNull();
  expect(projects.map((project) => project.id)).toEqual(["parent", "nested", "remote"]);
});
