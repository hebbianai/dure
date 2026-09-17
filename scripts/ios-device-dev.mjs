#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyIosPushApplication } from "./ios-push-signing.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const applications = path.join(
  repositoryRoot,
  "mobile/src-tauri/gen/apple/build/dure-mobile_iOS.xcarchive/Products/Applications",
);
const bundleId = "dev.hebbian.ide.mobile";

/**
 * The one `.app` the archive holds. The bundle is named after
 * `productName` in `mobile/src-tauri/tauri.conf.json`, which has already
 * changed once (HebbianIDE Mobile → Dure) while a hard-coded name here kept
 * failing after a finished build; the archive only ever contains one.
 */
export function builtApplication(directory, entries = fs.readdirSync(directory)) {
  const bundles = entries.filter((entry) => entry.endsWith(".app"));
  if (bundles.length !== 1) {
    throw new Error(
      `expected one built iOS application under ${directory}, found ${bundles.length}: ${bundles.join(", ") || "none"}`,
    );
  }
  return path.join(directory, bundles[0]);
}

export function selectPhysicalDevice(devices, selector) {
  const available = devices.filter(
    (device) =>
      device.available === true &&
      device.simulator === false &&
      device.platform === "com.apple.platform.iphoneos",
  );
  const matches = selector
    ? available.filter(
        (device) => device.identifier === selector || device.name === selector,
      )
    : available;
  if (matches.length !== 1) {
    const found = available
      .map((device) => `${device.name} (${device.identifier})`)
      .join(", ");
    throw new Error(
      selector
        ? `available physical iPhone not found: ${selector}`
        : `expected one available physical iPhone, found ${matches.length}: ${found || "none"}`,
    );
  }
  return matches[0];
}

export function scrubTauriEnvironment(environment) {
  const clean = { ...environment };
  for (const key of [
    "TAURI_CONFIG",
    "TAURI_ENV_TARGET_TRIPLE",
    "TAURI_ANDROID_PACKAGE_NAME_APP_NAME",
    "TAURI_ANDROID_PACKAGE_NAME_PREFIX",
    "TAURI_UPDATER_PLUGIN_CONFIG",
    "TAURI_CLI_VERBOSITY",
  ]) {
    delete clean[key];
  }
  return clean;
}

export function runIosDeviceDev(selector = process.argv[2]) {
  const environment = scrubTauriEnvironment(process.env);
  const devices = JSON.parse(
    execFileSync("xcrun", ["xcdevice", "list", "--timeout", "2"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const device = selectPhysicalDevice(devices, selector);

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
      "--debug",
      "--archive-only",
    ],
    { cwd: repositoryRoot, env: environment, stdio: "inherit" },
  );
  if (!fs.existsSync(applications)) {
    throw new Error(`built iOS archive not found: ${applications}`);
  }
  const application = builtApplication(applications);
  verifyIosPushApplication(application);
  execFileSync(
    "xcrun",
    ["devicectl", "device", "install", "app", "--device", device.identifier, application],
    { stdio: "inherit" },
  );
  execFileSync(
    "xcrun",
    [
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      device.identifier,
      "--terminate-existing",
      bundleId,
    ],
    { stdio: "inherit" },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIosDeviceDev();
}
