import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import { PUSH_GATE_SCOPES } from "./lib/push-gate-scope.mjs";
import {
  DEADLINE_SENSITIVE_PROCESS_TEST_PATHS,
  NODE_TEST_PATHS,
  PROCESS_FIXTURE_TEST_PATHS,
} from "./lib/script-test-projects.mjs";
import { planPublicCi, RUST_JOB_SCOPES } from "./public-ci.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = parse(
  readFileSync(resolve(repositoryRoot, ".github/workflows/public-repository.yml"), "utf8"),
);
// Code job result -> the plan output that selects that job.
const codeResults = {
  FRONTEND_RESULT: "RUN_CODE_CHECKS",
  SCRIPTS_VITEST_RESULT: "RUN_CODE_CHECKS",
  SCRIPTS_NODE_RESULT: "RUN_CODE_CHECKS",
  SCRIPTS_DEADLINE_RESULT: "RUN_CODE_CHECKS",
  SCRIPTS_PROCESS_RESULT: "RUN_CODE_CHECKS",
  MOBILE_WEB_RESULT: "RUN_CODE_CHECKS",
  SHARED_PROTOCOL_RESULT: "RUN_CODE_CHECKS",
  HMUX_RESULT: "RUN_HMUX_CHECKS",
  APP_RESULT: "RUN_APP_CHECKS",
};
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

function results(runCodeChecks, { hmux = runCodeChecks, app = runCodeChecks } = {}) {
  const plans = { RUN_CODE_CHECKS: runCodeChecks, RUN_HMUX_CHECKS: hmux, RUN_APP_CHECKS: app };
  return {
    PLAN_RESULT: "success",
    DOCUMENTATION_RESULT: "success",
    ...Object.fromEntries(Object.entries(plans).map(([key, value]) => [key, String(value)])),
    ...Object.fromEntries(
      Object.entries(codeResults).map(([key, plan]) => [key, plans[plan] ? "success" : "skipped"]),
    ),
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

describe("public CI main pushes", () => {
  it("gives the planner no actor identity, ref or credentials to exempt a push with", () => {
    const plan = workflow.jobs.plan.steps.find((step) => step.id === "plan");
    expect(Object.keys(plan.env).sort()).toEqual(["CI_BASE_SHA", "CI_EVENT_NAME", "CI_HEAD_SHA"]);
    expect(JSON.stringify(workflow.jobs.plan)).not.toMatch(/github\.(?:actor|token)|secrets\./);
  });

  it("plans a push to main from its complete change", () => {
    const fixture = repositoryFixture();
    const push = { cwd: fixture.cwd, eventName: "push" };
    fixture.write("README.md");
    const documentation = fixture.commit();
    expect(planPublicCi({ ...push, base: fixture.base, head: documentation })).toMatchObject({
      runCodeChecks: false,
      reason: "documentation-only",
    });
    fixture.write("src/app.ts");
    const code = fixture.commit();
    expect(planPublicCi({ ...push, base: documentation, head: code })).toMatchObject({
      runCodeChecks: true,
      reason: "code-or-shared-inputs",
    });
  });

  it("never lets the plan skip documentation checks", () => {
    expect(workflow.jobs.documentation.if).toBeUndefined();
  });
});

describe("public CI required result admission", () => {
  const admitted = (name, outputs, { eventName = "push", cancelled = false } = {}) =>
    runInNewContext(workflow.jobs[name].if.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
      github: { event_name: eventName },
      needs: { plan: { outputs } },
      always: () => true,
      cancelled: () => cancelled,
    });

  it("still runs the required result when the plan fails or its output is missing", () => {
    // A status function opts out of GitHub's implicit success() over needs.
    expect(workflow.jobs["public-repository"].if).toMatch(/\b(?:always|cancelled)\(\)/);
    for (const eventName of ["pull_request", "push", "workflow_dispatch"]) {
      expect(admitted("public-repository", {}, { eventName }), eventName).toBe(true);
      expect(admitted("public-repository", { run_code_checks: "true" }, { eventName }), eventName).toBe(true);
    }
  });

  it("fails a cancelled pull request but leaves a cancelled push or dispatch run cancelled", () => {
    expect(admitted("public-repository", {}, { eventName: "pull_request", cancelled: true })).toBe(true);
    for (const eventName of ["push", "workflow_dispatch"]) {
      expect(admitted("public-repository", {}, { eventName, cancelled: true }), eventName).toBe(false);
    }
  });
});

describe("public CI concurrency", () => {
  const evaluate = (source, github) =>
    runInNewContext(String(source).replace(/^\$\{\{\s*|\s*\}\}$/g, ""), { github });
  // GitHub expressions read the absent pull_request of other events as null.
  const run = (eventName, runId, pullRequest = {}) => {
    const github = {
      event_name: eventName,
      ref: pullRequest.number ? `refs/pull/${pullRequest.number}/merge` : "refs/heads/main",
      run_id: runId,
      event: { pull_request: pullRequest },
    };
    return {
      group: workflow.concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_, source) =>
        String(evaluate(source.trim(), github)),
      ),
      cancelInProgress: evaluate(workflow.concurrency["cancel-in-progress"], github),
    };
  };

  it("never lets a main push or a later dispatch cancel a manual dispatch", () => {
    const dispatch = run("workflow_dispatch", "35325609914");
    expect(dispatch.cancelInProgress).toBe(false);
    expect(run("push", "35326566538").group).not.toBe(dispatch.group);
    expect(run("workflow_dispatch", "35326600000").group).not.toBe(dispatch.group);
  });

  it("keeps superseding older runs of the same pull request", () => {
    const pullRequest = run("pull_request", "1", { number: 49 });
    expect(run("pull_request", "2", { number: 49 })).toEqual(pullRequest);
    expect(pullRequest.cancelInProgress).toBe(true);
    expect(run("pull_request", "3", { number: 50 }).group).not.toBe(pullRequest.group);
  });

  it("never cancels a main push run, so every pushed range is checked", () => {
    const push = run("push", "4");
    expect(push.cancelInProgress).toBe(false);
    expect(run("push", "5").group).not.toBe(push.group);
  });
});

