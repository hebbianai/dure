import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  normalizePushGateScopes,
  parseReleaseGateArguments,
  PUSH_GATE_ORDER,
  runPushGateScopes,
  scriptsForPushGateScopes,
} from "./run-push-gates.mjs";
import { PUSH_GATE_SCOPES } from "./lib/push-gate-scope.mjs";
import { PUSH_GATE_SCRIPTS } from "./lib/push-gate-contract.mjs";
import { assertGeneratedTerminalStateMatches } from "../hmux/crates/terminal-state-protocol/tools/check_generated.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const temporaryDirectories = [];

function releaseRunnerEnvironment({ managedCargoTarget = true } = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "release-gate-environment-"),
  );
  temporaryDirectories.push(root);
  const runnerWork = path.join(root, "_work");
  const runnerTemp = path.join(runnerWork, "_temp");
  const workspace = path.join(runnerWork, "dure-internal", "dure-internal");
  const cargoHome = path.join(runnerTemp, "hebbian-cargo-home");
  const rustupHome = path.join(runnerTemp, "dure-rustup-home");
  const targetRoot = path.join(runnerWork, "_hebbian-ci-targets-v1");
  const targetProfile = path.join(targetRoot, "verify");
  const targetGeneration = path.join(targetProfile, "0123456789abcdef");
  const target = path.join(targetGeneration, "target");
  const lease = path.join(targetProfile, ".lease");
  const live = path.join(root, "live-development");
  const liveRuntimeRoot = path.join(live, "hmux-runtime");
  const liveRuntimeLog = path.join(live, "hmux-runtime.log");
  const liveNodeCache = path.join(live, "node-compile-cache");
  const liveOpencodeDb = path.join(live, "opencode.db");
  const livePnpmRedirect = path.join(live, "pnpm-redirect");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(live, "tmp"), { recursive: true });
  fs.mkdirSync(liveRuntimeRoot, { recursive: true });
  fs.mkdirSync(liveNodeCache, { recursive: true });
  fs.mkdirSync(livePnpmRedirect, { recursive: true });
  fs.writeFileSync(liveRuntimeLog, "live-runtime-sentinel\n");
  fs.writeFileSync(liveOpencodeDb, "live-opencode\n");
  fs.writeFileSync(path.join(liveNodeCache, "sentinel"), "live-node-cache\n");
  fs.writeFileSync(path.join(livePnpmRedirect, "sentinel"), "live-pnpm\n");
  fs.mkdirSync(cargoHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(rustupHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cargoHome, ".hebbian-ci-owner"), "12345:1:candidate\n");
  if (managedCargoTarget) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.mkdirSync(lease, { mode: 0o700 });
    fs.writeFileSync(
      path.join(targetRoot, ".hebbian-ci-target-root"),
      "hebbian-ci-target-root-v1\n",
    );
    fs.writeFileSync(
      path.join(targetGeneration, ".hebbian-ci-target-owner"),
      "format=1\nprofile=verify\nrust=0123456789abcdef\n",
    );
    fs.writeFileSync(
      path.join(lease, ".hebbian-ci-lease"),
      "12345:1:candidate\n",
    );
  }
  return {
    isolationRoot: path.join(
      fs.realpathSync(runnerTemp),
      "dure-release-verification-12345-1-candidate",
    ),
    live,
    liveNodeCache,
    liveOpencodeDb,
    livePnpmRedirect,
    liveRuntimeLog,
    liveRuntimeRoot,
    workspace: fs.realpathSync(workspace),
    source: {
      ...process.env,
      ANTHROPIC_CONFIG_DIR: path.join(live, "anthropic"),
      CARGO_HOME: fs.realpathSync(cargoHome),
      CARGO_TARGET_DIR: managedCargoTarget
        ? fs.realpathSync(target)
        : path.join(live, "cargo-target"),
      CLAUDE_CONFIG_DIR: path.join(live, "claude"),
      CODEX_HOME: path.join(live, "codex"),
      CODEX_SQLITE_HOME: path.join(live, "codex-sqlite"),
      DURE_BUILD_STORAGE_RESERVATION_V1: "shared-build-reservation",
      DURE_CLI_INSTALL_DIR: path.join(live, "dure-cli-bin"),
      DURE_CLI_INSTALL_ROOT: path.join(live, "dure-cli"),
      DURE_DEV_LIVE_WORKTREE: path.join(live, "worktree"),
      DURE_GHOSTTY_VT_CACHE_ROOT: path.join(live, "ghostty-cache"),
      DURE_HOME: path.join(live, "dure-home"),
      GEMINI_CLI_HOME: path.join(live, "gemini"),
      GITHUB_ACTIONS: "true",
      GITHUB_JOB: "candidate",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "12345",
      GITHUB_WORKSPACE: workspace,
      HEBBIAN_CI_RUNNER_TEMP: runnerTemp,
      HEBBIAN_CI_TARGET_PROFILE: "verify",
      HEBBIAN_CI_TARGET_ROOT: managedCargoTarget
        ? fs.realpathSync(targetRoot)
        : targetRoot,
      HEBBIAN_HMUX_BIN: path.join(live, "hmux"),
      HEBBIAN_IDE_CLI_INSTALL_ROOT: path.join(live, "legacy-dure-cli"),
      HMUX: path.join(live, "hmux-runtime"),
      HMUX_CHANNEL_EPOCH: "9",
      HMUX_DISCOVERY_ROOT: path.join(live, "hmux-discovery"),
      HMUX_INSTALL_DIR: path.join(live, "hmux-bin"),
      HMUX_INSTALL_ROOT: path.join(live, "hmux-install"),
      HMUX_RUNTIME_LOG: liveRuntimeLog,
      HMUX_RUNTIME_ROOT: liveRuntimeRoot,
      HMUX_STAGE_ARTIFACT_DIR: path.join(live, "hmux-stage"),
      HMUX_SESSION_ID: "live-session",
      HMUX_WORKSPACE_ID: "live-workspace",
      HOME: path.join(live, "home"),
      GROK_HOME: path.join(live, "grok"),
      KIMI_CODE_HOME: path.join(live, "kimi"),
      NODE_COMPILE_CACHE: liveNodeCache,
      NpM_CoNfIg_Modules_Dir: livePnpmRedirect,
      OPENCODE_DB: liveOpencodeDb,
      PI_CODING_AGENT_DIR: path.join(live, "pi-agent"),
      PI_CODING_AGENT_SESSION_DIR: path.join(live, "pi-sessions"),
      RUSTUP_HOME: fs.realpathSync(rustupHome),
      TAURI_CONFIG: '{"identifier":"dev.example.live"}',
      TMPDIR: path.join(live, "tmp"),
      VITEST_MAX_WORKERS: "99",
      XDG_RUNTIME_DIR: path.join(live, "xdg-runtime"),
      npm_config_store_dir: path.join(live, "pnpm-store"),
      npm_config_virtual_store_dir: livePnpmRedirect,
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("release gate runner", () => {
  test.runIf(process.platform === "darwin")(
    "binds a real Unix socket inside the isolated release runtime root",
    () => {
      const fixture = releaseRunnerEnvironment();
      let socketObservation;
      const run = (_command, _args, options) => {
        const socketPath = path.join(
          options.env.HMUX_RUNTIME_ROOT,
          `${"0".repeat(24)}.sock`,
        );
        socketObservation = spawnSync(
          "/usr/bin/python3",
          ["-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()", socketPath],
          { encoding: "utf8" },
        );
        return { status: socketObservation.status };
      };
      const status = runPushGateScopes(["process"], run, {
        environment: fixture.source,
        releaseIsolation: true,
        workingDirectory: fixture.workspace,
      });
      expect(socketObservation.stderr).toBe("");
      expect(status).toBe(0);
      expect(fs.existsSync(fixture.isolationRoot)).toBe(false);
    },
  );

  test("admits only one full release invocation", () => {
    expect(parseReleaseGateArguments(["--all"])).toBe("--all");
    expect(parseReleaseGateArguments(["--", "--all"])).toBe("--all");
    expect(() => parseReleaseGateArguments([])).toThrow("usage");
    expect(() => parseReleaseGateArguments(["desktop"])).toThrow("usage");
    expect(() => parseReleaseGateArguments(["--all", "desktop"])).toThrow(
      "usage",
    );
  });

  test("keeps classification and execution registries exhaustive", () => {
    expect([...PUSH_GATE_SCOPES].sort()).toEqual([...PUSH_GATE_ORDER].sort());
    expect(Object.keys(PUSH_GATE_SCRIPTS).sort()).toEqual(
      [...PUSH_GATE_ORDER].sort(),
    );
  });

  test("canonicalizes a mixed scope union and runs every gate once", () => {
    expect(
      normalizePushGateScopes([
        "mobile-rust",
        "desktop",
        "frontend",
        "desktop",
      ]),
    ).toEqual(["frontend", "desktop", "mobile-rust"]);
    expect(
      scriptsForPushGateScopes('["desktop","hmux-core","desktop"]'),
    ).toEqual(["verify:push:hmux-core", "verify:push:desktop"]);
    expect(normalizePushGateScopes("--all")).toEqual(PUSH_GATE_ORDER);
    expect(scriptsForPushGateScopes("--all")[0]).toBe(
      "verify:push:all-js:checks",
    );
    expect(scriptsForPushGateScopes(["frontend"])).toEqual([
      "verify:push:frontend",
    ]);
    expect(scriptsForPushGateScopes(["tooling"])).toEqual([
      "verify:push:tooling",
    ]);
    expect(scriptsForPushGateScopes(["qa-tooling"])).toEqual([
      "verify:push:qa-tooling",
    ]);
    expect(scriptsForPushGateScopes(["script-tests"])).toEqual([
      "verify:push:script-tests",
    ]);
    expect(scriptsForPushGateScopes("--all")).toContain(
      "verify:push:tooling:syntax",
    );
    expect(scriptsForPushGateScopes("--all")).toContain(
      "verify:push:qa-tooling:syntax",
    );
    expect(scriptsForPushGateScopes("--all")).not.toContain(
      "verify:push:tooling",
    );
    expect(scriptsForPushGateScopes("--all")).not.toContain(
      "verify:push:qa-tooling",
    );
    expect(scriptsForPushGateScopes("--all")).not.toContain(
      "verify:push:script-tests",
    );
  });

  test("collapses only checks already covered by the all-JavaScript gate", () => {
    const { scripts } = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    );

    expect(scripts["verify:push:all-js:checks"]).toContain("pnpm typecheck");
    expect(scripts["verify:push:all-js:checks"]).toContain("pnpm test");
    expect(scripts["verify:push:tooling"]).toContain(
      "pnpm verify:push:tooling:syntax",
    );
    expect(scripts["verify:push:tooling"]).toContain(
      "vitest run scripts/media-capture-contract.test.mjs",
    );
    expect(scripts["verify:push:qa-tooling"]).toContain("pnpm typecheck");
    expect(scripts["verify:push:qa-tooling"]).toContain(
      "pnpm verify:push:qa-tooling:syntax",
    );
  });

  test("runs protocol drift rejection without unrelated product gates", () => {
    const { scripts } = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    );

    expect(scriptsForPushGateScopes(["terminal-state-protocol"])).toEqual([
      "verify:push:terminal-state-protocol",
    ]);
    expect(scripts["verify:push:terminal-state-protocol"]).toContain(
      "terminal-state-protocol:check",
    );
    expect(scripts["verify:push:terminal-state-protocol"]).not.toContain(
      "verify:push:frontend",
    );
    expect(scripts["verify:push:terminal-state-protocol"]).not.toContain(
      "verify:push:hmux-core",
    );
    expect(scripts["terminal-state-protocol:check"]).toContain(
      "check_generated.mjs",
    );

    const provision = scripts["terminal-state-protocol:provision"];
    expect(provision).toContain("pnpm install --frozen-lockfile");
    expect(provision).toContain("rustup toolchain install 1.85.0");
    expect(scripts["verify:push:terminal-state-protocol"]).toContain(
      "terminal-state-protocol:provision",
    );
    expect(scripts["verify:push:terminal-state-protocol"]).toContain(
      "architecture:check",
    );
    expect(scripts["verify:push:terminal-state-protocol"]).toContain(
      "typecheck",
    );
    expect(scripts["terminal-state-protocol:check"]).toContain("buf breaking");

    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "terminal-state-gate-"),
    );
    const generated = path.join(fixtureRoot, "generated");
    const stale = path.join(fixtureRoot, "checked-in");
    fs.mkdirSync(generated);
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(generated, "state_pb.ts"), "current\n");
    fs.writeFileSync(path.join(stale, "state_pb.ts"), "stale\n");
    try {
      expect(() =>
        assertGeneratedTerminalStateMatches(generated, stale),
      ).toThrow("generated terminal state content drift");
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("keeps code generation out of the runtime leaf and freezes previous compatibility", () => {
    const leafManifest = fs.readFileSync(
      path.join(
        repositoryRoot,
        "hmux/crates/terminal-state-protocol/Cargo.toml",
      ),
      "utf8",
    );
    const workspaceManifest = fs.readFileSync(
      path.join(repositoryRoot, "hmux/Cargo.toml"),
      "utf8",
    );
    const previousSchema = path.join(
      repositoryRoot,
      "hmux/crates/terminal-state-protocol/compat/previous/schema",
    );
    const previousFixture = path.join(
      repositoryRoot,
      "hmux/crates/terminal-state-protocol/compat/previous/terminal-state-v1.bin",
    );

    expect(leafManifest).not.toContain("prost-build");
    expect(leafManifest).not.toContain("protoc-bin-vendored");
    expect(leafManifest).not.toContain("features");
    expect(leafManifest).not.toContain("[[bin]]");
    expect(workspaceManifest).toContain(
      "xtask/terminal-state-protocol-codegen",
    );
    expect(fs.statSync(previousSchema).isDirectory()).toBe(true);
    expect(fs.statSync(previousFixture).isFile()).toBe(true);
  });

  test("skips code suites for an empty documentation scope", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const run = vi.fn();

    expect(runPushGateScopes([], run)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "release verification: no product scopes selected",
    );
  });

  test("pins nested pnpm commands through Corepack and removes the shim", () => {
    let shimDirectory;
    let shimSource;
    const run = vi.fn((_command, _args, options) => {
      shimDirectory = options.env.PATH.split(path.delimiter)[0];
      shimSource = fs.readFileSync(path.join(shimDirectory, "pnpm"), "utf8");
      return { status: 0 };
    });

    expect(runPushGateScopes(["process"], run)).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0].slice(0, 2)).toEqual([
      "corepack",
      ["pnpm", "verify:push:process"],
    ]);
    expect(shimSource).toContain('exec corepack pnpm "$@"');
    expect(fs.existsSync(shimDirectory)).toBe(false);
  });

  test("does not leak a dev app Tauri override into checked Cargo gates", () => {
    vi.stubEnv(
      "TAURI_CONFIG",
      JSON.stringify({
        app: { macOSPrivateApi: true },
        identifier: "dev.example.worktree",
      }),
    );
    let gateEnvironment;
    const run = vi.fn((_command, _args, options) => {
      gateEnvironment = options.env;
      return { status: 0 };
    });

    expect(runPushGateScopes(["desktop", "mobile-rust"], run)).toBe(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(gateEnvironment.TAURI_CONFIG).toBeUndefined();
    expect(process.env.TAURI_CONFIG).toContain("dev.example.worktree");
  });

  test("fails closed before a release gate can use an ambient dev Cargo target", () => {
    const fixture = releaseRunnerEnvironment({ managedCargoTarget: false });
    for (const [name, value] of Object.entries(fixture.source)) {
      if (typeof value === "string") vi.stubEnv(name, value);
    }
    const run = vi.fn(() => ({ status: 0 }));

    expect(() =>
      runPushGateScopes(["process"], run, {
        environment: fixture.source,
        releaseIsolation: true,
        workingDirectory: fixture.workspace,
      }),
    ).toThrow(/release verification isolation.*Cargo target/i);
    expect(run).not.toHaveBeenCalled();
  });

  test.each([
    [
      "Cargo home ownership marker",
      (fixture) =>
        fs.writeFileSync(
          path.join(fixture.source.CARGO_HOME, ".hebbian-ci-owner"),
          "99999:1:candidate\n",
        ),
    ],
    [
      "Cargo target generation marker",
      (fixture) =>
        fs.writeFileSync(
          path.join(
            path.dirname(fixture.source.CARGO_TARGET_DIR),
            ".hebbian-ci-target-owner",
          ),
          "format=1\nprofile=verify\nrust=fedcba9876543210\n",
        ),
    ],
    [
      "Cargo target lease",
      (fixture) =>
        fs.writeFileSync(
          path.join(
            path.dirname(path.dirname(fixture.source.CARGO_TARGET_DIR)),
            ".lease",
            ".hebbian-ci-lease",
          ),
          "99999:1:candidate\n",
        ),
    ],
  ])("rejects a stale %s before running any release gate", (label, poison) => {
    const fixture = releaseRunnerEnvironment();
    poison(fixture);
    const run = vi.fn(() => ({ status: 0 }));

    expect(() =>
      runPushGateScopes(["process"], run, {
        environment: fixture.source,
        releaseIsolation: true,
        workingDirectory: fixture.workspace,
      }),
    ).toThrow(new RegExp(`release verification isolation.*${label}`, "i"));
    expect(run).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.isolationRoot)).toBe(false);
  });

  test.each(["legacy", "sibling", "symlink"])(
    "rejects a %s Cargo output path before invoking release work",
    (kind) => {
      const fixture = releaseRunnerEnvironment();
      const target = fixture.source.CARGO_TARGET_DIR;
      if (kind === "legacy") {
        fixture.source.CARGO_TARGET_DIR = path.dirname(target);
      } else if (kind === "sibling") {
        const sibling = path.join(path.dirname(target), "other");
        fs.mkdirSync(sibling);
        fixture.source.CARGO_TARGET_DIR = sibling;
      } else {
        fs.rmdirSync(target);
        fs.symlinkSync(fixture.live, target);
      }
      const run = vi.fn(() => ({ status: 0 }));

      expect(() =>
        runPushGateScopes(["process"], run, {
          environment: fixture.source,
          releaseIsolation: true,
          workingDirectory: fixture.workspace,
        }),
      ).toThrow(/release verification isolation.*Cargo target/i);
      expect(run).not.toHaveBeenCalled();
      expect(fs.existsSync(fixture.isolationRoot)).toBe(false);
    },
  );

  test("rejects a release gate launched outside the admitted checkout", () => {
    const fixture = releaseRunnerEnvironment();
    const run = vi.fn(() => ({ status: 0 }));

    expect(() =>
      runPushGateScopes(["process"], run, {
        environment: fixture.source,
        releaseIsolation: true,
        workingDirectory: fixture.live,
      }),
    ).toThrow(/release verification isolation.*cwd.*exact GitHub workspace/i);
    expect(run).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.isolationRoot)).toBe(false);
  });

  test("repairs release dependencies after normalizing every npm config key", () => {
    const fixture = releaseRunnerEnvironment();
    const shimBin = path.join(fixture.workspace, "shim-bin");
    fs.mkdirSync(shimBin);
    fs.writeFileSync(
      path.join(fixture.workspace, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\npackages: {}\n",
    );
    fs.writeFileSync(
      path.join(shimBin, "corepack"),
      "#!/bin/sh\n" +
        'test "$*" = "pnpm install --frozen-lockfile --force" || exit 44\n' +
        'printf "%s\\n" "$HOME|$NODE_COMPILE_CACHE|$npm_config_store_dir|${npm_config_virtual_store_dir-unset}|${NpM_CoNfIg_Modules_Dir-unset}" > install-env.txt\n' +
        "mkdir -p node_modules/.pnpm\n" +
        "cp pnpm-lock.yaml node_modules/.pnpm/lock.yaml\n",
      { mode: 0o700 },
    );
    fixture.source.PATH = `${shimBin}${path.delimiter}${fixture.source.PATH ?? ""}`;
    fixture.source.DURE_COREPACK_EXECUTABLE = path.join(shimBin, "corepack");
    const run = vi.fn(() => ({ status: 0 }));

    expect(
      runPushGateScopes(["frontend"], run, {
        environment: fixture.source,
        releaseIsolation: true,
        workingDirectory: fixture.workspace,
      }),
    ).toBe(0);

    const [home, nodeCache, pnpmStore, virtualStore, mixedCaseModules] = fs
      .readFileSync(path.join(fixture.workspace, "install-env.txt"), "utf8")
      .trim()
      .split("|");
    for (const ownedPath of [home, nodeCache, pnpmStore]) {
      expect(ownedPath).toMatch(
        new RegExp(`^${fixture.isolationRoot.replaceAll("/", "\\/")}\/`),
      );
    }
    expect(virtualStore).toBe("unset");
    expect(mixedCaseModules).toBe("unset");
    expect(run).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(fixture.livePnpmRedirect, "sentinel"), "utf8")).toBe(
      "live-pnpm\n",
    );
    expect(fs.existsSync(fixture.isolationRoot)).toBe(false);
  });

  test("replaces every mutable live authority for an isolated release gate", () => {
    const fixture = releaseRunnerEnvironment();
    for (const [name, value] of Object.entries(fixture.source)) {
      if (typeof value === "string") vi.stubEnv(name, value);
    }
    let gateEnvironment;
    let shortTempEvidence;
    const run = vi.fn((_command, _args, options) => {
      gateEnvironment = options.env;
      const shortTempRoot = path.dirname(gateEnvironment.TMPDIR);
      const rootMetadata = fs.lstatSync(shortTempRoot);
      const directoryMetadata = fs.lstatSync(gateEnvironment.TMPDIR);
      const marker = path.join(
        shortTempRoot,
        ".dure-release-verification-owner",
      );
      const markerMetadata = fs.lstatSync(marker);
      const hmuxRuntimeMetadata = fs.lstatSync(
        gateEnvironment.HMUX_RUNTIME_ROOT,
      );
      shortTempEvidence = {
        directoryMode: directoryMetadata.mode & 0o777,
        directorySymbolicLink: directoryMetadata.isSymbolicLink(),
        hmuxRuntimeMode: hmuxRuntimeMetadata.mode & 0o777,
        hmuxRuntimeOwner: hmuxRuntimeMetadata.uid,
        hmuxRuntimeRealPath: fs.realpathSync(
          gateEnvironment.HMUX_RUNTIME_ROOT,
        ),
        hmuxRuntimeSymbolicLink: hmuxRuntimeMetadata.isSymbolicLink(),
        markerContents: fs.readFileSync(marker, "utf8"),
        markerMode: markerMetadata.mode & 0o777,
        markerSymbolicLink: markerMetadata.isSymbolicLink(),
        owner: rootMetadata.uid,
        realRoot: fs.realpathSync(shortTempRoot),
        root: shortTempRoot,
        rootDevice: rootMetadata.dev,
        rootMode: rootMetadata.mode & 0o777,
        rootSymbolicLink: rootMetadata.isSymbolicLink(),
      };
      fs.writeFileSync(gateEnvironment.HMUX_RUNTIME_LOG, "release-runtime\n");
      fs.writeFileSync(
        path.join(gateEnvironment.HMUX_RUNTIME_ROOT, "runtime-sentinel"),
        "release-runtime\n",
      );
      fs.writeFileSync(
        path.join(gateEnvironment.XDG_RUNTIME_DIR, "sampler-sentinel"),
        "release-sampler\n",
      );
      fs.writeFileSync(
        path.join(gateEnvironment.NODE_COMPILE_CACHE, "owned-sentinel"),
        "release-node-cache\n",
      );
      fs.writeFileSync(
        path.join(gateEnvironment.npm_config_store_dir, "owned-sentinel"),
        "release-pnpm\n",
      );
      fs.writeFileSync(gateEnvironment.OPENCODE_DB, "release-opencode\n");
      return { status: 0 };
    });

    expect(
      runPushGateScopes(["process"], run, {
        environment: fixture.source,
        releaseIsolation: true,
        workingDirectory: fixture.workspace,
      }),
    ).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    for (const name of [
      "HOME",
      "DURE_HOME",
      "HMUX_DISCOVERY_ROOT",
      "XDG_RUNTIME_DIR",
      "DURE_GHOSTTY_VT_CACHE_ROOT",
      "NODE_COMPILE_CACHE",
      "COREPACK_HOME",
      "npm_config_cache",
      "npm_config_store_dir",
      "PNPM_HOME",
      "npm_config_prefix",
      "CARGO_INSTALL_ROOT",
      "HMUX_INSTALL_ROOT",
      "HMUX_INSTALL_DIR",
      "DURE_CLI_INSTALL_ROOT",
      "DURE_CLI_INSTALL_DIR",
      "HMUX_STAGE_ARTIFACT_DIR",
      "CODEX_HOME",
      "CODEX_SQLITE_HOME",
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_CONFIG_DIR",
      "KIMI_CODE_HOME",
      "GEMINI_CLI_HOME",
      "PI_CODING_AGENT_DIR",
      "PI_CODING_AGENT_SESSION_DIR",
      "GROK_HOME",
      "ZIG_GLOBAL_CACHE_DIR",
      "ZIG_LOCAL_CACHE_DIR",
    ]) {
      expect(gateEnvironment[name]).toMatch(
        new RegExp(`^${fixture.isolationRoot.replaceAll("/", "\\/")}\/`),
      );
      expect(gateEnvironment[name]).not.toContain(fixture.live);
    }
    expect(gateEnvironment.TEMP).toBe(gateEnvironment.TMPDIR);
    expect(gateEnvironment.TMP).toBe(gateEnvironment.TMPDIR);
    if (process.platform === "win32") {
      expect(gateEnvironment.TMPDIR).toMatch(
        new RegExp(`^${fixture.isolationRoot.replaceAll("/", "\\/")}\\/`),
      );
      expect(gateEnvironment.HMUX_RUNTIME_ROOT).toMatch(
        new RegExp(`^${fixture.isolationRoot.replaceAll("/", "\\/")}\\/`),
      );
    } else {
      expect(path.dirname(shortTempEvidence.root)).toBe(fs.realpathSync("/tmp"));
      expect(path.basename(shortTempEvidence.root)).toMatch(/^dure-rv-.{6}$/);
      expect(shortTempEvidence.realRoot).toBe(shortTempEvidence.root);
      expect(shortTempEvidence.rootSymbolicLink).toBe(false);
      expect(shortTempEvidence.directorySymbolicLink).toBe(false);
      expect(shortTempEvidence.markerSymbolicLink).toBe(false);
      expect(shortTempEvidence.rootMode).toBe(0o700);
      expect(shortTempEvidence.directoryMode).toBe(0o700);
      expect(shortTempEvidence.markerMode).toBe(0o600);
      expect(shortTempEvidence.owner).toBe(process.getuid());
      expect(shortTempEvidence.rootDevice).toBe(
        fs.lstatSync(fs.realpathSync(fixture.source.HEBBIAN_CI_RUNNER_TEMP)).dev,
      );
      expect(shortTempEvidence.markerContents).toBe("12345:1:candidate\n");
      expect(path.dirname(gateEnvironment.HMUX_RUNTIME_ROOT)).toBe(
        gateEnvironment.TMPDIR,
      );
      expect(shortTempEvidence.hmuxRuntimeRealPath).toBe(
        gateEnvironment.HMUX_RUNTIME_ROOT,
      );
      expect(shortTempEvidence.hmuxRuntimeSymbolicLink).toBe(false);
      expect(shortTempEvidence.hmuxRuntimeMode).toBe(0o700);
      expect(shortTempEvidence.hmuxRuntimeOwner).toBe(process.getuid());
      expect(
        Buffer.byteLength(
          path.join(
            fixture.isolationRoot,
            "runtime/hmux",
            `${"0".repeat(24)}.sock`,
          ),
        ),
      ).toBeGreaterThanOrEqual(104);
      expect(
        Buffer.byteLength(
          path.join(
            gateEnvironment.HMUX_RUNTIME_ROOT,
            `${"0".repeat(24)}.sock`,
          ),
        ),
      ).toBeLessThan(104);
      expect(
        Buffer.byteLength(
          path.join(
            gateEnvironment.TMPDIR,
            "dure-backend-transport-XXXXXX",
            "supervisor.sock",
          ),
        ),
      ).toBeLessThan(104);
    }
    expect(gateEnvironment.CARGO_HOME).toBe(fixture.source.CARGO_HOME);
    expect(gateEnvironment.CARGO_TARGET_DIR).toBe(
      fixture.source.CARGO_TARGET_DIR,
    );
    expect(gateEnvironment.RUSTUP_HOME).toBe(fixture.source.RUSTUP_HOME);
    expect(gateEnvironment.DURE_BUILD_STORAGE_RESERVATION_V1).toBe(
      "shared-build-reservation",
    );
    expect(gateEnvironment.TAURI_CONFIG).toBeUndefined();
    expect(gateEnvironment.VITEST_MAX_WORKERS).toBe("1");
    expect(gateEnvironment.HMUX_RUNTIME_LOG).toMatch(
      new RegExp(`^${fixture.isolationRoot.replaceAll("/", "\\/")}\/`),
    );
    expect(gateEnvironment.HMUX_RUNTIME_LOG).not.toBe(fixture.liveRuntimeLog);
    expect(gateEnvironment.OPENCODE_DB).toMatch(
      new RegExp(`^${fixture.isolationRoot.replaceAll("/", "\\/")}\/`),
    );
    expect(gateEnvironment.OPENCODE_DB).not.toBe(fixture.liveOpencodeDb);
    expect(gateEnvironment.npm_config_virtual_store_dir).toBeUndefined();
    expect(gateEnvironment.NpM_CoNfIg_Modules_Dir).toBeUndefined();
    for (const name of [
      "DURE_DEV_LIVE_WORKTREE",
      "HEBBIAN_HMUX_BIN",
      "HEBBIAN_IDE_CLI_INSTALL_ROOT",
      "HMUX",
      "HMUX_CHANNEL_EPOCH",
      "HMUX_SESSION_ID",
      "HMUX_WORKSPACE_ID",
    ]) {
      expect(gateEnvironment[name]).toBeUndefined();
    }
    expect(fs.readFileSync(fixture.liveRuntimeLog, "utf8")).toBe(
      "live-runtime-sentinel\n",
    );
    expect(
      fs.existsSync(path.join(fixture.liveRuntimeRoot, "runtime-sentinel")),
    ).toBe(false);
    expect(fs.readFileSync(path.join(fixture.liveNodeCache, "sentinel"), "utf8")).toBe(
      "live-node-cache\n",
    );
    expect(
      fs.readFileSync(path.join(fixture.livePnpmRedirect, "sentinel"), "utf8"),
    ).toBe("live-pnpm\n");
    expect(fs.readFileSync(fixture.liveOpencodeDb, "utf8")).toBe(
      "live-opencode\n",
    );
    expect(fs.existsSync(gateEnvironment.HMUX_RUNTIME_ROOT)).toBe(false);
    expect(fs.existsSync(shortTempEvidence.root)).toBe(false);
    expect(fs.existsSync(fixture.isolationRoot)).toBe(false);
  });

  test
    .runIf(process.platform !== "win32")
    .each([
      ["disappears", false, /short release temp root does not exist/i],
      ["changes identity", true, /short release temp root identity changed/i],
    ])(
      "fails closed if the short release temp %s during a gate",
      (_label, replace, error) => {
        const fixture = releaseRunnerEnvironment();
        let movedRoot;
        let shortTempRoot;
        const run = vi.fn((_command, _args, options) => {
          shortTempRoot = path.dirname(options.env.TMPDIR);
          movedRoot = `${shortTempRoot}.moved`;
          fs.renameSync(shortTempRoot, movedRoot);
          if (replace) {
            fs.mkdirSync(shortTempRoot, { mode: 0o700 });
            fs.writeFileSync(
              path.join(shortTempRoot, ".dure-release-verification-owner"),
              "12345:1:candidate\n",
              { mode: 0o600 },
            );
            fs.mkdirSync(path.join(shortTempRoot, "tmp"), { mode: 0o700 });
          }
          return { status: 0 };
        });

        try {
          expect(() =>
            runPushGateScopes(["process"], run, {
              environment: fixture.source,
              releaseIsolation: true,
              workingDirectory: fixture.workspace,
            }),
          ).toThrow(error);
          expect(run).toHaveBeenCalledTimes(1);
          expect(fs.existsSync(fixture.isolationRoot)).toBe(false);
        } finally {
          if (shortTempRoot) {
            fs.rmSync(shortTempRoot, { force: true, recursive: true });
          }
          if (movedRoot) {
            fs.rmSync(movedRoot, { force: true, recursive: true });
          }
        }
      },
    );

  test("leaves ordinary scoped gate environments unchanged", () => {
    const liveHome = path.join(os.tmpdir(), "ordinary-scoped-gate-home");
    vi.stubEnv("DURE_HOME", liveHome);
    vi.stubEnv("VITEST_MAX_WORKERS", "3");
    let gateEnvironment;
    const run = vi.fn((_command, _args, options) => {
      gateEnvironment = options.env;
      return { status: 0 };
    });

    expect(runPushGateScopes(["process"], run)).toBe(0);
    expect(gateEnvironment.DURE_HOME).toBe(liveHome);
    expect(gateEnvironment.VITEST_MAX_WORKERS).toBe("3");
  });

  test("removes release-owned mutable state when a gate spawn fails", () => {
    const fixture = releaseRunnerEnvironment();
    const spawnFailure = new Error("spawn isolated corepack ENOENT");
    let gateEnvironment;
    const run = vi.fn((_command, _args, options) => {
      gateEnvironment = options.env;
      return { error: spawnFailure };
    });

    expect(() =>
      runPushGateScopes(["process"], run, {
        environment: fixture.source,
        releaseIsolation: true,
        workingDirectory: fixture.workspace,
      }),
    ).toThrow(spawnFailure);
    expect(run).toHaveBeenCalledTimes(1);
    expect(gateEnvironment.DURE_RELEASE_VERIFICATION_ROOT).toBe(
      fixture.isolationRoot,
    );
    expect(fs.existsSync(path.dirname(gateEnvironment.TMPDIR))).toBe(false);
    expect(fs.existsSync(fixture.isolationRoot)).toBe(false);
  });

  test("stops on the first failed gate without retrying", () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 7 })
      .mockReturnValueOnce({ status: 7 });

    expect(
      runPushGateScopes(["frontend", "desktop", "mobile-rust"], run),
    ).toBe(7);
    // frontend passes, desktop fails once, mobile-rust never runs.
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0].slice(0, 2)).toEqual([
      "corepack",
      ["pnpm", "verify:push:frontend"],
    ]);
    expect(run.mock.calls[1].slice(0, 2)).toEqual([
      "corepack",
      ["pnpm", "verify:push:desktop"],
    ]);
  });

  test("a first failure cannot become a green release", () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 7 })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 });

    expect(runPushGateScopes(["frontend", "desktop"], run)).toBe(7);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("propagates a spawn failure and still removes the shim", () => {
    const spawnFailure = new Error("spawn corepack ENOENT");
    let shimDirectory;
    const run = vi.fn((_command, _args, options) => {
      shimDirectory = options.env.PATH.split(path.delimiter)[0];
      return { error: spawnFailure };
    });

    expect(() => runPushGateScopes(["process"], run)).toThrow(
      spawnFailure,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(shimDirectory)).toBe(false);
  });

  test("rejects unknown or malformed scope input", () => {
    expect(() => normalizePushGateScopes(["unknown"])).toThrow(
      "unknown push gate scope",
    );
    expect(() => normalizePushGateScopes('{"scope":"desktop"}')).toThrow(
      "must be an array",
    );
  });
});
