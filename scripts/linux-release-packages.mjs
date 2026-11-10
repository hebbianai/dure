#!/usr/bin/env node

// Moves Linux packages from the Tauri bundle into a release, by exact name.
//
//   finish <bundle-root> <x86_64|aarch64>
//     After `tauri build`, complete both packages and check them:
//     - AppImage: linuxdeploy sets an rpath on every ELF file in the AppDir,
//       which breaks the static-PIE musl Hmux sidecars, SSH host runtimes and
//       checkout helper (they crash on start). Put their exact source bytes
//       back and add the staged Dure CLI payload, repack the AppDir once with
//       the same AppImage output plugin Tauri used, and check the repacked
//       image holds those bytes and that payload.
//     - Debian package: add the staged Dure CLI payload through dpkg-deb.
//     Tauri's own copies cannot carry the payload: its Debian archive writer
//     follows symbolic links (and fails on a linked directory), and linuxdeploy
//     would rewrite the payload's executables. The payload goes to the app's
//     resource directory, usr/lib/<product>/resources/dure-cli, where a stable
//     build bootstraps the Dure CLI and its backend from at startup.
//   collect <bundle-root> <x86_64|aarch64> <new-output-directory>
//     On the packaging host: take exactly the AppImage and Debian package the
//     bundler wrote for this version and architecture.
//   sign <package-directory> <new-output-directory>
//     On the signing host: sign every Linux package with the updater key from
//     the environment through the pinned Tauri CLI, check each signature
//     against this commit's updater public key and write packages plus
//     signatures. Key material only ever reaches the Tauri CLI's environment.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
// e_machine of the executables each package architecture runs.
const ELF_MACHINE = { x86_64: 62, aarch64: 183 };

// stage-dure-cli.mjs writes the payload here; the package carries it at the
// same path below the app's resource directory.
const DURE_CLI = "resources/dure-cli";
const DURE_CLI_EXECUTABLES = ["node", "dure-control-plane", "dure-claude-process-relay", "hmux", "hmux-runtime"];

const digest = (algorithm, file) => createHash(algorithm).update(fs.readFileSync(file)).digest("hex");

// Packages are installed for every user of the machine: whatever umask the
// payload was staged under, directories and executables are 0755, data 0644.
// The CLI's own artifact manifest records only the executable bit.
const packagedMode = (stat) => (stat.isDirectory() || stat.mode & 0o111 ? 0o755 : 0o644);
const actualMode = (stat) => stat.mode & 0o7777;

/** Every entry below a directory, without following links, as comparable lines. */
function treeListing(directory, mode = actualMode) {
  const listing = [];
  const walk = (prefix) => {
    for (const name of fs.readdirSync(path.join(directory, prefix)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(directory, relative);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        listing.push(`${relative} -> ${fs.readlinkSync(file)}`);
      } else if (stat.isDirectory()) {
        listing.push(`${relative}/ ${mode(stat).toString(8)}`);
        walk(relative);
      } else if (stat.isFile()) {
        listing.push(`${relative} ${mode(stat).toString(8)} ${digest("sha256", file)}`);
      } else {
        throw new Error(`unsupported file type in the Dure CLI payload: ${relative}`);
      }
    }
  };
  walk("");
  return listing;
}

/** Copy a tree with its links verbatim and the packaged modes. */
function copyPackaged(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), target);
  } else if (stat.isDirectory()) {
    fs.mkdirSync(target);
    for (const name of fs.readdirSync(source)) copyPackaged(path.join(source, name), path.join(target, name));
    fs.chmodSync(target, packagedMode(stat));
  } else if (stat.isFile()) {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, packagedMode(stat));
  } else {
    throw new Error(`unsupported file type in the Dure CLI payload: ${source}`);
  }
}

