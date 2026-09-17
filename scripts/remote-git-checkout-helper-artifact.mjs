#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourcePath = "src-tauri/resources/remote-git-checkout-helper";
const receiptName = "artifact/checkout-helper.json";
const targets = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"];
const binaryName = "dure-git-checkout-helper";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    env: withoutLocalGitOverrides(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function cleanSource(root) {
  if (git(root, ["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("checkout helper artifact transfer requires a clean source checkout");
  }
  return git(root, ["rev-parse", "HEAD"]);
}

function sourceInputs(root, commit) {
  // The helper composes crates/, hmux/, orchestration/ and CLI contracts, not
  // the desktop adapter/presentation or docs. Include every other tracked input
  // by default, including unknown paths, build scripts, lockfiles and config.
  const entries = git(root, ["ls-tree", "-r", "-z", "--full-tree", commit])
    .split("\0").filter(Boolean).filter((entry) => {
      const file = entry.slice(entry.indexOf("\t") + 1);
      return !["src/", "src-tauri/", "docs/"].some((prefix) => file.startsWith(prefix));
    });
  return digest(entries.join("\0"));
}

function buildEnvironment() {
  // Hash compiler overrides without exposing private values in receipts.
  // Routing and deploy capability tokens do not identify binary contents.
  const entries = Object.entries(process.env).filter(([key]) =>
    /^(CARGO_|RUST|CC($|_)|CXX($|_)|AR($|_)|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS|TARGET_CFLAGS|HMUX_BUILD_ID$|HMUX_SOURCE_COMMIT$|HMUX_GHOSTTY_|SDKROOT$|MACOSX_DEPLOYMENT_TARGET$|CRATE_CC_NO_DEFAULTS$)/.test(key),
  ).sort(([left], [right]) => left.localeCompare(right));
  return digest(JSON.stringify(entries));
}

function readReceipt(root, artifactRoot, sourceCommit) {
  const receipt = JSON.parse(fs.readFileSync(path.join(artifactRoot, receiptName), "utf8"));
  if (!/^[a-f0-9]{40,64}$/.test(receipt?.sourceCommit ?? "") || !(
    (receipt.schemaVersion === 1 && receipt.sourceCommit === sourceCommit) ||
    (receipt.schemaVersion === 2 && receipt.sourceInputs === sourceInputs(root, sourceCommit))
  )) {
    throw new Error("checkout helper artifact does not match this source commit's inputs");
  }
  return receipt;
}

function checkedBytes(artifactRoot, target, receipt) {
  const binary = path.join(artifactRoot, target, binaryName);
  if (!fs.lstatSync(binary).isFile()) {
    throw new Error(`checkout helper artifact is not a regular file for ${target}`);
  }
  const bytes = fs.readFileSync(binary);
  if (digest(bytes) !== receipt.binaries?.[target]) {
    throw new Error(`checkout helper artifact digest changed for ${target}`);
  }
  return bytes;
}

function verifyStatic(root, target, binary) {
  execFileSync("sh", [path.join(root, "scripts/verify-static-linux-binary.sh"), target, binary], {
    cwd: root,
    stdio: "pipe",
  });
}

function build(root) {
  const environment = withoutLocalGitOverrides();
  delete environment.DURE_CHECKOUT_HELPER_ARTIFACT_ROOT;
  execFileSync("sh", [path.join(root, "scripts/build-remote-git-checkout-helper.sh")], {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
}

export function supplyCheckoutHelperArtifact(root, runBuild = build) {
  const sourceCommit = cleanSource(root);
  const inputs = sourceInputs(root, sourceCommit);
  const environment = buildEnvironment();
  const artifactRoot = path.join(root, resourcePath);
  fs.rmSync(path.join(artifactRoot, receiptName), { force: true });
  runBuild(root);
  if (cleanSource(root) !== sourceCommit) {
    throw new Error("checkout helper source changed during the build");
  }
  const binaries = Object.fromEntries(targets.map((target) => {
    const binary = path.join(artifactRoot, target, binaryName);
    if (!fs.lstatSync(binary).isFile()) {
      throw new Error(`checkout helper build output is not a regular file for ${target}`);
    }
    verifyStatic(root, target, binary);
    return [target, digest(fs.readFileSync(binary))];
  }));
  fs.mkdirSync(path.dirname(path.join(artifactRoot, receiptName)), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, receiptName), `${JSON.stringify({
    schemaVersion: 2, sourceCommit, sourceInputs: inputs, buildEnvironment: environment, binaries,
  })}\n`);
  return artifactRoot;
}

export function prepareCheckoutHelperArtifact(root, runBuild = build) {
  const artifactRoot = path.join(root, resourcePath);
  let sourceCommit;
  try {
    sourceCommit = cleanSource(root);
  } catch {
    // Dirty-worktree staging still builds, without retaining clean receipts.
    fs.rmSync(path.join(artifactRoot, receiptName), { force: true });
    runBuild(root);
    return artifactRoot;
  }
  try {
    const receipt = readReceipt(root, artifactRoot, sourceCommit);
    if (receipt.schemaVersion !== 2 || receipt.buildEnvironment !== buildEnvironment()) {
      throw new Error("checkout helper build environment changed or is unproven");
    }
    for (const target of targets) {
      checkedBytes(artifactRoot, target, receipt);
      const binary = path.join(artifactRoot, target, binaryName);
      fs.accessSync(binary, fs.constants.X_OK);
      verifyStatic(root, target, binary);
    }
    if (cleanSource(root) !== sourceCommit) {
      throw new Error("checkout helper source changed during reuse verification");
    }
    console.log("Reusing verified remote Git checkout helpers (no native build required)");
    return artifactRoot;
  } catch (error) {
    console.error(`Preparing remote Git checkout helpers: ${error.message}`);
  }
  return supplyCheckoutHelperArtifact(root, runBuild);
}

export function stageCheckoutHelperArtifact(root, artifactRoot) {
  const sourceCommit = cleanSource(root);
  const receipt = readReceipt(root, artifactRoot, sourceCommit);
  const outputRoot = path.join(root, resourcePath);
  fs.mkdirSync(outputRoot, { recursive: true });
  const stage = fs.mkdtempSync(path.join(outputRoot, ".artifact-"));
  try {
    // Check both targets before replacing either bundled binary. Publish the
    // exact checked bytes, not a second read from a mutable download directory.
    for (const target of targets) {
      const bytes = checkedBytes(artifactRoot, target, receipt);
      const directory = path.join(stage, target);
      fs.mkdirSync(directory);
      const binary = path.join(directory, binaryName);
      fs.writeFileSync(binary, bytes, { mode: 0o755 });
      verifyStatic(root, target, binary);
    }
    if (cleanSource(root) !== sourceCommit) {
      throw new Error("checkout helper source changed during artifact verification");
    }
    // Retire reuse authority before the first replacement, including a partial
    // publication failure. A later prepare must rebuild any unproven pair.
    fs.rmSync(path.join(outputRoot, receiptName), { force: true });
    for (const target of targets) {
      const output = path.join(outputRoot, target);
      if (fs.existsSync(output)) {
        if (!fs.lstatSync(output).isDirectory()) {
          throw new Error(`checkout helper output is not a directory: ${output}`);
        }
        fs.rmSync(output, { recursive: true });
      }
      fs.renameSync(path.join(stage, target), output);
    }
    // Preserve the supplier's identity instead of claiming a new compilation.
    fs.mkdirSync(path.dirname(path.join(outputRoot, receiptName)), { recursive: true });
    fs.writeFileSync(path.join(outputRoot, receiptName), `${JSON.stringify(receipt)}\n`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [command, artifactRoot, ...extra] = process.argv.slice(2);
    if (command === "supply" && !artifactRoot) {
      process.stdout.write(`${supplyCheckoutHelperArtifact(repositoryRoot)}\n`);
    } else if (command === "prepare" && !artifactRoot) {
      prepareCheckoutHelperArtifact(repositoryRoot);
    } else if (command === "stage" && artifactRoot && extra.length === 0) {
      stageCheckoutHelperArtifact(repositoryRoot, path.resolve(artifactRoot));
    } else {
      throw new Error("usage: remote-git-checkout-helper-artifact.mjs supply | prepare | stage <artifact-root>");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
