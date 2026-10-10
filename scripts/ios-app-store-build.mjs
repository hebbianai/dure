#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scrubTauriEnvironment } from "./ios-device-dev.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Archive a release build and export the App Store Connect IPA. A shell
 * inside the Dure desktop app inherits its Tauri variables, which would
 * otherwise retarget or reconfigure the iOS build, exactly as for device dev.
 */
export function runIosAppStoreBuild(extraArguments = process.argv.slice(2)) {
  execFileSync(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts/run-with-build-storage.mjs"),
      "mobile",
      "--",
      "corepack",
      "pnpm",
      "--dir",
      "mobile",
      "tauri",
      "ios",
      "build",
      "--export-method",
      "app-store-connect",
      ...extraArguments,
    ],
    { cwd: repositoryRoot, env: scrubTauriEnvironment(process.env), stdio: "inherit" },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIosAppStoreBuild();
}