const sameListing = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** The Dure CLI payload staged for this architecture, with its listing. */
export function stagedDureCli(root, arch) {
  const payload = path.join(root, "src-tauri", DURE_CLI);
  const current = path.join(payload, "current");
  if (!fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`the Dure CLI payload is not staged at ${payload} (scripts/stage-dure-cli.mjs)`);
  }
  const version = fs.realpathSync(current);
  if (path.dirname(version) !== path.join(fs.realpathSync(payload), "versions")) {
    throw new Error("the staged Dure CLI payload selects a version outside itself");
  }
  for (const name of DURE_CLI_EXECUTABLES) {
    const bytes = fs.readFileSync(path.join(version, "bin", name));
    if (!isElf(bytes) || bytes.readUInt16LE(18) !== ELF_MACHINE[arch]) {
      throw new Error(`the staged Dure CLI ${name} is not an ${arch} executable`);
    }
  }
  return { payload, buildId: path.basename(version), listing: treeListing(payload, packagedMode) };
}

/** Copy the payload to `target` once; an existing copy must be the same payload. */
function placeDureCli(cli, target) {
  const added = !fs.lstatSync(target, { throwIfNoEntry: false });
  if (added) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    copyPackaged(cli.payload, target);
  }
  if (!sameListing(treeListing(target), cli.listing)) {
    throw new Error(`${target} holds a different Dure CLI payload`);
  }
  return added;
}

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

function assertArchitecture(arch) {
  if (!LINUX_UPDATER_PACKAGES.some((entry) => entry.arch === arch)) {
    throw new Error(`unknown Linux release architecture: ${arch}`);
  }
}