describe("public CI workflow wiring", () => {
  const jobs = Object.entries(workflow.jobs);
  const steps = jobs.flatMap(([, job]) => job.steps);
  const summary = workflow.jobs["public-repository"];
  const summaryEnvironment = summary.steps.at(-1).env;
  const packageScripts = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"))
    .scripts;

  it("pins every action to a full commit and never persists checkout credentials", () => {
    for (const step of steps.filter((step) => step.uses)) {
      expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      if (step.uses.startsWith("actions/checkout@")) {
        expect(step.with["persist-credentials"], step.uses).toBe(false);
      }
    }
    for (const [name, job] of jobs) expect(job["timeout-minutes"], name).toBeGreaterThan(0);
  });

  it("requires every other job, and its plan output, in the summary result", () => {
    expect([...summary.needs].sort()).toEqual(
      Object.keys(workflow.jobs).filter((name) => name !== "public-repository").sort(),
    );
    for (const name of summary.needs) {
      const key = `${name.toUpperCase().replaceAll("-", "_")}_RESULT`;
      expect(summaryEnvironment[key], name).toBe(`\${{ needs.${name}.result }}`);
    }
    for (const plan of new Set(Object.values(codeResults))) {
      const output = plan.toLowerCase();
      expect(workflow.jobs.plan.outputs[output]).toBe(`\${{ steps.plan.outputs.${output} }}`);
      expect(summaryEnvironment[plan]).toBe(`\${{ needs.plan.outputs.${output} }}`);
    }
  });

  it.each([
    ["hmux", "run_hmux_checks", "verify:push:hmux-core", "hmux -> target"],
    ["app", "run_app_checks", "app:verify", "crates/dure-app -> target"],
  ])("runs the existing %s workspace gate when its plan output selects it", (name, output, gate, workspace) => {
    const job = workflow.jobs[name];
    expect(job.needs).toBe("plan");
    expect(job.if).toBe(`\${{ needs.plan.outputs.${output} == 'true' }}`);
    expect(job.steps.at(-1).run).toBe(`pnpm ${gate}`);
    expect(packageScripts[gate]).toBeTypeOf("string");
    const cache = job.steps.find((step) => step.uses?.startsWith("Swatinem/rust-cache@"));
    expect(cache.with.workspaces).toBe(workspace);
    // The cache derives its key from the toolchain, so it follows the pinned install.
    const toolchain = job.steps.findIndex((step) => step.run === "rustup show active-toolchain");
    expect(toolchain).toBeGreaterThan(-1);
    expect(toolchain).toBeLessThan(job.steps.indexOf(cache));
  });

  it("prepares the pinned Ghostty proof on the only host that can build it", () => {
    const job = workflow.jobs.hmux;
    expect(job["runs-on"]).toBe("macos-15");
    const proof = job.steps.findIndex((step) => step.run?.includes("ensure-ghostty-vt-proof.mjs"));
    expect(job.steps[proof].run).toContain("--target aarch64-apple-darwin");
    expect(job.steps[proof].run).toContain("HMUX_GHOSTTY_VT_PROOF_PREFIX=");
    expect(proof).toBeLessThan(job.steps.length - 1);
    expect(workflow.jobs.app["runs-on"]).toBe("ubuntu-24.04");
  });
});

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

  it.each(Object.keys(codeResults))("never accepts a failed, cancelled or missing %s", (key) => {
    for (const runCodeChecks of [true, false]) {
      for (const status of ["failure", "cancelled", ""]) {
        expect(
          runRequiredCheck({ ...results(runCodeChecks), [key]: status }).status,
          `${key}: ${status}`,
        ).toBe(1);
      }
    }
  });

  it.each(Object.keys(codeResults))("rejects unexpectedly skipped %s in a code change", (key) => {
    expect(runRequiredCheck({ ...results(true), [key]: "skipped" }).status).toBe(1);
  });

  it("does not treat a missing or malformed plan output as a documentation-only change", () => {
    for (const plan of new Set(Object.values(codeResults))) {
      for (const value of ["", "False", "0", "null", "true\nfalse"]) {
        expect(runRequiredCheck({ ...results(false), [plan]: value }).status, plan).toBe(1);
      }
    }
  });

  it("holds each Rust workspace job to its own plan output", () => {
    for (const plan of [{ hmux: false, app: false }, { hmux: true, app: false }, { hmux: false, app: true }]) {
      const environment = results(true, plan);
      const result = runRequiredCheck(environment);
      expect(result.status, `${JSON.stringify(plan)}: ${result.stderr}`).toBe(0);
      for (const key of ["HMUX_RESULT", "APP_RESULT"]) {
        const swapped = environment[key] === "success" ? "skipped" : "success";
        expect(runRequiredCheck({ ...environment, [key]: swapped }).status, key).toBe(1);
      }
    }
  });
});

