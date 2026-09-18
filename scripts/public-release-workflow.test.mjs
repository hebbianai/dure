import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import YAML from "yaml";

const workflow = YAML.parse(
  fs.readFileSync(".github/workflows/release.yml", "utf8"),
);

test.each(["verification", "build"])(
  "initializes %s runner paths only after the job starts",
  (name) => {
    const job = workflow.jobs[name];
    const initialization = job.steps.find(
      (step) => step.name === "Isolate release tool state",
    );
    expect(initialization).toBeDefined();
    expect(JSON.stringify(job.env ?? {})).not.toContain("runner.");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-workflow-env-"));
    try {
      const output = path.join(root, "environment");
      const runnerTemp = path.join(root, "runner temp");
      execFileSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-e",
          "-o",
          "pipefail",
          "-c",
          initialization.run,
        ],
        {
          env: {
            PATH: "/usr/bin:/bin",
            RUNNER_TEMP: runnerTemp,
            GITHUB_ENV: output,
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "2",
          },
          encoding: "utf8",
        },
      );
      expect(fs.readFileSync(output, "utf8").trim().split("\n")).toEqual([
        `RUSTUP_HOME=${runnerTemp}/dure-rustup-home`,
        `NODE_COMPILE_CACHE=${runnerTemp}/dure-node-cache`,
        ...(name === "verification"
          ? [
              `HEBBIAN_CI_RUNNER_TEMP=${runnerTemp}`,
              `DURE_GHOSTTY_VT_CACHE_ROOT=${runnerTemp}/dure-ghostty-123-2`,
            ]
          : []),
      ]);
      expect(job.steps.indexOf(initialization)).toBeLessThan(
        job.steps.findIndex((step) =>
          step.uses?.startsWith("dtolnay/rust-toolchain@"),
        ),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("release admission is manual, canonical-main-only and read-only by default", () => {
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  expect(workflow.jobs.source.if).toBe(
    "github.repository == 'hebbianai/dure' && github.ref == 'refs/heads/main'",
  );
  expect(workflow.on.workflow_dispatch.inputs.verification.default).toBe(
    "full",
  );
  expect(
    workflow.jobs.source.steps.find((step) => step.id === "admission").run,
  ).toBe('node scripts/release-public.mjs preflight "$RUNNER_TEMP/selection.json"');
  expect(workflow.on.workflow_dispatch.inputs.source_ref).toMatchObject({ default: "main", required: false });
  expect(workflow.on.workflow_dispatch.inputs).not.toHaveProperty("source_sha");
  const selection = workflow.jobs.source.steps.at(-1);
  expect(selection.with).toMatchObject({ name: "release-selection", path: "${{ runner.temp }}/selection.json" });
  expect(selection.with.overwrite).not.toBe(true);
});

test("public PR checks remain on hosted runners with no signing secrets", () => {
  const publicCI = YAML.parse(
    fs.readFileSync(".github/workflows/public-repository.yml", "utf8"),
  );
  for (const job of Object.values(publicCI.jobs)) {
    expect(JSON.stringify(job["runs-on"])).not.toContain("self-hosted");
    expect(JSON.stringify(job)).not.toContain("secrets.");
  }
  for (const name of ["verification", "build"]) {
    expect(workflow.jobs[name]["runs-on"]).toEqual({
      group: "dure-release",
      labels: ["self-hosted", "macOS", "ARM64", "dure-release"],
    });
    expect(workflow.jobs[name].environment).toBe("macos-release");
  }
});

test("full verification and owned target cleanup precede the independently validated tag", () => {
  expect(workflow.jobs.verification.if).toBe("inputs.verification == 'full'");
  expect(
    workflow.jobs.verification.steps.some(
      (step) => step.run === "corepack pnpm verify:release",
    ),
  ).toBe(true);
  const cleanup = workflow.jobs.verification.steps.at(-1);
  expect(cleanup).toMatchObject({
    if: "always()",
    run: "sh scripts/manage-ci-cargo-target.sh release",
  });
  expect(workflow.jobs.version.needs).toEqual(["source", "candidate", "verification"]);
  expect(workflow.jobs.version.if).toContain(
    "needs.candidate.result == 'success'",
  );
  expect(workflow.jobs.version.if).toContain(
    "needs.verification.result == 'success'",
  );
  expect(workflow.jobs.version.if).toContain(
    "needs.verification.result == 'skipped' && inputs.verification == 'emergency-0.2'",
  );
  expect(
    workflow.jobs.version.steps.find((step) => step.id === "version").run,
  ).toContain("release-public.mjs version");
  expect(workflow.jobs.version.steps.at(-1).run).toContain(
    "public-repository.yml --repo hebbianai/dure --ref",
  );
});

test("only the protected build step receives signing credentials and remains Basic beta", () => {
  const build = workflow.jobs.build.steps.find(
    (step) => step.name === "Build signed and notarized Basic beta",
  );
  expect(build.env.VITE_DURE_INTERFACE_MODE_POLICY).toBe("basic-only");
  expect(build.run).toContain("node ../scripts/check-macos-signing.mjs");
  expect(build.run).toContain(
    "node scripts/run-with-build-storage.mjs full -- corepack pnpm tauri build --config src-tauri/tauri.beta.conf.json",
  );
  expect(build.env).not.toHaveProperty("APPLE_CERTIFICATE");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) {
      if (name !== "build")
        expect(JSON.stringify(step)).not.toContain("secrets.");
      if (step !== build)
        expect(JSON.stringify(step)).not.toContain(
          "secrets.TAURI_SIGNING_PRIVATE_KEY",
        );
      if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
      if (step.uses?.startsWith("actions/checkout@"))
        expect(step.with["persist-credentials"]).toBe(false);
    }
  }
});