export function finishAppImage({
  root = process.cwd(),
  bundleRoot,
  arch,
  cli,
  repack = repackAppImage,
  extract = extractAppImage,
}) {
  assertArchitecture(arch);
  cli ??= stagedDureCli(root, arch);
  const directory = path.join(bundleRoot, "appimage");
  const appDirs = fs.readdirSync(directory).filter((name) => name.endsWith(".AppDir"));
  const images = fs.readdirSync(directory).filter((name) => name.endsWith(".AppImage"));
  if (appDirs.length !== 1 || images.length !== 1) {
    throw new Error(`expected one AppDir and one AppImage in ${directory}`);
  }
  const appDir = path.join(directory, appDirs[0]);
  const product = appDirs[0].slice(0, -".AppDir".length);
  const cliTarget = path.join(appDir, "usr/lib", product, DURE_CLI);
  // The payload goes in before the executables are listed, so its own
  // executables are checked in the repacked image like every other one.
  const addedCli = placeDureCli(cli, cliTarget);
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
  const restored = changed.map(([, target]) => path.relative(appDir, target)).sort();
  if (restored.length === 0 && !addedCli) return { restored, addedDureCli: false };
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
    const extractedCli = path.join(extracted, path.relative(appDir, cliTarget));
    if (!fs.existsSync(extractedCli) || !sameListing(treeListing(extractedCli), cli.listing)) {
      throw new Error("the repacked AppImage does not hold the staged Dure CLI payload");
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  fs.renameSync(repacked, image);
  return { restored, addedDureCli: addedCli };
}

function dpkgDeb(args) {
  execFileSync("dpkg-deb", args, { stdio: ["ignore", "ignore", "inherit"] });
}

/**
 * Add the staged Dure CLI payload to this version's Debian package: unpack it
 * with its control files, add the payload with its links and modes, extend
 * md5sums and Installed-Size, rebuild it with root ownership as Tauri's archive
 * has, and check the rebuilt package unpacks to that payload.
 */
export function finishDeb({ root = process.cwd(), bundleRoot, arch, cli, dpkg = dpkgDeb }) {
  assertArchitecture(arch);
  cli ??= stagedDureCli(root, arch);
  const { productName, version } = readConfig(root);
  const entry = packagesFor(version, arch).find((candidate) => candidate.format === "deb");
  const deb = path.join(bundleRoot, BUNDLE_DIRECTORIES.deb, entry.name);
  if (!fs.lstatSync(deb, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`expected the Debian package ${deb}`);
  }
  const relativeCli = path.posix.join("usr/lib", productName, DURE_CLI);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dure-deb-finish-"));
  try {
    const tree = path.join(scratch, "package");
    dpkg(["--raw-extract", deb, tree]);
    if (!fs.existsSync(path.join(tree, "usr/lib", productName, "resources"))) {
      throw new Error(`the Debian package has no resource directory usr/lib/${productName}/resources`);
    }
    if (!placeDureCli(cli, path.join(tree, relativeCli))) return false;
    let bytes = 0;
    const sums = [];
    for (const line of cli.listing) {
      const [relative, mode] = line.split(" ");
      if (relative.endsWith("/") || mode === "->") continue;
      const file = path.join(tree, relativeCli, relative);
      bytes += fs.statSync(file).size;
      sums.push(`${digest("md5", file)}  ${relativeCli}/${relative}\n`);
    }
    fs.appendFileSync(path.join(tree, "DEBIAN/md5sums"), sums.join(""));
    const controlFile = path.join(tree, "DEBIAN/control");
    const control = fs.readFileSync(controlFile, "utf8");
    const installedSize = control.match(/^Installed-Size: (\d+)$/m);
    if (!installedSize) throw new Error("the Debian package control file has no Installed-Size");
    fs.writeFileSync(controlFile, control.replace(
      installedSize[0],
      `Installed-Size: ${Number(installedSize[1]) + Math.ceil(bytes / 1024)}`,
    ));
    const rebuilt = path.join(scratch, entry.name);
    dpkg(["--root-owner-group", "-Zgzip", "--build", tree, rebuilt]);
    const check = path.join(scratch, "check");
    dpkg(["--extract", rebuilt, check]);
    if (!sameListing(treeListing(path.join(check, relativeCli)), cli.listing)) {
      throw new Error("the rebuilt Debian package does not hold the staged Dure CLI payload");
    }
    fs.copyFileSync(rebuilt, deb);
    return true;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Complete this architecture's AppImage and Debian package after `tauri build`. */
export function finishLinuxPackages({ root = process.cwd(), bundleRoot, arch }) {
  assertArchitecture(arch);
  const cli = stagedDureCli(root, arch);
  const appImage = finishAppImage({ root, bundleRoot, arch, cli });
  const deb = finishDeb({ root, bundleRoot, arch, cli });
  return { ...appImage, buildId: cli.buildId, addedDureCliToDeb: deb };
}

export function collectLinuxPackages({ root = process.cwd(), bundleRoot, arch, output }) {
  assertArchitecture(arch);
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
    if (command === "finish" && rest.length === 2) {
      const [bundleRoot, arch] = rest;
      const result = finishLinuxPackages({ bundleRoot: path.resolve(bundleRoot), arch });
      console.log(result.restored.length
        ? `Restored ${result.restored.length} executables in the AppImage: ${result.restored.join(", ")}`
        : "The AppImage already held every bundled executable unchanged");
      console.log(`Dure CLI ${result.buildId}: ${result.addedDureCli ? "added to" : "already in"} the AppImage, ${result.addedDureCliToDeb ? "added to" : "already in"} the Debian package`);
    } else if (command === "collect" && rest.length === 3) {
      const [bundleRoot, arch, output] = rest;
      console.log(collectLinuxPackages({ bundleRoot: path.resolve(bundleRoot), arch, output: path.resolve(output) }));
    } else if (command === "sign" && rest.length === 2) {
      const [input, output] = rest;
      console.log(signLinuxPackages({ input: path.resolve(input), output: path.resolve(output) }));
    } else {
      throw new Error(
        "usage: linux-release-packages.mjs finish <bundle-root> <x86_64|aarch64> | collect <bundle-root> <x86_64|aarch64> <output> | sign <packages> <output>",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