describe("public CI frontend checks", () => {
  it("runs every frontend push-gate check and the design coverage gate", () => {
    const { scripts } = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
    const checks = (name) =>
      scripts[name].split("&&").map((step) => step.trim().replace(/^(?:corepack )?pnpm /, ""));
    expect(workflow.jobs.frontend.steps.at(-1).run).toBe("pnpm verify:frontend");
    expect(scripts["verify:frontend"]).toContain("pnpm verify:frontend:implementation");
    expect(checks("verify:frontend:implementation")).toEqual(
      expect.arrayContaining([
        ...checks("verify:push:frontend:implementation"),
        "design:coverage:check",
        "design:coverage:test",
      ]),
    );
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
      runHmuxChecks: false,
      runAppChecks: false,
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
    "docs/public/docs.json",
    "unrecognized/input.bin",
  ])("keeps full code checks when %s is mixed with documentation", (path) => {
    const fixture = repositoryFixture();
    fixture.write("README.md");
    fixture.write(path);
    const head = fixture.commit();
    expect(planPublicCi({ ...fixture, head, eventName: "push" }).runCodeChecks).toBe(true);
  });

  it.each([
    ["hmux/crates/hmux-host/src/lib.rs", { runHmuxChecks: true, runAppChecks: true }],
    ["hmux/crates/hmux-client/src/lib.rs", { runHmuxChecks: true, runAppChecks: true }],
    ["hmux/crates/hmux-ssh-transport/src/lib.rs", { runHmuxChecks: true, runAppChecks: false }],
    ["hmux/xtask/terminal-state-protocol-codegen/src/main.rs", { runHmuxChecks: true, runAppChecks: false }],
    ["src/contracts/terminalStateProtocol.ts", { runHmuxChecks: true, runAppChecks: false }],
    ["crates/hebbian-process-sampler/src/lib.rs", { runHmuxChecks: true, runAppChecks: false }],
    ["crates/dure-app/src/lib.rs", { runHmuxChecks: false, runAppChecks: true }],
    ["src/contracts/generated/extensionContracts.ts", { runHmuxChecks: false, runAppChecks: true }],
    ["cli/lib/control-plane-build-identity.json", { runHmuxChecks: false, runAppChecks: true }],
    ["src/app.ts", { runHmuxChecks: false, runAppChecks: false }],
    ["crates/dure-hub-protocol/src/lib.rs", { runHmuxChecks: false, runAppChecks: false }],
    ["mobile/src/App.tsx", { runHmuxChecks: false, runAppChecks: false }],
    [".github/workflows/public-repository.yml", { runHmuxChecks: true, runAppChecks: true }],
    ["unrecognized/input.bin", { runHmuxChecks: true, runAppChecks: true }],
  ])("selects the Rust workspace jobs that verify %s", (path, rust) => {
    const fixture = repositoryFixture();
    fixture.write(path);
    const head = fixture.commit();
    expect(planPublicCi({ ...fixture, head, eventName: "pull_request" })).toMatchObject({
      runCodeChecks: true,
      ...rust,
    });
  });

  it("names only scopes the classifier can produce for the Rust workspace jobs", () => {
    for (const scopes of Object.values(RUST_JOB_SCOPES)) {
      expect(scopes.length).toBeGreaterThan(0);
      for (const scope of scopes) expect(PUSH_GATE_SCOPES).toContain(scope);
    }
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
      expect(planPublicCi({ ...normal, ...override }), JSON.stringify(override)).toMatchObject({
        runCodeChecks: true,
        runHmuxChecks: true,
        runAppChecks: true,
      });
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
    expect(readFileSync(output, "utf8")).toBe(
      "run_code_checks=false\nrun_hmux_checks=false\nrun_app_checks=false\n",
    );
    execFileSync(process.execPath, [join(fixture.cwd, "scripts/public-ci.mjs"), "check"], {
      cwd: fixture.cwd,
      env: { ...environment, ...results(false) },
      stdio: "pipe",
    });
  });
});

