import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import { planPublicCi } from "./public-ci.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = parse(
  readFileSync(resolve(repositoryRoot, ".github/workflows/public-repository.yml"), "utf8"),
);
const codeResults = [
  "FRONTEND_RESULT",
  "SCRIPTS_RESULT",
  "MOBILE_WEB_RESULT",
  "SHARED_PROTOCOL_RESULT",
];
const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    expect(fixture.startsWith(join(tmpdir(), "dure-public-ci-"))).toBe(true);
    rmSync(fixture, { recursive: true, force: true });
  }
});

function repositoryFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "dure-public-ci-"));
  fixtures.push(cwd);
  const environment = withoutLocalGitOverrides();
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (path, content = "changed\n") => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  const commit = () => {
    git("add", "--all");
    git(
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "fixture change",
    );
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Public CI fixture");
  git("config", "user.email", "public-ci@example.invalid");
  git("config", "commit.gpgsign", "false");
  write("README.md", "# Fixture\n");
  write("src/app.ts", "export const value = 1;\n");
  write("package.json", '{"private":true}\n');
  const base = commit();
  return { cwd, git, write, commit, base };
}

function results(runCodeChecks) {
  return {
    PLAN_RESULT: "success",
    RUN_CODE_CHECKS: String(runCodeChecks),
    DOCUMENTATION_RESULT: "success",
    ...Object.fromEntries(codeResults.map((key) => [key, runCodeChecks ? "success" : "skipped"])),
  };
}

function runRequiredCheck(environment) {
  return spawnSync(
    "bash",
    ["-euo", "pipefail", "-c", workflow.jobs["public-repository"].steps.at(-1).run],
    {
      cwd: repositoryRoot,
      env: { ...withoutLocalGitOverrides(), ...environment },
      encoding: "utf8",
    },
  );
}

