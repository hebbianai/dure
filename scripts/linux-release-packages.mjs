#!/usr/bin/env node

// Moves Linux packages from the Tauri bundle into a release, by exact name.
//
//   collect <bundle-root> <x86_64|aarch64> <new-output-directory>
//     On the packaging host: take exactly the AppImage and Debian package the
//     bundler wrote for this version and architecture.
//   sign <package-directory> <new-output-directory>
//     On the signing host: sign every Linux package with the updater key from
//     the environment through the pinned Tauri CLI, check each signature
//     against this commit's updater public key and write packages plus
//     signatures. Key material only ever reaches the Tauri CLI's environment.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LINUX_UPDATER_PACKAGES } from "./lib/beta-release-metadata.mjs";
import { linuxReleaseAssetNames, verifyUpdaterSignature } from "./lib/public-release-contract.mjs";

const BUNDLE_DIRECTORIES = { appimage: "appimage", deb: "deb" };

function readConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
}

const packagesFor = (version, arch) =>
  LINUX_UPDATER_PACKAGES.filter((entry) => !arch || entry.arch === arch)
    .map((entry) => ({ ...entry, name: entry.file(version), format: entry.platform.split("-").at(-1) }));

export function collectLinuxPackages({ root = process.cwd(), bundleRoot, arch, output }) {
  if (!LINUX_UPDATER_PACKAGES.some((entry) => entry.arch === arch)) {
    throw new Error(`unknown Linux release architecture: ${arch}`);
  }
  const { version } = readConfig(root);
  fs.mkdirSync(output);
  for (const entry of packagesFor(version, arch)) {
    const directory = path.join(bundleRoot, BUNDLE_DIRECTORIES[entry.format]);
    const found = fs.readdirSync(directory).filter((name) =>
      name.endsWith(entry.format === "deb" ? ".deb" : ".AppImage"));
    if (found.length !== 1 || found[0] !== entry.name) {
      throw new Error(`expected exactly ${entry.name} in ${directory}, found ${found.join(", ") || "nothing"}`);
    }
    const source = path.join(directory, entry.name);
    if (!fs.lstatSync(source).isFile() || fs.statSync(source).size === 0) {
      throw new Error(`Linux package is not a regular nonempty file: ${source}`);
    }
    fs.copyFileSync(source, path.join(output, entry.name), fs.constants.COPYFILE_EXCL);
  }
  return output;
}

function tauriSign(root, file) {
  // The Tauri CLI reads TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) from the
  // environment and writes `<file>.sig`; nothing here prints or stores it.
  execFileSync("corepack", ["pnpm", "exec", "tauri", "signer", "sign", file], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

export function signLinuxPackages({ root = process.cwd(), input, output, sign = tauriSign }) {
  const config = readConfig(root);
  const tag = `v${config.version}`;
  const packages = packagesFor(config.version);
  const present = fs.readdirSync(input).sort();
  const expected = packages.map((entry) => entry.name).sort();
  if (JSON.stringify(present) !== JSON.stringify(expected)) {
    throw new Error(`Linux packages to sign must be exactly ${expected.join(", ")}`);
  }
  fs.mkdirSync(output);
  for (const entry of packages) {
    const file = path.join(output, entry.name);
    fs.copyFileSync(path.join(input, entry.name), file, fs.constants.COPYFILE_EXCL);
    sign(root, file);
    const signature = fs.readFileSync(`${file}.sig`, "utf8").trim();
    verifyUpdaterSignature(file, config.plugins.updater.pubkey, signature);
  }
  const written = fs.readdirSync(output).sort();
  if (JSON.stringify(written) !== JSON.stringify(linuxReleaseAssetNames(tag))) {
    throw new Error("signed Linux packages differ from the release asset set");
  }
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    if (command === "collect" && rest.length === 3) {
      const [bundleRoot, arch, output] = rest;
      console.log(collectLinuxPackages({ bundleRoot: path.resolve(bundleRoot), arch, output: path.resolve(output) }));
    } else if (command === "sign" && rest.length === 2) {
      const [input, output] = rest;
      console.log(signLinuxPackages({ input: path.resolve(input), output: path.resolve(output) }));
    } else {
      throw new Error(
        "usage: linux-release-packages.mjs collect <bundle-root> <x86_64|aarch64> <output> | sign <packages> <output>",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
