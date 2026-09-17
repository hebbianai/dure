#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeBuildCommand } from "./lib/native-build-slot.mjs";

const RECEIPT_NAME = "hmux-ghostty-vt-proof.receipt";
const RELEASE_REPOSITORY = "hebbianai/dure";
const RELEASE_TAG = "hmux-ghostty-vt-provenance-v2";
const RELEASE_ASSET = "hmux-ghostty-vt-provenance-v2.tar.gz";
const RELEASE_ASSET_SHA256 =
  "fa80acde4d3013f10756768761fc51e51b54a32d194d63807a8ea0ea7be39316";
const THIRD_PARTY_NOTICES = "THIRD_PARTY_NOTICES.txt";
const THIRD_PARTY_NOTICES_SHA256 =
  "70fcdd56db55e209850350300d9632c472d2086c458899d5cb69e35909cf8f76";
const GHOSTTY_SOURCE = "ghostty-source.tar.gz";
const GHOSTTY_SOURCE_SHA256 =
  "60ed33a2bd972394cc55db5b90e948442c3fb3a8f6b46b52e89f176e9ff20ed7";
const ZIG_ARCHIVE = "zig.tar.xz";
const ZIG_ARCHIVE_SHA256 =
  "b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489";
const ZIG_EXECUTABLE_SHA256 =
  "e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec";
const RUST_SUPPLY_TOOLCHAIN = "1.85.0";
const RUST_OBJCOPY_SHA256 =
  "17e49737796f7f4c90a2884d6fb1f35c680f5025ce1f589a546a326713f1eebb";
const WINDOWS_RECEIPT_SCHEMA = "hmux-ghostty-vt-artifact-v5";
const WINDOWS_ZIG_TARGET = "x86_64-windows-gnu";
const WINDOWS_ARCHIVE_NORMALIZER =
  "rust-1.85-llvm-19-objcopy-strip-debug-remove-addrsig-zig-ar-crsD-ranlib-D-lld-v3";
const UUCODE_ARCHIVE =
  "uucode-0.2.0-ZZjBPlK5VADj7fdoq7G8LIHzD5o6FSkcBXXrRWr4jnrA.tar.gz";
const UUCODE_ARCHIVE_SHA256 =
  "3c571e2e2c1dd6d67d59e7a29322c718a90465ccb0df362e14feafcdde555ed0";
const HIGHWAY_ARCHIVE =
  "N-V-__8AAGmZhABbsPJLfbqrh6JTHsXhY6qCaLAQyx25e0XE.tar.gz";
const HIGHWAY_ARCHIVE_SHA256 =
  "cf0f68a4275e59282383f46289da017166ea4cbbced04ad2af1b79f3eede3cc2";
const SUPPORTED_TARGETS = new Set([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-musl",
  "x86_64-unknown-linux-musl",
  "x86_64-pc-windows-msvc",
]);
const REPOSITORY_ROOT = fs.realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function isHashedFile(file, expected) {
  return fs.existsSync(file) && sha256File(file) === expected;
}

function defaultCacheRoot(environment, platform) {
  if (environment.DURE_GHOSTTY_VT_CACHE_ROOT) {
    if (!path.isAbsolute(environment.DURE_GHOSTTY_VT_CACHE_ROOT)) {
      throw new Error("DURE_GHOSTTY_VT_CACHE_ROOT must be absolute");
    }
    return path.normalize(environment.DURE_GHOSTTY_VT_CACHE_ROOT);
  }
  if (!environment.HOME) {
    throw new Error("automatic Ghostty VT preparation requires HOME");
  }
  if (platform === "darwin") {
    return path.join(environment.HOME, "Library/Caches/Dure/ghostty-vt");
  }
  return path.join(
    environment.XDG_CACHE_HOME ?? path.join(environment.HOME, ".cache"),
    "Dure/ghostty-vt",
  );
}

function receiptMatches(directory, target) {
  const receipt = path.join(directory, RECEIPT_NAME);
  if (!fs.existsSync(receipt)) return false;
  const fields = new Map(
    fs
      .readFileSync(receipt, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator === -1
          ? [line, ""]
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  if (fields.get("target") !== target) return false;
  if (target !== "x86_64-pc-windows-msvc") return true;
  return (
    fields.get("schema") === WINDOWS_RECEIPT_SCHEMA &&
    fields.get("zig_target") === WINDOWS_ZIG_TARGET &&
    fields.get("archive_normalizer") === WINDOWS_ARCHIVE_NORMALIZER &&
    fields.get("rust_objcopy_sha256") === RUST_OBJCOPY_SHA256
  );
}

function cachedArtifact(cacheRoot, target) {
  const pointer = path.join(cacheRoot, "targets", `${target}.txt`);
  if (fs.existsSync(pointer)) {
    const candidate = fs.readFileSync(pointer, "utf8").trim();
    if (path.isAbsolute(candidate) && receiptMatches(candidate, target)) {
      return candidate;
    }
  }

  if (fs.existsSync(cacheRoot)) {
    for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const candidate = path.join(cacheRoot, entry.name);
        if (receiptMatches(candidate, target)) return candidate;
      }
    }
  }

  const artifacts = path.join(cacheRoot, "artifacts");
  if (!fs.existsSync(artifacts)) return undefined;
  for (const recipe of fs.readdirSync(artifacts, { withFileTypes: true })) {
    if (!recipe.isDirectory()) continue;
    const targetRoot = path.join(artifacts, recipe.name, target);
    if (!fs.existsSync(targetRoot)) continue;
    for (const artifact of fs.readdirSync(targetRoot, {
      withFileTypes: true,
    })) {
      if (!artifact.isDirectory()) continue;
      const candidate = path.join(targetRoot, artifact.name);
      if (receiptMatches(candidate, target)) return candidate;
    }
  }
  return undefined;
}

