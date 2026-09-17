#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { devTauriCliInvocation } from "./lib/dev-tauri-cli.mjs";
import { runBuildStorageCli } from "./run-with-build-storage.mjs";

export async function buildLocalApp(arguments_, {
  platform = process.platform,
  architecture = process.arch,
  execute = runBuildStorageCli,
  log = console.log,
} = {}) {
  if (arguments_.length === 1 && ["--help", "-h"].includes(arguments_[0])) {
    log("Usage: pnpm build:app\nBuild an unsigned Apple Silicon macOS app from committed source.\nOutput: src-tauri/target/release/bundle/macos/Dure.app");
    return 0;
  }
  if (arguments_.length !== 0) throw new Error("usage: pnpm build:app [--help]");
  if (platform !== "darwin" || architecture !== "arm64") {
    throw new Error("build:app currently supports Apple Silicon macOS");
  }
  const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  if (realpathSync(process.cwd()) !== root) {
    throw new Error("run build:app from its own repository root");
  }
  const build = devTauriCliInvocation([
    "build", "--ci", "--no-sign", "--bundles", "app",
    "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
    "--runner", fileURLToPath(new URL("./native/cargo-build.sh", import.meta.url)),
    "--", "--locked",
  ]);
  // The outer admission covers staging and packaging. Only the Cargo leaf
  // takes the compiler slot; staging already admits its own finite builds.
  return execute(["full", "--", build.command, ...build.args]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildLocalApp(process.argv.slice(2)).then(
    (status) => { process.exitCode = status; },
    (error) => { console.error(`Local app build failed: ${error.message}`); process.exitCode = 1; },
  );
}
