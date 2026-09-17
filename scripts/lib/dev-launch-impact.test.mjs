import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEV_CHILD_PREPARATION_PATHS,
  DEV_DEPLOY_IMPACT,
  DEV_PARENT_SOURCE_PATHS,
  assertDevParentNodeRuntime,
  changedPathsRequireChildRestart,
  controlPlanePayloadStageRequired,
  devDeployImpact,
  devDeployRequiresControlPlaneActivation,
  devDeployRequiresChildRestart,
  devParentLoadedPaths,
  devParentSourceGeneration,
  hmuxDevRuntimeStageRequired,
  nodeDependencyInstallRequired,
} from "./dev-launch-impact.mjs";
import { HMUX_DEV_RUNTIME_INPUTS } from "./hmux-dev-build-inputs.mjs";
import { WINDOWS_JOB_SOURCE_PATHS } from "./windows-process-job.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryRoots = [];
const childPreparationEntrypoints = [
  "scripts/node-dependency-preflight.mjs",
  "scripts/guard-dev-channel.mjs",
  "scripts/stage-mobile-runtime.mjs",
  "scripts/prepare-agent-tools.sh",
];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function localImportClosure(entrypoint) {
  const closure = new Set();
  const visit = (relativePath) => {
    if (closure.has(relativePath)) return;
    closure.add(relativePath);
    const pathname = join(repositoryRoot, relativePath);
    const source = readFileSync(pathname, "utf8");
    const references = [
      ...source.matchAll(/(?:from\s+|import\s*)(["'])(\.\.?\/[^"']+)\1/g),
      ...source.matchAll(
        /new URL\(\s*(["'])(\.\.?\/[^"']+)\1\s*,\s*import\.meta\.url\s*\)/g,
      ),
    ];
    for (const match of references) {
      const imported = relative(
        repositoryRoot,
        resolve(dirname(pathname), match[2]),
      );
      if (imported.endsWith(".mjs")) {
        visit(imported);
      } else if (existsSync(join(repositoryRoot, imported))) {
        closure.add(imported);
      }
    }
  };
  visit(entrypoint);
  return [...closure].sort();
}

function childPreparationScriptClosure() {
  const closure = new Set();
  const visit = (relativePath) => {
    if (closure.has(relativePath)) return;
    closure.add(relativePath);
    const pathname = join(repositoryRoot, relativePath);
    const source = readFileSync(pathname, "utf8");
    const references =
      /["'`](\.?\.?\/[^"'`\s]+\.(?:mjs|sh))["'`]|\b(scripts\/[A-Za-z0-9_.-]+\.(?:mjs|sh))\b|(?:\$[A-Za-z0-9_{}]+\/)([A-Za-z0-9_.-]+\.(?:mjs|sh))/g;
    for (const match of source.matchAll(references)) {
      const candidate = match[1] ?? match[2] ?? join(dirname(relativePath), match[3]);
      const resolved = relativePath.startsWith("scripts/") && candidate.startsWith(".")
        ? relative(repositoryRoot, resolve(dirname(pathname), candidate))
        : candidate;
      if (existsSync(join(repositoryRoot, resolved))) visit(resolved);
    }
  };
  for (const entrypoint of childPreparationEntrypoints) visit(entrypoint);
  return [...closure].sort();
}

describe("dev launch impact authority", () => {
  it("keeps the parent generation set equal to its launcher authority closure", () => {
    expect([...DEV_PARENT_SOURCE_PATHS].sort()).toEqual(
      [...new Set([
        ...WINDOWS_JOB_SOURCE_PATHS,
        ...localImportClosure("scripts/run-dev-app.mjs"),
        ...localImportClosure("scripts/run-dev-launch-child.mjs"),
        ...localImportClosure("scripts/run-dev-frontend.mjs"),
      ])].sort(),
    );
  });

  it("classifies parent reload before child restart and backend rebuild", () => {
    const impact = devDeployImpact(
      [
        "scripts/lib/dev-launch-supervisor.mjs",
        "orchestration/src/service.rs",
        "src-tauri/src/lib.rs",
      ],
      "darwin",
    );
    expect(impact).toMatchObject({
      kind: "parent_reload",
      backendChanged: true,
      childRestartRequired: true,
    });
    expect(devDeployRequiresChildRestart(impact)).toBe(true);
  });

  it("preserves child preparation as an orthogonal parent impact", () => {
    const changedPaths = ["scripts/run-dev-app.mjs", "package.json"];
    const impact = devDeployImpact(changedPaths, "darwin");

    expect(impact).toMatchObject({
      kind: "parent_reload",
      backendChanged: false,
      childRestartRequired: true,
    });
    expect(changedPathsRequireChildRestart(changedPaths)).toBe(true);
    expect(devDeployRequiresChildRestart(impact)).toBe(true);
  });

  it("requires a cold bootstrap when the target changes the Node runtime pin", () => {
    expect(devDeployImpact([".node-version"], "darwin")).toMatchObject({
      kind: "parent_reload",
      parentStrategy: "cold_bootstrap",
    });
    expect(
      devDeployImpact([".nvmrc", "scripts/run-dev-app.mjs"], "darwin"),
    ).toMatchObject({
      kind: "parent_reload",
      parentStrategy: "cold_bootstrap",
    });
    expect(
      devDeployImpact(["scripts/run-dev-app.mjs"], "darwin"),
    ).toMatchObject({
      kind: "parent_reload",
      parentStrategy: "exec_handoff",
    });
  });

  it("binds a bootstrapped parent to both exact Node runtime pins", () => {
    const root = mkdtempSync(join(tmpdir(), "dure-parent-node-runtime-"));
    temporaryRoots.push(root);
    writeFileSync(join(root, ".node-version"), "24.15.0\n");
    writeFileSync(join(root, ".nvmrc"), "v24.15.0\n");

    expect(assertDevParentNodeRuntime(root, "v24.15.0")).toBe("24.15.0");
    writeFileSync(join(root, ".nvmrc"), "25.0.0\n");
    expect(() => assertDevParentNodeRuntime(root, "v24.15.0")).toThrow(
      /cold_bootstrap_required.*\.nvmrc/,
    );
  });

  it("keeps only launch prerequisites on the child restart path", () => {
    for (const path of [
      "scripts/guard-dev-channel.mjs",
      "scripts/prepare-agent-tools.sh",
      "scripts/dev-agent-tools-current.mjs",
      "scripts/native/native-build-slot.py",
    ]) {
      expect(devDeployImpact([path], "darwin").kind, path).toBe(
        "child_restart",
      );
    }
    expect(devDeployImpact(["cli/dure.mjs"], "darwin").kind).toBe(
      "frontend_reload",
    );
    for (const path of ["scripts/node-dependency-preflight.mjs", "scripts/lib/corepack-install.mjs"]) {
      expect(devDeployImpact([path], "darwin")).toMatchObject({
        kind: DEV_DEPLOY_IMPACT.PARENT_RELOAD,
        childRestartRequired: true,
      });
    }
  });

  it("stages immutable CLI payload changes without restarting the app child", () => {
    for (const path of [
      "cli/lib/agent-spawn-query.mjs",
      "orchestration/integration/index.mjs",
      "scripts/install-dure-cli.mjs",
    ]) {
      const impact = devDeployImpact([path], "darwin");
      expect(controlPlanePayloadStageRequired([path]), path).toBe(true);
      expect(impact, path).toMatchObject({
        kind: DEV_DEPLOY_IMPACT.FRONTEND_RELOAD,
        backendChanged: false,
        controlPlanePayloadChanged: true,
      });
      expect(devDeployRequiresControlPlaneActivation(impact), path).toBe(true);
      expect(devDeployRequiresChildRestart(impact), path).toBe(false);
    }
  });

  it("restarts the child for every dependency installation authority", () => {
    for (const path of [
      ".npmrc",
      ".pnpmfile.cjs",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "patches/runtime.patch",
    ]) {
      expect(nodeDependencyInstallRequired([path]), path).toBe(true);
      expect(devDeployImpact([path], "darwin").kind, path).toBe(
        DEV_DEPLOY_IMPACT.CHILD_RESTART,
      );
    }
    for (const path of [".node-version", ".nvmrc", "scripts/node-dependency-preflight.mjs", "scripts/lib/corepack-install.mjs"]) {
      expect(nodeDependencyInstallRequired([path]), path).toBe(true);
      expect(devDeployImpact([path], "darwin").kind, path).toBe(
        DEV_DEPLOY_IMPACT.PARENT_RELOAD,
      );
    }
  });

  it("does not classify any executed child preparation input as a weaker impact", () => {
    const runSource = readFileSync(
      join(repositoryRoot, "scripts/run-dev-app.mjs"),
      "utf8",
    );
    const prerequisiteSource = readFileSync(
      join(repositoryRoot, "scripts/lib/dev-launch-prerequisites.mjs"),
      "utf8",
    );
    const appChannelSource = readFileSync(
      join(repositoryRoot, "scripts/lib/app-channel.mjs"),
      "utf8",
    );
    expect(runSource).toContain("devLaunchPrerequisites");
    expect(prerequisiteSource).toContain("node-dependency-preflight.mjs");
    expect(prerequisiteSource).toContain("guard-dev-channel.mjs");
    expect(prerequisiteSource).toContain("prepare-agent-tools.sh");
    expect(prerequisiteSource).not.toContain("remote-tools:stage:dev");
    expect(appChannelSource).toContain("beforeDevCommand: null");
    for (const path of childPreparationScriptClosure()) {
      const impact = devDeployImpact([path], "darwin");
      // Payload inputs are prepared by the existing deploy activation path;
      // only launcher-only inputs require the child prerequisite path.
      if (devDeployRequiresControlPlaneActivation(impact)) continue;
      expect(
        [
          DEV_DEPLOY_IMPACT.CHILD_RESTART,
          DEV_DEPLOY_IMPACT.PARENT_RELOAD,
        ],
        path,
      ).toContain(impact.kind);
    }
    expect(DEV_CHILD_PREPARATION_PATHS).toEqual(
      expect.arrayContaining([
        "package.json",
        "pnpm-lock.yaml",
        "scripts/node-dependency-preflight.mjs",
      ]),
    );
  });

  it("leaves Cargo changes on the backend rebuild path", () => {
    expect(
      HMUX_DEV_RUNTIME_INPUTS.filter((input) => input.recursive).map(
        (input) => input.path,
      ),
    ).toEqual(["hmux", "crates/hebbian-process-sampler"]);
    for (const path of [
      "hmux/src/runtime.rs",
      "crates/hebbian-process-sampler/src/lib.rs",
      "crates/dure-app/git-checkout/src/authority.rs",
      "crates/dure-app/protocol/src/git_checkout.rs",
      "crates/dure-app/src/domain_store.rs",
      "scripts/backend-runtime-inputs.txt",
      ".cargo/config.toml",
      "rust-toolchain.toml",
    ]) {
      expect(devDeployImpact([path], "darwin"), path).toMatchObject({
        kind: DEV_DEPLOY_IMPACT.BACKEND_REBUILD,
        backendChanged: true,
      });
    }
    for (const path of HMUX_DEV_RUNTIME_INPUTS.map((input) =>
      input.recursive ? `${input.path}/fixture` : input.path,
    )) {
      expect(hmuxDevRuntimeStageRequired([path]), path).toBe(true);
      expect(devDeployImpact([path], "darwin"), path).toMatchObject({
        hmuxRuntimeChanged: true,
      });
    }
    expect(
      hmuxDevRuntimeStageRequired(["crates/dure-app/src/main.rs"]),
    ).toBe(false);
  });

  it("includes only the active platform config in the parent generation", () => {
    expect(
      devDeployImpact(["src-tauri/tauri.macos.conf.json"], "darwin").kind,
    ).toBe("parent_reload");
    expect(
      devDeployImpact(["src-tauri/tauri.linux.conf.json"], "darwin").kind,
    ).toBe("frontend_reload");
  });

  it("content-addresses every parent-loaded source and config input", () => {
    const root = mkdtempSync(join(tmpdir(), "dure-parent-generation-"));
    temporaryRoots.push(root);
    const generationInputs = [
      ...devParentLoadedPaths("darwin"),
      ".node-version",
      ".nvmrc",
    ];
    for (const relativePath of generationInputs) {
      const pathname = join(root, relativePath);
      mkdirSync(dirname(pathname), { recursive: true });
      writeFileSync(pathname, `${relativePath}\n`);
    }
    const baseline = devParentSourceGeneration(root, "darwin");
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    for (const relativePath of generationInputs) {
      const pathname = join(root, relativePath);
      const original = readFileSync(pathname);
      writeFileSync(pathname, `${relativePath}: changed\n`);
      expect(devParentSourceGeneration(root, "darwin"), relativePath).not.toBe(
        baseline,
      );
      writeFileSync(pathname, original);
    }
  });

  it("fingerprints a live checkout that predates a parent source file as a distinct generation", () => {
    // The queue computes the live worktree's generation with the target
    // commit's path list. A live checkout older than dev-node-tool.mjs must
    // yield a different generation, not an ENOENT that kills the deploy
    // before it can advance that checkout.
    const root = mkdtempSync(join(tmpdir(), "dure-parent-generation-legacy-"));
    temporaryRoots.push(root);
    for (const relativePath of devParentLoadedPaths("darwin")) {
      const pathname = join(root, relativePath);
      mkdirSync(dirname(pathname), { recursive: true });
      writeFileSync(pathname, `${relativePath}\n`);
    }
    const complete = devParentSourceGeneration(root, "darwin");
    rmSync(join(root, "scripts/lib/dev-node-tool.mjs"));

    const legacy = devParentSourceGeneration(root, "darwin");

    expect(legacy).toMatch(/^[a-f0-9]{64}$/);
    expect(legacy).not.toBe(complete);
  });
});
