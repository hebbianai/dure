#!/usr/bin/env node

// Moves Linux packages from the Tauri bundle into a release, by exact name.
//
//   repair-appimage <bundle-root> <x86_64|aarch64>
//     After `tauri build`: linuxdeploy sets an rpath on every ELF file in the
//     AppDir, which breaks the static-PIE musl Hmux sidecars, SSH host runtimes
//     and checkout helper (they crash on start). Put their exact source bytes
//     back, repack the AppDir with the same AppImage output plugin Tauri used,
//     and check the repacked image holds those bytes.
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
import os from "node:os";
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

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const isElf = (bytes) => bytes.subarray(0, 4).equals(ELF_MAGIC);

function filesBelow(directory, prefix = "") {
  if (!fs.existsSync(path.join(directory, prefix))) return [];
  return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return filesBelow(directory, relative);
    return entry.isFile() ? [relative] : [];
  });
}

/** Every executable the bundle copies from the checkout, as [source, AppDir path]. */
function bundledExecutables(root, appDir, product, arch) {
  const suffix = `-${arch}-unknown-linux-gnu`;
  const binaries = path.join(root, "src-tauri/binaries");
  const resources = path.join(root, "src-tauri/resources");
  return [
    // externalBin: binaries/<name>-<target> is installed as usr/bin/<name>.
    ...filesBelow(binaries).filter((name) => name.endsWith(suffix)).map((name) => [
      path.join(binaries, name),
      path.join(appDir, "usr/bin", name.slice(0, -suffix.length)),
    ]),
    // Resources keep their relative path below usr/lib/<product>/resources.
    ...filesBelow(resources).map((relative) => [
      path.join(resources, relative),
      path.join(appDir, "usr/lib", product, "resources", relative),
    ]),
  ].filter(([source, target]) => fs.existsSync(target) && isElf(fs.readFileSync(source)));
}

function appImagePlugin() {
  // tauri-bundler keeps its downloaded AppImage tools in <cache>/tauri.
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cache, "tauri", "linuxdeploy-plugin-appimage.AppImage");
}

function repackAppImage(appDir, output, arch) {
  const plugin = appImagePlugin();
  if (!fs.existsSync(plugin)) throw new Error(`the AppImage output plugin Tauri downloaded is missing: ${plugin}`);
  execFileSync(plugin, ["--appdir", appDir], {
    cwd: path.dirname(output),
    env: { ...process.env, OUTPUT: output, ARCH: arch, APPIMAGE_EXTRACT_AND_RUN: "1" },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function extractAppImage(image, directory) {
  execFileSync(image, ["--appimage-extract"], { cwd: directory, stdio: "ignore" });
  return path.join(directory, "squashfs-root");
}

export function repairAppImage({
  root = process.cwd(),
  bundleRoot,
  arch,
  repack = repackAppImage,
  extract = extractAppImage,
}) {
  if (!LINUX_UPDATER_PACKAGES.some((entry) => entry.arch === arch)) {
    throw new Error(`unknown Linux release architecture: ${arch}`);
  }
  const directory = path.join(bundleRoot, "appimage");
  const appDirs = fs.readdirSync(directory).filter((name) => name.endsWith(".AppDir"));
  const images = fs.readdirSync(directory).filter((name) => name.endsWith(".AppImage"));
  if (appDirs.length !== 1 || images.length !== 1) {
    throw new Error(`expected one AppDir and one AppImage in ${directory}`);
  }
  const appDir = path.join(directory, appDirs[0]);
  const product = appDirs[0].slice(0, -".AppDir".length);
  const executables = bundledExecutables(root, appDir, product, arch);
  if (!executables.some(([, target]) => target === path.join(appDir, "usr/bin/hmux-runtime"))) {
    throw new Error("the AppDir has no bundled hmux-runtime to check");
  }
  const changed = executables.filter(([source, target]) =>
    !fs.readFileSync(source).equals(fs.readFileSync(target)));
  for (const [source, target] of changed) {
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o755);
  }
  if (changed.length === 0) return [];
  const image = path.join(directory, images[0]);
  const repacked = path.join(directory, `.${images[0]}.repacked`);
  fs.rmSync(repacked, { force: true });
  repack(appDir, repacked, arch);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dure-appimage-check-"));
  try {
    fs.chmodSync(repacked, 0o755);
    const extracted = extract(repacked, scratch);
    for (const [source, target] of executables) {
      const inside = path.join(extracted, path.relative(appDir, target));
      if (!fs.existsSync(inside) || !fs.readFileSync(source).equals(fs.readFileSync(inside))) {
        throw new Error(`the repacked AppImage changed ${path.relative(appDir, target)}`);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  fs.renameSync(repacked, image);
  return changed.map(([, target]) => path.relative(appDir, target)).sort();
}

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
    if (command === "repair-appimage" && rest.length === 2) {
      const [bundleRoot, arch] = rest;
      const restored = repairAppImage({ bundleRoot: path.resolve(bundleRoot), arch });
      console.log(restored.length
        ? `Restored ${restored.length} executables in the AppImage: ${restored.join(", ")}`
        : "The AppImage already holds every bundled executable unchanged");
    } else if (command === "collect" && rest.length === 3) {
      const [bundleRoot, arch, output] = rest;
      console.log(collectLinuxPackages({ bundleRoot: path.resolve(bundleRoot), arch, output: path.resolve(output) }));
    } else if (command === "sign" && rest.length === 2) {
      const [input, output] = rest;
      console.log(signLinuxPackages({ input: path.resolve(input), output: path.resolve(output) }));
    } else {
      throw new Error(
        "usage: linux-release-packages.mjs repair-appimage <bundle-root> <x86_64|aarch64> | collect <bundle-root> <x86_64|aarch64> <output> | sign <packages> <output>",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
