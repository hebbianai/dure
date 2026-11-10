#!/usr/bin/env node

// Linux desktop packages carry the Hmux sidecars, the Linux SSH host runtimes
// and the remote Git checkout helper. Each of them links C code compiled with
// the pinned Ghostty VT toolchain, and that Zig toolchain is a macOS ARM64
// executable, so a Linux host cannot build them itself today.
//
// `supply` runs on the macOS ARM64 host and builds all of them for both Linux
// architectures into one directory with a receipt. `stage` runs on the Linux
// packaging host at the same clean commit: it checks every digest and places
// the files where `tauri build` reads them. The sidecars are static musl
// binaries (the only Linux targets the Ghostty proof admits); they are staged
// under the GNU desktop target name that Tauri bundles for the host.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import {
  stageCheckoutHelperArtifact,
  supplyCheckoutHelperArtifact,
} from "./remote-git-checkout-helper-artifact.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LINUX_ARCHITECTURES = ["x86_64", "aarch64"];
const SIDECARS = ["hmux-runtime", "hmux"];
const RECEIPT = "receipt.json";
const HELPER = "remote-git-checkout-helper";
const muslTarget = (arch) => `${arch}-unknown-linux-musl`;
const gnuTarget = (arch) => `${arch}-unknown-linux-gnu`;
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function cleanCommit(root) {
  const git = (...args) => execFileSync("git", args, {
    cwd: root, env: withoutLocalGitOverrides(), encoding: "utf8",
  }).trim();
  if (git("status", "--porcelain", "--untracked-files=normal")) {
    throw new Error("Linux desktop supply requires a clean source checkout");
  }
  return git("rev-parse", "HEAD");
}

