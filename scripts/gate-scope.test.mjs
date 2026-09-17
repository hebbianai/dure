import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUSH_GATE_ORDER } from "./lib/push-gate-contract.mjs";
import { collectScopeEvidence, describeScope } from "./gate-scope.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("gate:scope advisory", () => {
  it("tells a documentation-only change that it has nothing to run", () => {
    const result = describeScope([
      "AGENTS.md",
      "docs/agents/worktree-rules.md",
      "marketing-labs/notes.md",
    ]);
    expect(result.scopes).toEqual([]);
    expect(result.commands).toEqual([]);
    expect(result).not.toHaveProperty("scopedCommand");
  });

  it("prints the gates in the order the runner executes them", () => {
    const result = describeScope(["src/App.tsx", "scripts/example.test.mjs"]);
    expect(result.scopes).toEqual(["frontend", "script-tests"]);
    expect(result.commands.map(({ command }) => command)).toEqual([
      "pnpm verify:push:frontend",
      "pnpm verify:push:script-tests",
    ]);
    expect(result).not.toHaveProperty("scopedCommand");
  });

  it("reports the fail-closed expansion instead of hiding it", () => {
    const result = describeScope(["some/unknown/thing.bin"]);
    expect(result.scopes).toEqual([...PUSH_GATE_ORDER]);
    expect(result).not.toHaveProperty("scopedCommand");
  });

  it("uses trusted root manifest evidence for a script-only advisory", () => {
    const before = JSON.stringify({ name: "dure", private: true, scripts: {} });
    const after = JSON.stringify({
      name: "dure",
      private: true,
      scripts: {
        "test:control-plane-self-heal":
          "sh scripts/qa/control-plane-self-heal-smoke.sh",
      },
    });

    const result = describeScope(["package.json"], {
      packageManifest: { before, after },
    });
    expect(result.scopes).toEqual(["qa-tooling", "script-tests"]);
  });

  it("reads the manifest pair from the exact Git fork point and worktree", () => {
    const before = JSON.stringify({ name: "dure", private: true, scripts: {} });
    const after = JSON.stringify({
      name: "dure",
      private: true,
      scripts: { "test:smoke": "sh scripts/qa/smoke.sh" },
    });
    const forkPoint = "a".repeat(40);
    const environment = { PATH: "/fixture/bin" };
    const gitCalls = [];
    const evidence = collectScopeEvidence(
      { baseResolved: true, forkPoint, paths: ["package.json"] },
      environment,
      {
        runGit(args, receivedEnvironment) {
          gitCalls.push(args);
          expect(receivedEnvironment).toBe(environment);
          if (args[0] === "rev-parse") return "/fixture/repository\n";
          if (args[0] === "show") return before;
          return null;
        },
        readFile(path, encoding) {
          expect(path).toBe("/fixture/repository/package.json");
          expect(encoding).toBe("utf8");
          return after;
        },
      },
    );

    expect(gitCalls).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["show", `${forkPoint}:package.json`],
    ]);
    expect(evidence).toEqual({ packageManifest: { before, after } });
  });

  it("omits semantic evidence when the Git boundary is unresolved", () => {
    let invoked = false;
    expect(
      collectScopeEvidence(
        { baseResolved: false, forkPoint: "", paths: ["package.json"] },
        {},
        {
          runGit() {
            invoked = true;
            return null;
          },
          readFile() {
            invoked = true;
            return "";
          },
        },
      ),
    ).toEqual({});
    expect(invoked).toBe(false);
  });

  it("classifies a working-tree package script through the CLI boundary", () => {
    const fixture = mkdtempSync(join(tmpdir(), "dure-gate-scope-"));
    const runGit = (args) =>
      execFileSync("git", args, { cwd: fixture, encoding: "utf8" });
    try {
      runGit(["init", "--quiet"]);
      runGit(["config", "user.email", "gate-scope@example.invalid"]);
      runGit(["config", "user.name", "Gate Scope Fixture"]);
      runGit(["config", "commit.gpgsign", "false"]);
      writeFileSync(
        join(fixture, "package.json"),
        JSON.stringify({ name: "fixture", private: true, scripts: {} }),
      );
      runGit(["add", "package.json"]);
      runGit([
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "--no-verify",
        "-m",
        "fixture base",
      ]);
      writeFileSync(
        join(fixture, "package.json"),
        JSON.stringify({
          name: "fixture",
          private: true,
          scripts: { "test:smoke": "sh scripts/qa/smoke.sh" },
        }),
      );

      const output = execFileSync(
        process.execPath,
        [
          join(repositoryRoot, "scripts/gate-scope.mjs"),
          "--base",
          "HEAD",
          "--json",
        ],
        { cwd: fixture, encoding: "utf8" },
      );
      const result = JSON.parse(output);
      expect(result.changedPaths).toEqual(["package.json"]);
      expect(result.scopes).toEqual(["qa-tooling", "script-tests"]);
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  it("preserves the changed paths it was asked about", () => {
    const paths = ["README.md", "src/App.tsx"];
    expect(describeScope(paths).changedPaths).toEqual(paths);
  });
});