describe("script test CI coverage", () => {
  it("covers every script test file in exactly one matrix job", () => {
    // Find all script test files
    function findTestFiles(dir) {
      const results = [];
      const fullDir = join(repositoryRoot, dir);
      try {
        const entries = readdirSync(fullDir);
        for (const entry of entries) {
          const fullPath = join(fullDir, entry);
          const relativePath = join(dir, entry);
          try {
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
              results.push(...findTestFiles(relativePath));
            } else if (entry.endsWith(".test.mjs")) {
              results.push(relativePath);
            }
          } catch {}
        }
      } catch {}
      return results;
    }

    // Tests outside scripts/ run only when a script test project lists them.
    const allScriptTests = [
      ...new Set([
        ...findTestFiles("scripts"),
        ...NODE_TEST_PATHS,
        ...DEADLINE_SENSITIVE_PROCESS_TEST_PATHS,
        ...PROCESS_FIXTURE_TEST_PATHS,
      ]),
    ];

    // Extract matrix file lists from workflow
    const extractFiles = (jobName) => {
      const job = workflow.jobs[jobName];
      if (!job?.strategy?.matrix) return [];
      // Handle both `file` (single file per matrix item) and `files` (space-separated list)
      if (job.strategy.matrix.file) {
        return job.strategy.matrix.file;
      }
      if (job.strategy.matrix.include) {
        return job.strategy.matrix.include.flatMap(group =>
          (group.files || "").split(/\s+/).filter(Boolean)
        );
      }
      return [];
    };

    const vitestFiles = allScriptTests.filter(path =>
      !NODE_TEST_PATHS.includes(path) &&
      !DEADLINE_SENSITIVE_PROCESS_TEST_PATHS.includes(path) &&
      !PROCESS_FIXTURE_TEST_PATHS.includes(path)
    );
    const nodeFiles = extractFiles("scripts-node");
    const deadlineFiles = extractFiles("scripts-deadline");
    const processFiles = extractFiles("scripts-process");

    // Build coverage map
    const coverage = new Map();
    for (const file of vitestFiles) coverage.set(file, ["scripts-vitest"]);
    for (const file of nodeFiles) {
      const jobs = coverage.get(file) || [];
      jobs.push("scripts-node");
      coverage.set(file, jobs);
    }
    for (const file of deadlineFiles) {
      const jobs = coverage.get(file) || [];
      jobs.push("scripts-deadline");
      coverage.set(file, jobs);
    }
    for (const file of processFiles) {
      const jobs = coverage.get(file) || [];
      jobs.push("scripts-process");
      coverage.set(file, jobs);
    }

    // Check for gaps and duplicates
    const uncovered = [];
    const duplicates = [];

    for (const test of allScriptTests) {
      const jobs = coverage.get(test) || [];
      if (jobs.length === 0) {
        uncovered.push(test);
      } else if (jobs.length > 1) {
        duplicates.push({ file: test, jobs });
      }
    }

    // Assert no gaps or duplicates
    if (uncovered.length > 0) {
      throw new Error(
        `Script tests NOT covered by any CI job:\n${uncovered.map(f => `  - ${f}`).join("\n")}\n` +
        `Update .github/workflows/public-repository.yml matrix or scripts/lib/script-test-projects.mjs`
      );
    }
    if (duplicates.length > 0) {
      throw new Error(
        `Script tests covered by MULTIPLE CI jobs:\n${duplicates.map(({file, jobs}) => `  - ${file}: ${jobs.join(", ")}`).join("\n")}\n` +
        `Update .github/workflows/public-repository.yml matrix or scripts/lib/script-test-projects.mjs`
      );
    }

    // Success - report coverage for visibility
    const allCovered = new Set([...vitestFiles, ...nodeFiles, ...deadlineFiles, ...processFiles]);
    expect(allCovered.size).toBe(allScriptTests.length);
  });

  it.each([
    ["scripts-node", NODE_TEST_PATHS],
    ["scripts-deadline", DEADLINE_SENSITIVE_PROCESS_TEST_PATHS],
    ["scripts-process", PROCESS_FIXTURE_TEST_PATHS],
  ])("gives each %s test its own invocation", (name, paths) => {
    // These projects set separateInvocations, so each matrix item is one file.
    expect([...workflow.jobs[name].strategy.matrix.file].sort()).toEqual([...paths].sort());
  });
});