function inputPaths(inputsRoot) {
  return {
    ghosttySource: path.join(inputsRoot, GHOSTTY_SOURCE),
    highwayArchive: path.join(inputsRoot, HIGHWAY_ARCHIVE),
    thirdPartyNotices: path.join(inputsRoot, THIRD_PARTY_NOTICES),
    uucodeArchive: path.join(inputsRoot, UUCODE_ARCHIVE),
    zig: path.join(inputsRoot, "zig-toolchain/zig"),
    zigArchive: path.join(inputsRoot, ZIG_ARCHIVE),
  };
}

function inputsAreValid(inputs) {
  return (
    isHashedFile(inputs.ghosttySource, GHOSTTY_SOURCE_SHA256) &&
    isHashedFile(inputs.zigArchive, ZIG_ARCHIVE_SHA256) &&
    isHashedFile(inputs.zig, ZIG_EXECUTABLE_SHA256) &&
    isHashedFile(inputs.uucodeArchive, UUCODE_ARCHIVE_SHA256) &&
    isHashedFile(inputs.highwayArchive, HIGHWAY_ARCHIVE_SHA256) &&
    isHashedFile(inputs.thirdPartyNotices, THIRD_PARTY_NOTICES_SHA256)
  );
}

function runDefault(program, arguments_, options) {
  return execFileSync(program, arguments_, options);
}