/** Regular files below `directory`, relative and sorted; links are refused. */
function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(directory, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Linux desktop supply holds a non-regular file: ${relative}`);
  }
  return files.sort();
}

function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const file of listFiles(source)) {
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, file), target);
    fs.chmodSync(target, fs.statSync(path.join(source, file)).mode & 0o777);
  }
}

function replaceDirectory(source, destination) {
  const stage = `${destination}.stage-${process.pid}`;
  fs.rmSync(stage, { recursive: true, force: true });
  copyTree(source, stage);
  // Executables lose their mode across artifact transfers; restore it here.
  for (const file of listFiles(stage)) {
    fs.chmodSync(path.join(stage, file), file.startsWith("bin/") ? 0o755 : 0o644);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(stage, destination);
}

function verifyStaticBinary(root, target, binary) {
  run("sh", [path.join(root, "scripts/verify-static-linux-binary.sh"), target, binary], { cwd: root });
}

function verifyProductRuntime(root, binary) {
  run("sh", [path.join(root, "scripts/verify-hmux-product-runtime.sh"), "execute", binary], { cwd: root });
}

export function supplyLinuxDesktop({
  root = repositoryRoot,
  output,
  platform = process.platform,
  arch = process.arch,
  environment = process.env,
  execute = run,
  supplyHelper = supplyCheckoutHelperArtifact,
  verifyStatic = verifyStaticBinary,
} = {}) {
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error("Linux desktop supply builds on the macOS ARM64 host that owns the Ghostty toolchain");
  }
  const sourceCommit = cleanCommit(root);
  fs.mkdirSync(output);
  for (const linux of LINUX_ARCHITECTURES) {
    const target = muslTarget(linux);
    const directory = path.join(output, "sidecars", target);
    fs.mkdirSync(directory, { recursive: true });
    execute("sh", ["scripts/stage-hmux-runtime.sh", "release"], {
      cwd: root,
      env: {
        ...environment,
        CARGO_BUILD_TARGET: target,
        HMUX_SKIP_TAURI_STAGE: "1",
        HMUX_STAGE_ARTIFACT_DIR: directory,
      },
    });
  }
  const targets = LINUX_ARCHITECTURES.map(muslTarget);
  execute("sh", ["scripts/stage-hmux-remote-resources.sh", "release"], {
    cwd: root,
    env: { ...environment, HMUX_REMOTE_TRIPLES: targets.join(" ") },
  });
  for (const target of targets) {
    copyTree(
      path.join(root, "src-tauri/resources/hmux-remote", target),
      path.join(output, "hmux-remote", target),
    );
  }
  const helper = supplyHelper(root);
  for (const entry of [...targets, "artifact"]) {
    copyTree(path.join(helper, entry), path.join(output, HELPER, entry));
  }
  for (const target of targets) {
    for (const name of SIDECARS) {
      verifyStatic(root, target, path.join(output, "sidecars", target, name));
      verifyStatic(root, target, path.join(output, "hmux-remote", target, "bin", name));
    }
    verifyStatic(root, target, path.join(output, HELPER, target, "dure-git-checkout-helper"));
  }
  if (cleanCommit(root) !== sourceCommit) {
    throw new Error("Linux desktop supply source changed during the build");
  }
  const files = Object.fromEntries(
    listFiles(output).map((file) => [file, digest(path.join(output, file))]),
  );
  fs.writeFileSync(
    path.join(output, RECEIPT),
    `${JSON.stringify({ schemaVersion: 1, sourceCommit, files }, null, 2)}\n`,
  );
  return output;
}

/** Check the receipt and the exact file inventory before anything is staged. */
export function readLinuxDesktopSupply(root, supply) {
  const receipt = JSON.parse(fs.readFileSync(path.join(supply, RECEIPT), "utf8"));
  if (receipt?.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(receipt.sourceCommit ?? "")) {
    throw new Error("Linux desktop supply receipt is invalid");
  }
  if (receipt.sourceCommit !== cleanCommit(root)) {
    throw new Error("Linux desktop supply was built from another commit");
  }
  const present = listFiles(supply).filter((file) => file !== RECEIPT);
  const listed = Object.keys(receipt.files ?? {}).sort();
  if (JSON.stringify(present) !== JSON.stringify(listed)) {
    throw new Error("Linux desktop supply files differ from its receipt");
  }
  for (const file of listed) {
    if (digest(path.join(supply, file)) !== receipt.files[file]) {
      throw new Error(`Linux desktop supply digest changed: ${file}`);
    }
  }
  for (const linux of LINUX_ARCHITECTURES) {
    for (const name of SIDECARS) {
      for (const file of [`sidecars/${muslTarget(linux)}/${name}`, `hmux-remote/${muslTarget(linux)}/bin/${name}`]) {
        if (!listed.includes(file)) throw new Error(`Linux desktop supply is missing ${file}`);
      }
    }
  }
  return receipt;
}

export function stageLinuxDesktop({
  root = repositoryRoot,
  supply,
  platform = process.platform,
  arch = process.arch,
  stageHelper = stageCheckoutHelperArtifact,
  verifyStatic = verifyStaticBinary,
  verifyRuntime = verifyProductRuntime,
} = {}) {
  const linux = { x64: "x86_64", arm64: "aarch64" }[arch];
  if (platform !== "linux" || !linux) {
    throw new Error(`Linux desktop staging runs on Linux x86_64 or arm64, not ${platform} ${arch}`);
  }
  readLinuxDesktopSupply(root, supply);
  const binaries = path.join(root, "src-tauri/binaries");
  fs.mkdirSync(binaries, { recursive: true });
  for (const name of SIDECARS) {
    const source = path.join(supply, "sidecars", muslTarget(linux), name);
    const destination = path.join(binaries, `${name}-${gnuTarget(linux)}`);
    const temporary = path.join(binaries, `.${name}-${gnuTarget(linux)}.${process.pid}`);
    fs.copyFileSync(source, temporary);
    fs.chmodSync(temporary, 0o755);
    verifyStatic(root, muslTarget(linux), temporary);
    fs.renameSync(temporary, destination);
  }
  verifyRuntime(root, path.join(binaries, `hmux-runtime-${gnuTarget(linux)}`));
  for (const target of LINUX_ARCHITECTURES.map(muslTarget)) {
    replaceDirectory(
      path.join(supply, "hmux-remote", target),
      path.join(root, "src-tauri/resources/hmux-remote", target),
    );
  }
  stageHelper(root, path.join(supply, HELPER));
  return gnuTarget(linux);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [command, directory, ...extra] = process.argv.slice(2);
    if (!directory || extra.length > 0 || !["supply", "stage"].includes(command)) {
      throw new Error(
        "usage: linux-desktop-supply.mjs supply <new-output-directory> (macOS ARM64) | stage <supply-directory> (Linux)",
      );
    }
    if (command === "supply") {
      console.log(supplyLinuxDesktop({ output: path.resolve(directory) }));
    } else {
      console.log(`Staged Linux desktop supply for ${stageLinuxDesktop({ supply: path.resolve(directory) })}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
