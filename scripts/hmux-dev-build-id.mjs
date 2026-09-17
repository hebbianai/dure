#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HMUX_DEV_RUNTIME_INPUTS } from "./lib/hmux-dev-build-inputs.mjs";

const defaultRepositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const buildLayout = "versioned-target-shared-build-v2";
const ignoredDirectoryNames = new Set([".git", "node_modules", "target"]);
export const HMUX_DEV_RUSTC_IDENTITY_TIMEOUT_MS = 10_000;
const MAX_RUSTC_IDENTITY_BYTES = 64 * 1024;
const buildEnvironmentKeys = [
  "CARGO_BUILD_TARGET",
  "CARGO_BUILD_BUILD_DIR",
  "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_TARGET_DIR",
  "CC",
  "CFLAGS",
  "LDFLAGS",
  "MACOSX_DEPLOYMENT_TARGET",
  "RUSTFLAGS",
  "SDKROOT",
];

function hashPath(hash, repositoryRoot, pathname) {
  const stat = lstatSync(pathname);
  const relativePath = relative(repositoryRoot, pathname).replaceAll("\\", "/");
  if (stat.isSymbolicLink()) {
    hash.update(`link\0${relativePath}\0${readlinkSync(pathname)}\0`);
    return;
  }
  if (stat.isDirectory()) {
    hash.update(`directory\0${relativePath}\0`);
    for (const entry of readdirSync(pathname, { withFileTypes: true })
      .filter(
        (candidate) =>
          !(
            candidate.isDirectory() &&
            ignoredDirectoryNames.has(candidate.name)
          ),
      )
      .sort((left, right) => left.name.localeCompare(right.name))) {
      hashPath(hash, repositoryRoot, join(pathname, entry.name));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`unsupported Hmux build input: ${relativePath}`);
  }
  hash.update(`file\0${relativePath}\0${stat.mode & 0o111}\0`);
  hash.update(readFileSync(pathname));
  hash.update("\0");
}

function buildContext(environment) {
  return Object.fromEntries(
    buildEnvironmentKeys.map((key) => [key, environment[key] ?? ""]),
  );
}

export function readHmuxDevRustcVersion({
  repositoryRoot = defaultRepositoryRoot,
  environment = process.env,
  run = execFileSync,
  timeoutMs = HMUX_DEV_RUSTC_IDENTITY_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Hmux compiler identity timeout is invalid");
  }
  return run("rustc", ["-vV"], {
    cwd: realpathSync(repositoryRoot),
    encoding: "utf8",
    env: environment,
    maxBuffer: MAX_RUSTC_IDENTITY_BYTES,
    timeout: timeoutMs,
  }).trim();
}

export function computeHmuxDevBuildId({
  repositoryRoot = defaultRepositoryRoot,
  environment = process.env,
  rustcVersion,
  run = execFileSync,
  rustcTimeoutMs = HMUX_DEV_RUSTC_IDENTITY_TIMEOUT_MS,
} = {}) {
  const canonicalRepositoryRoot = realpathSync(repositoryRoot);
  const compilerIdentity =
    rustcVersion ??
    readHmuxDevRustcVersion({
      repositoryRoot: canonicalRepositoryRoot,
      environment,
      run,
      timeoutMs: rustcTimeoutMs,
    });
  const manifest = readFileSync(
    join(canonicalRepositoryRoot, "hmux", "Cargo.toml"),
    "utf8",
  );
  const packageVersion = manifest.match(/^version = "([^"]+)"$/m)?.[1];
  if (!packageVersion) {
    throw new Error("could not determine the Hmux package version");
  }

  const sourceHash = createHash("sha256");
  for (const input of HMUX_DEV_RUNTIME_INPUTS) {
    hashPath(
      sourceHash,
      canonicalRepositoryRoot,
      join(canonicalRepositoryRoot, input.path),
    );
  }
  const contextHash = createHash("sha256")
    .update(
      JSON.stringify({
        buildLayout,
        repositoryRoot: canonicalRepositoryRoot,
        rustcVersion: compilerIdentity,
        platform: process.platform,
        architecture: process.arch,
        environment: buildContext(environment),
      }),
    )
    .digest("hex")
    .slice(0, 12);

  return `${packageVersion}+dev.${sourceHash.digest("hex").slice(0, 16)}.${contextHash}`;
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) ===
    realpathSync(fileURLToPath(import.meta.url))
) {
  process.stdout.write(`${computeHmuxDevBuildId()}\n`);
}
