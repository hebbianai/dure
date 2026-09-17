#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { corepackExecutable } from "./lib/corepack-install.mjs";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";

const PROJECT_LOCK = "pnpm-lock.yaml";
const INSTALLED_LOCK = path.join("node_modules", ".pnpm", "lock.yaml");

function normalizedLockfile(pathname) {
  return fs.readFileSync(pathname, "utf8").replaceAll("\r\n", "\n");
}

export function inspectNodeDependencyInstall(root = process.cwd()) {
  const projectLockPath = path.join(root, PROJECT_LOCK);
  const installedLockPath = path.join(root, INSTALLED_LOCK);
  if (!fs.existsSync(projectLockPath)) {
    return {
      code: "project_lock_missing",
      ok: false,
      projectLockPath,
      installedLockPath,
    };
  }
  if (!fs.existsSync(installedLockPath)) {
    return {
      code: "installed_lock_missing",
      ok: false,
      projectLockPath,
      installedLockPath,
    };
  }
  // Git may materialize the project lock with CRLF on Windows while pnpm's
  // installed snapshot uses LF. The dependency graph is the authority here;
  // checkout line endings are not part of that identity.
  const projectLock = normalizedLockfile(projectLockPath);
  const installedLock = normalizedLockfile(installedLockPath);
  if (projectLock !== installedLock) {
    return {
      code: "installed_lock_mismatch",
      ok: false,
      projectLockPath,
      installedLockPath,
    };
  }
  return {
    code: "current",
    ok: true,
    fingerprint: `pnpm-lock-v1:${createHash("sha256").update(projectLock).digest("hex")}`,
    projectLockPath,
    installedLockPath,
  };
}

function failureMessage(result) {
  let detail;
  if (result.code === "project_lock_missing") {
    detail = `project lockfile is missing (${result.projectLockPath})`;
  } else if (result.code === "installed_lock_missing") {
    detail = `node_modules is missing pnpm's installed lock snapshot (${result.installedLockPath})`;
  } else {
    detail =
      "node_modules was installed from a different pnpm-lock.yaml " +
      `(${result.installedLockPath})`;
  }
  return (
    `node_dependency_preflight_failed: ${detail}\n` +
    "해결: corepack pnpm install --frozen-lockfile"
  );
}

export function requireCurrentNodeDependencyInstall(root = process.cwd()) {
  const result = inspectNodeDependencyInstall(root);
  if (!result.ok) throw new Error(failureMessage(result));
  return result;
}

export function installNodeDependencies(
  root = process.cwd(),
  sourceEnvironment = process.env,
) {
  // Corepack honors package.json#packageManager, and the repo's engine-strict
  // pin rejects a wrong Node runtime before installing.
  // An explicit install must materialize the locked payload: pnpm otherwise
  // trusts an existing virtual-store directory, even if its patch hash names
  // newer code than its files contain. This is installation, not a test gate.
  const environment = withoutLocalGitOverrides(sourceEnvironment);
  execFileSync(
    corepackExecutable(environment),
    ["pnpm", "install", "--frozen-lockfile", "--force"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      env: environment,
    },
  );
  const result = requireCurrentNodeDependencyInstall(root);
  // Vite keys optimized output by lock/config, not repaired package contents.
  // Invalidate only this checkout's generated cache after a successful install.
  fs.rmSync(path.join(root, "node_modules", ".vite"), { recursive: true, force: true });
  return result;
}

function main() {
  const install = process.argv.slice(2).includes("--install");
  try {
    const result = inspectNodeDependencyInstall();
    if (result.ok) return;
    if (!install) throw new Error(failureMessage(result));
    installNodeDependencies();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