describe("public CI required result", () => {
  it("accepts a successful documentation-only plan with intentionally skipped code jobs", () => {
    const result = runRequiredCheck(results(false));
    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts all successful code suites", () => {
    const result = runRequiredCheck(results(true));
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([true, false])(
    "rejects failed or missing planning/documentation with code plan %s",
    (runCodeChecks) => {
      for (const key of ["PLAN_RESULT", "DOCUMENTATION_RESULT"]) {
        for (const status of ["failure", "cancelled", "skipped", ""]) {
          expect(
            runRequiredCheck({ ...results(runCodeChecks), [key]: status }).status,
            `${key}: ${status}`,
          ).toBe(1);
        }
      }
    },
  );

  it.each(codeResults)("never accepts a failed, cancelled or missing %s", (key) => {
    for (const runCodeChecks of [true, false]) {
      for (const status of ["failure", "cancelled", ""]) {
        expect(
          runRequiredCheck({ ...results(runCodeChecks), [key]: status }).status,
          `${key}: ${status}`,
        ).toBe(1);
      }
    }
  });

  it.each(codeResults)("rejects unexpectedly skipped %s in a code change", (key) => {
    expect(runRequiredCheck({ ...results(true), [key]: "skipped" }).status).toBe(1);
  });

  it("does not treat a missing or malformed plan output as a documentation-only change", () => {
    for (const value of ["", "False", "0", "null", "true\nfalse"]) {
      expect(runRequiredCheck({ ...results(false), RUN_CODE_CHECKS: value }).status).toBe(1);
    }
  });
});

describe("public CI change planning", () => {
  it("skips code suites for documentation and README media, including newline filenames", () => {
    const fixture = repositoryFixture();
    fixture.write("README.md");
    fixture.write("docs/readme/README.ko.md");
    fixture.write("docs/public/en/privacy-and-telemetry.mdx");
    fixture.write("public/readme/screenshot.png");
    fixture.write("docs/line\nbreak.md");
    const head = fixture.commit();
    const plan = planPublicCi({ ...fixture, head, eventName: "push" });
    expect(plan).toMatchObject({
      runCodeChecks: false,
      changedPathCount: 5,
      scopes: [],
    });
  });

  it.each([
    "src/app.ts",
    "mobile/src/App.tsx",
    "src-tauri/src/lib.rs",
    "crates/dure-hub-protocol/src/lib.rs",
    "hmux/crates/hmux-host/src/lib.rs",
    "pnpm-lock.yaml",
    ".node-version",
    ".github/workflows/public-repository.yml",
    "scripts/public-ci.mjs",
    "docs/examples/run.mjs",
    "unrecognized/input.bin",
  ])("keeps full code checks when %s is mixed with documentation", (path) => {
    const fixture = repositoryFixture();
    fixture.write("README.md");
    fixture.write(path);
    const head = fixture.commit();
    expect(planPublicCi({ ...fixture, head, eventName: "push" }).runCodeChecks).toBe(true);
  });

  it("includes code changes in earlier commits of the same push", () => {
    const fixture = repositoryFixture();
    fixture.write("src/app.ts");
    fixture.commit();
    fixture.write("README.md");
    const head = fixture.commit();
    expect(planPublicCi({ ...fixture, head, eventName: "push" }).runCodeChecks).toBe(true);
  });

  it("retains the code endpoint when a file is renamed into documentation", () => {
    const fixture = repositoryFixture();
    mkdirSync(join(fixture.cwd, "docs"));
    renameSync(join(fixture.cwd, "src/app.ts"), join(fixture.cwd, "docs/example.md"));
    const head = fixture.commit();
    expect(planPublicCi({ ...fixture, head, eventName: "push" })).toMatchObject({
      runCodeChecks: true,
      changedPathCount: 2,
    });
  });

  it("keeps code checks for deleted dependency manifests", () => {
    const fixture = repositoryFixture();
    rmSync(join(fixture.cwd, "package.json"));
    const head = fixture.commit();
    expect(planPublicCi({ ...fixture, head, eventName: "push" }).runCodeChecks).toBe(true);
  });

  it("compares a PR base to its actual merge checkout after the base branch moves", () => {
    const fixture = repositoryFixture();
    fixture.git("switch", "-c", "docs-change");
    fixture.write("README.md");
    fixture.commit();
    fixture.git("switch", "main");
    fixture.write("src/app.ts");
    const base = fixture.commit();
    fixture.git(
      "-c",
      "core.hooksPath=/dev/null",
      "merge",
      "--no-ff",
      "--no-gpg-sign",
      "docs-change",
      "-m",
      "PR merge fixture",
    );
    const head = fixture.git("rev-parse", "HEAD");
    expect(planPublicCi({ ...fixture, base, head, eventName: "pull_request" })).toMatchObject({
      runCodeChecks: false,
      changedPathCount: 1,
    });
  });

  it("runs all checks for manual dispatch, missing history or an unexpected checkout", () => {
    const fixture = repositoryFixture();
    fixture.write("README.md");
    const head = fixture.commit();
    const normal = { ...fixture, head, eventName: "push" };
    for (const override of [
      { eventName: "workflow_dispatch" },
      { eventName: "unknown" },
      { base: undefined },
      { base: "0".repeat(40) },
      { base: "bad-ref" },
      { base: "a".repeat(40) },
      { head: fixture.base },
      { head: undefined },
    ]) {
      expect(planPublicCi({ ...normal, ...override }).runCodeChecks, JSON.stringify(override)).toBe(
        true,
      );
    }
  });

  it("does not use a divergent comparison as evidence to skip checks", () => {
    const fixture = repositoryFixture();
    fixture.git("switch", "-c", "other");
    fixture.write("docs/other.md");
    const base = fixture.commit();
    fixture.git("switch", "main");
    fixture.write("README.md");
    const head = fixture.commit();
    expect(planPublicCi({ ...fixture, base, head, eventName: "push" })).toMatchObject({
      runCodeChecks: true,
      reason: "comparison-unavailable",
    });
  });

  it("runs the workflow planner without package installation and ignores inherited Git pointers", () => {
    const fixture = repositoryFixture();
    fixture.write("README.md");
    const head = fixture.commit();
    // Copy the bootstrap closure away from this checkout's node_modules so
    // accidental package imports fail as they would in the planning job.
    for (const path of [
      "scripts/public-ci.mjs",
      "scripts/lib/git-environment.mjs",
      "scripts/lib/push-gate-scope.mjs",
      "scripts/lib/hmux-test-only-path.mjs",
      "scripts/lib/package-manifest-script-impact.mjs",
      "scripts/lib/script-test-graph-paths.mjs",
    ]) {
      fixture.write(path, readFileSync(resolve(repositoryRoot, path), "utf8"));
    }
    const output = join(fixture.cwd, "github-output");
    const environment = {
      ...withoutLocalGitOverrides(),
      CI_EVENT_NAME: "push",
      CI_BASE_SHA: fixture.base,
      CI_HEAD_SHA: head,
      GITHUB_OUTPUT: output,
      GIT_DIR: "/missing/foreign/git",
      GIT_WORK_TREE: "/missing/foreign/worktree",
    };
    const stdout = execFileSync(
      process.execPath,
      [join(fixture.cwd, "scripts/public-ci.mjs"), "plan"],
      { cwd: fixture.cwd, env: environment, encoding: "utf8" },
    );
    expect(JSON.parse(stdout).runCodeChecks).toBe(false);
    expect(readFileSync(output, "utf8")).toBe("run_code_checks=false\n");
    execFileSync(process.execPath, [join(fixture.cwd, "scripts/public-ci.mjs"), "check"], {
      cwd: fixture.cwd,
      env: { ...environment, ...results(false) },
      stdio: "pipe",
    });
  });
});
