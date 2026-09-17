#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  appControlDirectory, canonicalAppChannelEnvironment, devHmuxEnvironment,
  mergeTauriConfigs, platformTauriConfigFile,
} from "./lib/app-channel.mjs";
import { devTauriCliInvocation } from "./lib/dev-tauri-cli.mjs";
import { assertOwnerOnlyDirectory } from "./lib/dev-launch-storage.mjs";
import { writeAtomicFile } from "./lib/durable-file.mjs";
import { superviseDevLaunch } from "./lib/dev-launch-supervisor.mjs";
import { parseMetadata } from "../cli/lib/dure-cli-channel-launcher.mjs";
import { defaultDiscoveryRoots } from "./lib/hmux-version-gc.mjs";
import { qaWindowPlan } from "./qa/lib/tauri-window-config.mjs";
import {
  prepareWorktreePresentation, readWorktreeReleaseReceipt, stageWorktreeReleaseBundle, worktreeReleasePlan,
} from "./lib/worktree-release.mjs";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));

export async function runWorktreeRelease(arguments_ = process.argv.slice(2), { qa } = {}) {
  const action = arguments_[0] ?? "start";
  if (["--help", "-h", "help"].includes(action)) {
    process.stdout.write("Usage: pnpm app:worktree:release [build|start|--print-config]\nBuild a separate worktree app, then start it with a one-time presentation copy from its dev app.\nThe dev app must support presentation export on the first start. Rebuild explicitly for source updates.\n");
    return;
  }
  if (arguments_.length > 1 || !["build", "start", "--print-config"].includes(action)) {
    throw new Error("expected build, start, or --print-config");
  }
  const root = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(), encoding: "utf8",
  }).trim());
  if (root !== realpathSync(sourceRoot)) throw new Error("run the worktree release launcher from its own checkout");
  const home = process.env.HOME || homedir();
  // The existing supervisor's control directory is HOME/.dure. Do not silently
  // split its authority from a custom runtime DURE_HOME.
  if (process.env.DURE_HOME && resolve(process.env.DURE_HOME) !== join(home, ".dure")) {
    throw new Error("worktree release requires DURE_HOME to be HOME/.dure; use an isolated HOME for QA");
  }
  const base = mergeTauriConfigs(
    JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")),
    JSON.parse(readFileSync(join(root, "src-tauri", platformTauriConfigFile()), "utf8")),
  );
  const plan = worktreeReleasePlan(root, process.env.HEBBIAN_DEV_INSTANCE, base);
  if (qa) {
    const stateRoot = realpathSync(qa.stateRoot);
    if (!["build", "start"].includes(action) || realpathSync(home) !== join(stateRoot, "home") ||
      realpathSync(process.env.HMUX_DISCOVERY_ROOT) !== join(stateRoot, "hmux-discovery")) {
      throw new Error("worktree release QA requires the app runner's exact disposable roots");
    }
    plan.config.app.windows = qaWindowPlan({
      serialized: qa.windows, title: "Dure worktree release QA", url: "index.html",
    });
  }
  if (action === "--print-config") {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error("the worktree app bundle launcher currently requires macOS");
  }
  const directory = appControlDirectory(home, plan.profile.targetChannel);
  assertOwnerOnlyDirectory(directory, { create: true });
  const receiptPath = join(directory, "worktree-release-build.json");
  const artifactRoot = join(root, "src-tauri/target/worktree-release", plan.profile.targetChannel);
  const cliRoot = join(home, ".local/share/hebbian-ide-cli/channels", plan.profile.targetChannel);
  const serializedProfile = JSON.stringify(plan.profile);
  const environment = canonicalAppChannelEnvironment(plan.profile.targetChannel, {
    ...process.env,
    ...devHmuxEnvironment(home, plan.profile.sourceChannel, process.env.PATH),
    HOME: home,
    DURE_HOME: join(home, ".dure"),
    DURE_WORKTREE_RELEASE_PROFILE: serializedProfile,
    VITE_DURE_WORKTREE_RELEASE_PROFILE: serializedProfile,
    CARGO_TARGET_DIR: join(root, "src-tauri/target"),
  }, { includeVite: true });
  delete environment.DURE_MACOS_DEV_BUNDLE;
  delete environment.DURE_MACOS_DEV_BUNDLE_KEY;
  delete environment.DURE_DEV_WEBVIEW_DATA_STORE_IDENTIFIER;
  const canonicalDiscovery = defaultDiscoveryRoots({ HOME: home, DURE_HOME: environment.DURE_HOME })[0];
  // As with app:dev, a hosting pane cannot redirect the product catalog. An
  // explicitly paired canonical root remains available to disposable QA.
  if (!qa && environment.HMUX_DISCOVERY_ROOT !== canonicalDiscovery) delete environment.HMUX_DISCOVERY_ROOT;

  if (action === "build") {
    execFileSync("git", ["diff", "--quiet", "HEAD"], { cwd: root });
    const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const plistPath = join(directory, "worktree-release.Info.plist");
    const launchEnvironment = Object.fromEntries([
      "HOME", "DURE_HOME", "DURE_APP_CHANNEL", "HMUX_DISCOVERY_ROOT",
      "HMUX_INSTALL_ROOT", "HMUX_INSTALL_DIR", "HEBBIAN_HMUX_BIN",
    ].filter((key) => environment[key]).map((key) => [key, environment[key]]));
    // macOS cold launch must use the same disposable roots/channel as the CLI.
    const plist = execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "-"], {
      input: JSON.stringify({ LSEnvironment: launchEnvironment }), encoding: "utf8",
    });
    writeAtomicFile(plistPath, plist);
    const config = mergeTauriConfigs(plan.config, {
      bundle: { macOS: { infoPlist: plistPath } },
    });
    const build = devTauriCliInvocation(["build", "--bundles", "app", "--config", JSON.stringify(config)]);
    execFileSync(process.execPath, [join(root, "scripts/run-with-build-storage.mjs"), "full", "--", build.command, ...build.args], {
      cwd: root, env: environment, stdio: "inherit",
    });
    const sourceBundle = join(root, "src-tauri/target/release/bundle/macos", `${plan.productName}.app`);
    const staged = stageWorktreeReleaseBundle(sourceBundle, artifactRoot, plan.productName);
    const bundledCli = realpathSync(join(staged.bundle, "Contents/Resources/resources/dure-cli/current"));
    const bundledMetadata = parseMetadata(bundledCli);
    const installEnvironment = {
      ...environment,
      DURE_CLI_INSTALL_ROOT: cliRoot,
      // Keep command links inside this app's control directory. The generic
      // installer therefore leaves the user's global launcher untouched.
      DURE_CLI_INSTALL_DIR: join(directory, "bin"),
      DURE_CLI_SOURCE_REVISION: sourceRevision,
      DURE_CONTROL_PLANE_BIN: join(bundledCli, "bin/dure-control-plane"),
      DURE_CLAUDE_PROCESS_RELAY_BIN: join(bundledCli, "bin/dure-claude-process-relay"),
      DURE_HMUX_BIN: join(bundledCli, "bin/hmux"),
      DURE_HMUX_RUNTIME_BIN: join(bundledCli, "bin/hmux-runtime"),
      DURE_HMUX_BUILD_ID: bundledMetadata.bundle.hmux.buildId,
    };
    delete installEnvironment.DURE_CLI_BUILD_ID;
    delete installEnvironment.HEBBIAN_IDE_CLI_BUILD_ID;
    execFileSync(process.execPath, [join(root, "scripts/install-dure-cli.mjs")], {
      cwd: root, env: installEnvironment, stdio: "inherit",
    });
    const cliMetadata = parseMetadata(realpathSync(join(cliRoot, "current")));
    execFileSync("git", ["diff", "--quiet", "HEAD"], { cwd: root });
    if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() !== sourceRevision ||
      bundledMetadata.bundle.app.sourceRevision !== sourceRevision ||
      cliMetadata.bundle.app.sourceRevision !== sourceRevision ||
      cliMetadata.bundle.app.channel !== plan.profile.targetChannel) {
      throw new Error("worktree release source or artifact identity changed during the build");
    }
    const receipt = {
      schemaVersion: 1, profile: plan.profile, bundleDigest: staged.bundleDigest,
      cliArtifactDigest: cliMetadata.bundle.artifactDigest,
      sourceRevision,
      worktreeOverlay: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() ? "present" : "clean",
      builtAt: new Date().toISOString(),
    };
    writeAtomicFile(receiptPath, `${JSON.stringify(receipt)}\n`);
    process.stdout.write(`Built ${plan.productName}. Start it with pnpm app:worktree:release start\n`);
    return;
  }
  const receipt = readWorktreeReleaseReceipt(receiptPath, plan.profile, {
    artifactRoot, productName: plan.productName, cliRoot,
  });
  const outcome = await superviseDevLaunch({
    home, worktreeRoot: root, channel: plan.profile.targetChannel,
    command: receipt.executable,
    spawnOptions: { cwd: root, env: environment, stdio: "inherit" },
    prepareInitialLaunch: () => prepareWorktreePresentation({ home, profile: plan.profile }),
  });
  process.exitCode = outcome.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorktreeRelease().catch((error) => {
    process.stderr.write(`worktree release: ${error.message}\n`);
    process.exitCode = 1;
  });
}