function reviewedRustObjcopy(environment, runCommand) {
  const rustEnvironment = {
    ...environment,
    RUSTUP_TOOLCHAIN: RUST_SUPPLY_TOOLCHAIN,
  };
  const version = runCommand("rustc", ["-vV"], {
    encoding: "utf8",
    env: rustEnvironment,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const host = version.match(/^host: (.+)$/mu)?.[1];
  if (host !== "aarch64-apple-darwin") {
    throw new Error(
      `reviewed rust-objcopy requires Rust ${RUST_SUPPLY_TOOLCHAIN} on macOS ARM64`,
    );
  }
  const sysroot = runCommand("rustc", ["--print", "sysroot"], {
    encoding: "utf8",
    env: rustEnvironment,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  const objcopy = path.join(
    sysroot,
    "lib/rustlib",
    host,
    "bin/rust-objcopy",
  );
  if (!isHashedFile(objcopy, RUST_OBJCOPY_SHA256)) {
    throw new Error(
      `Rust ${RUST_SUPPLY_TOOLCHAIN} rust-objcopy is missing or changed`,
    );
  }
  return objcopy;
}

function downloadReleaseAsset(destination, environment, runCommand) {
  runCommand(
    "/usr/bin/curl",
    [
      "--disable",
      "--fail",
      "--location",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--silent",
      "--show-error",
      "--output",
      destination,
      `https://github.com/${RELEASE_REPOSITORY}/releases/download/${RELEASE_TAG}/${RELEASE_ASSET}`,
    ],
    {
      env: environment,
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
}

function prepareInputs(cacheRoot, environment, runCommand, downloadAsset) {
  const inputsRoot = path.join(cacheRoot, "inputs/v2");
  let inputs = inputPaths(inputsRoot);
  if (inputsAreValid(inputs)) return inputs;

  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(cacheRoot, ".inputs-v2-"));
  try {
    const asset = path.join(scratch, RELEASE_ASSET);
    console.error("Preparing pinned Ghostty VT build inputs (first run only)…");
    downloadAsset(asset, environment, runCommand);
    if (!isHashedFile(asset, RELEASE_ASSET_SHA256)) {
      throw new Error("downloaded Ghostty VT provenance asset hash changed");
    }
    const extracted = path.join(scratch, "extracted");
    fs.mkdirSync(extracted, { mode: 0o700 });
    runCommand("/usr/bin/tar", ["-xzf", asset, "-C", extracted], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const extractedInputs = inputPaths(extracted);
    if (
      !isHashedFile(extractedInputs.ghosttySource, GHOSTTY_SOURCE_SHA256) ||
      !isHashedFile(extractedInputs.zigArchive, ZIG_ARCHIVE_SHA256) ||
      !isHashedFile(extractedInputs.uucodeArchive, UUCODE_ARCHIVE_SHA256) ||
      !isHashedFile(extractedInputs.highwayArchive, HIGHWAY_ARCHIVE_SHA256) ||
      !isHashedFile(extractedInputs.thirdPartyNotices, THIRD_PARTY_NOTICES_SHA256)
    ) {
      throw new Error("Ghostty VT provenance contents do not match their pins");
    }
    fs.mkdirSync(path.dirname(extractedInputs.zig), { mode: 0o700 });
    runCommand(
      "/usr/bin/tar",
      [
        "-xJf",
        extractedInputs.zigArchive,
        "-C",
        path.dirname(extractedInputs.zig),
        "--strip-components=1",
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    if (!isHashedFile(extractedInputs.zig, ZIG_EXECUTABLE_SHA256)) {
      throw new Error("extracted Ghostty VT Zig executable hash changed");
    }
    fs.chmodSync(extractedInputs.zig, 0o755);
    fs.mkdirSync(path.dirname(inputsRoot), { recursive: true, mode: 0o700 });
    try {
      fs.renameSync(extracted, inputsRoot);
    } catch (error) {
      inputs = inputPaths(inputsRoot);
      if (!inputsAreValid(inputs)) throw error;
      return inputs;
    }
    inputs = inputPaths(inputsRoot);
    return inputs;
  } finally {
    fs.rmSync(scratch, { force: true, recursive: true });
  }
}

function stageArtifact(cacheRoot, target, inputs, environment, runCommand) {
  const objcopyArguments = inputs.objcopy
    ? ["--objcopy", inputs.objcopy]
    : [];
  const build = nativeBuildCommand(
    "cargo",
    [
      "run",
      "--locked",
      "--manifest-path",
      "hmux/Cargo.toml",
      "--package",
      "terminal-core-ghostty-proof",
      "--features",
      "supply-stage",
      "--bin",
      "stage-ghostty-vt",
      "--",
      "--ghostty-source",
      inputs.ghosttySource,
      "--zig-archive",
      inputs.zigArchive,
      "--zig",
      inputs.zig,
      ...objcopyArguments,
      "--uucode-cache",
      inputs.uucodeArchive,
      "--highway-cache",
      inputs.highwayArchive,
      "--target",
      target,
      "--output",
      path.join(cacheRoot, "artifacts"),
    ],
    { environment },
  );
  const output = runCommand(build.command, build.args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      ...environment,
      RUSTUP_TOOLCHAIN:
        environment.RUSTUP_TOOLCHAIN ?? RUST_SUPPLY_TOOLCHAIN,
    },
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const artifactRoot = output
    .split("\n")
    .find((line) => line.startsWith("artifact_root="))
    ?.slice("artifact_root=".length);
  if (!artifactRoot || !path.isAbsolute(artifactRoot)) {
    throw new Error("Ghostty VT supply builder did not return an artifact root");
  }
  if (!receiptMatches(artifactRoot, target)) {
    throw new Error("Ghostty VT supply builder returned the wrong target");
  }
  return artifactRoot;
}

function publishTargetPointer(cacheRoot, target, artifactRoot) {
  const directory = path.join(cacheRoot, "targets");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${target}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${artifactRoot}\n`, { mode: 0o600 });
  fs.renameSync(temporary, path.join(directory, `${target}.txt`));
}

export function ensureGhosttyVtProof({
  arch = process.arch,
  downloadAsset = downloadReleaseAsset,
  environment = process.env,
  platform = process.platform,
  runCommand = runDefault,
  target,
}) {
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`unsupported Hmux Host target ${target}`);
  }
  const cacheRoot = defaultCacheRoot(environment, platform);
  const cached = cachedArtifact(cacheRoot, target);
  if (cached) return cached;
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error(
      "automatic Ghostty VT preparation currently requires the macOS ARM64 build host",
    );
  }
  const inputs = prepareInputs(
    cacheRoot,
    environment,
    runCommand,
    downloadAsset,
  );
  if (target === "x86_64-pc-windows-msvc") {
    inputs.objcopy = reviewedRustObjcopy(environment, runCommand);
  }
  console.error(`Building the cached Ghostty VT proof for ${target}…`);
  const artifactRoot = stageArtifact(
    cacheRoot,
    target,
    inputs,
    environment,
    runCommand,
  );
  publishTargetPointer(cacheRoot, target, artifactRoot);
  return artifactRoot;
}

function parseTarget(arguments_) {
  if (arguments_.length === 2 && arguments_[0] === "--target") {
    return arguments_[1];
  }
  if (arguments_.length !== 0) {
    throw new Error("usage: ensure-ghostty-vt-proof.mjs [--target <triple>]");
  }
  const version = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = version.match(/^host: (.+)$/mu)?.[1];
  if (!host) throw new Error("rustc did not report a Host target");
  return host;
}

function main() {
  const target = parseTarget(process.argv.slice(2));
  process.stdout.write(`${ensureGhosttyVtProof({ target })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