test("the workflow stops at immutable draft staging and never changes the client feed", () => {
  expect(workflow.jobs.draft.needs).toEqual(["source", "version", "build"]);
  const staging = workflow.jobs.draft.steps.find(
    (step) => step.name === "Reconcile only missing draft assets",
  );
  expect(staging.run).toContain("release-public.mjs stage");
  expect(JSON.stringify(workflow)).not.toContain("--clobber");
  const commands = Object.values(workflow.jobs).flatMap((job) =>
    job.steps.map((step) => step.run ?? ""),
  );
  expect(
    commands.some((run) =>
      /(?:^|\n)\s*node scripts\/release-public\.mjs publish/.test(run),
    ),
  ).toBe(false);
  expect(JSON.stringify(workflow)).not.toContain("BETA_FEED_TOKEN");
});

test("separates protected workflow helpers from the immutable selected application checkout", () => {
  const checks = (name) => workflow.jobs[name].steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
  for (const name of ["candidate", "version", "build", "draft"]) {
    const [control, source] = checks(name);
    expect(control.with.ref).toBe("${{ github.sha }}");
    expect(control.with.path).toBeUndefined();
    expect(source.with.path).toBe("source");
    expect(source.with.ref).toBe(["candidate", "version"].includes(name)
      ? "${{ needs.source.outputs.source_sha }}" : "${{ needs.version.outputs.release_sha }}");
    expect(workflow.jobs[name].defaults.run["working-directory"]).toBe("source");
    for (const step of workflow.jobs[name].steps) {
      if (/node .*\/(?:release-public|prepare-release-candidate|validate-release-assets|build-latest-json)\.mjs/.test(step.run ?? ""))
        expect(step.run).toMatch(/node \.\.\/scripts\//);
    }
  }
  expect(checks("verification")[0].with.ref).toBe("${{ needs.source.outputs.source_sha }}");
  expect(workflow.jobs.candidate.env.RELEASE_SOURCE_SHA).toBe("${{ needs.source.outputs.source_sha }}");
  expect(workflow.jobs.version.env.RELEASE_SOURCE_SHA).toBe("${{ needs.source.outputs.source_sha }}");
  expect(workflow.jobs.draft.env.RELEASE_SOURCE_SHA).toBe("${{ needs.source.outputs.source_sha }}");
  expect(workflow.jobs.build.steps[0]["working-directory"]).toBe("${{ github.workspace }}");
});
