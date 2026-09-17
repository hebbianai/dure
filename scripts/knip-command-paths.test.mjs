import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const knip = fileURLToPath(new URL("../node_modules/knip/bin/knip.js", import.meta.url));
const roots = [];

function analyze(source) {
  const root = mkdtempSync(join(tmpdir(), "dure-knip-command-paths-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  writeFileSync(join(root, "knip.json"), JSON.stringify({
    entry: ["entry.mjs"],
    project: ["*.mjs"],
  }));
  writeFileSync(join(root, "entry.mjs"), source);
  const result = spawnSync(process.execPath, [knip, "--reporter", "json", "--no-progress"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, report: JSON.parse(result.stdout) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Knip command path classification", () => {
  it("keeps unavailable OS executables outside the source module graph", () => {
    // A foreign-platform executable is absent on the verifier's OS. Knip
    // must analyze the caller without treating the command as a module import.
    const result = analyze(`
      import { spawnSync, execFileSync } from "node:child_process";
      spawnSync("/opt/dure-knip-fixture-external", ["--version"]);
      execFileSync("/usr/bin/dure-knip-fixture-external", ["--version"]);
    `);
    expect(result).toEqual({ status: 0, report: { issues: [] } });
  });

  it("still reports missing source imports and relative executable entries", () => {
    const result = analyze(`
      import "./missing-module.mjs";
      import { spawnSync } from "node:child_process";
      spawnSync("./missing-worker.mjs", []);
    `);
    expect(result.status).toBe(1);
    const unresolved = result.report.issues.flatMap((issue) => issue.unresolved ?? []);
    expect(unresolved.map((issue) => issue.name).sort()).toEqual([
      "./missing-module.mjs",
      "./missing-worker.mjs",
    ]);
  });
});
