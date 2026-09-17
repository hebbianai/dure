#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureHeadroom } from "./lib/build-storage-admission.mjs";
import { exposeBuildStorageReservation } from "./lib/build-storage-reservation.mjs";
import { buildStorageBudget } from "./lib/disk-space.mjs";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import {
  inspectNodeDependencyInstall,
  installNodeDependencies,
} from "./node-dependency-preflight.mjs";
import {
  pushGatePlan,
  PUSH_GATE_ORDER,
} from "./lib/push-gate-contract.mjs";
import { verificationScopesRequireRootNodeDependencies } from "./lib/push-gate-scope.mjs";
import { prepareReleaseVerificationEnvironment } from "./lib/release-verification-environment.mjs";

export { PUSH_GATE_ORDER } from "./lib/push-gate-contract.mjs";

export function parseReleaseGateArguments(args) {
  const normalized = args.filter((argument) => argument !== "--");
  if (normalized.length !== 1 || normalized[0] !== "--all") {
    throw new Error("usage: run-push-gates.mjs --all");
  }
  return "--all";
}

function parseScopeInput(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") {
    throw new Error("push gate scopes must be an array or string");
  }
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("push gate scope JSON must be an array");
    }
    return parsed;
  }
  return trimmed.split(",");
}

export function normalizePushGateScopes(value) {
  if (value === "--all") return [...PUSH_GATE_ORDER];
  const requested = new Set();
  for (const entry of parseScopeInput(value)) {
    if (typeof entry !== "string" || !PUSH_GATE_ORDER.includes(entry.trim())) {
      throw new Error(`unknown push gate scope: ${JSON.stringify(entry)}`);
    }
    requested.add(entry.trim());
  }
  return PUSH_GATE_ORDER.filter((scope) => requested.has(scope));
}

export function scriptsForPushGateScopes(value) {
  return pushGatePlan(normalizePushGateScopes(value)).map(({ script }) => script);
}

export function runPushGateScopes(
  value,
  run = spawnSync,
  {
    environment: sourceEnvironment = process.env,
    releaseIsolation = false,
    workingDirectory = process.cwd(),
  } = {},
) {
  const scopes = normalizePushGateScopes(value);
  if (scopes.length === 0) {
    console.log("release verification: no product scopes selected");
    return 0;
  }
  const isolation = releaseIsolation
    ? prepareReleaseVerificationEnvironment(sourceEnvironment, workingDirectory)
    : undefined;
  const environment = withoutLocalGitOverrides(
    isolation?.environment ?? sourceEnvironment,
  );
  let shimDirectory;
  try {
    // A release dependency repair is part of the release gate's mutation
    // boundary. Run it only after the explicit release environment has
    // replaced ambient developer homes, caches, temp state, and install roots.
    // Ordinary scoped push gates keep their existing no-repair behavior.
    if (
      releaseIsolation &&
      verificationScopesRequireRootNodeDependencies(scopes)
    ) {
      const install = inspectNodeDependencyInstall(workingDirectory);
      if (!install.ok) {
        console.log(
          "release verification: node_modules does not match pnpm-lock.yaml — installing " +
            "before the gates run (this is an environment repair, not a failure)",
        );
        installNodeDependencies(workingDirectory, environment);
      }
    }

    // A package script that invokes bare `pnpm` does not inherit Corepack's
    // selected binary. On machines with an old global pnpm first on PATH that
    // silently mixes lockfile implementations inside one gate. Pin every nested
    // invocation through a short-lived PATH shim.
    shimDirectory = fs.mkdtempSync(
      path.join(environment.TMPDIR ?? os.tmpdir(), "hebbian-pnpm-shim-"),
    );
    const shim = path.join(shimDirectory, "pnpm");
    fs.writeFileSync(shim, '#!/bin/sh\nexec corepack pnpm "$@"\n', {
      mode: 0o700,
    });
    // `pnpm app:dev` injects a worktree-specific inline Tauri config. A full
    // verification may run from that durable dev session, but each desktop and
    // mobile Cargo gate must load its own checked tauri.conf.json.
    delete environment.TAURI_CONFIG;
    environment.PATH = `${shimDirectory}${path.delimiter}${environment.PATH ?? ""}`;
    const plan = pushGatePlan(scopes);

    for (const { scope, script } of plan) {
      console.log(`release verification: ${scope} → corepack pnpm ${script}`);
      const result = run("corepack", ["pnpm", script], {
        cwd: workingDirectory,
        env: environment,
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      if (result.status !== 0) return result.status ?? 1;
    }
  } finally {
    try {
      if (shimDirectory) {
        fs.rmSync(shimDirectory, { force: true, recursive: true });
      }
    } finally {
      isolation?.cleanup();
    }
  }
  return 0;
}

function main() {
  const scopeInput = parseReleaseGateArguments(process.argv.slice(2));
  normalizePushGateScopes(scopeInput);
  // Release verification includes large Cargo builds. Reclaim space before it
  // starts, including dependency repair, so disk exhaustion is not misreported
  // as a source failure.
  const headroom = ensureHeadroom({
    label: "release verification",
    requestedBytes: buildStorageBudget("full"),
  });
  if (!headroom.ok) {
    console.error(headroom.message);
    process.exitCode = 1;
    return;
  }
  const restoreEnvironment = exposeBuildStorageReservation(
    headroom.reservation,
  );
  try {
    process.exitCode = runPushGateScopes(scopeInput, spawnSync, {
      releaseIsolation: true,
    });
  } finally {
    restoreEnvironment();
    headroom.reservation?.release();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
