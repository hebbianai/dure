#!/usr/bin/env node
// Read-only impact diagnostic. Ordinary main pushes have no aggregate gate;
// this reports the consumer suites relevant to focused development evidence.
//
// Usage:
//   node scripts/gate-scope.mjs                 # origin/main fork point + working tree
//   node scripts/gate-scope.mjs --base <ref>
//   node scripts/gate-scope.mjs --json
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import { classifyChangedPaths } from "./lib/push-gate-scope.mjs";
import { PUSH_GATE_ORDER, pushGatePlan } from "./lib/push-gate-contract.mjs";

const DEFAULT_BASE = "origin/main";
const MAX_LISTED_PATHS = 40;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

function tryGit(args, environment) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      env: environment,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function splitNul(output) {
  return output ? output.split("\0").filter((entry) => entry.length > 0) : [];
}

/**
 * Every path the push would carry: committed since the fork point, plus
 * anything still uncommitted. Uncommitted paths count because this runs before
 * the commit, and a path about to be added must not be invisible here.
 */
export function collectChangedPaths(base, environment = process.env) {
  const paths = new Set();
  // Compare against the fork point, not the base tip. A worktree that is behind
  // main must see only what it changed; a two-dot diff against a moved main
  // reports main's own commits as this push's paths and then fails closed on
  // nearly all of them.
  const forkPoint = (tryGit(["merge-base", base, "HEAD"], environment) ?? "").trim();
  const baseResolved = forkPoint.length > 0;

  if (baseResolved) {
    for (const path of splitNul(
      tryGit(
        ["diff", "--no-renames", "--name-only", "-z", `${forkPoint}..HEAD`, "--"],
        environment,
      ),
    )) {
      paths.add(path);
    }
  }
  for (const path of splitNul(
    tryGit(["diff", "--no-renames", "--name-only", "-z", "HEAD", "--"], environment),
  )) {
    paths.add(path);
  }
  for (const path of splitNul(
    tryGit(["ls-files", "--others", "--exclude-standard", "-z"], environment),
  )) {
    paths.add(path);
  }
  return { paths: [...paths].sort(), baseResolved, forkPoint };
}

/**
 * Supply semantic evidence only when Git resolved the exact before revision
 * and the current worktree supplies the after document. Missing or ambiguous
 * evidence is represented by omission, so the canonical classifier retains
 * its path-only fail-closed behavior.
 */
export function collectScopeEvidence(
  change,
  environment = process.env,
  { runGit = tryGit, readFile = readFileSync } = {},
) {
  if (
    !change?.baseResolved ||
    !Array.isArray(change.paths) ||
    !change.paths.includes("package.json") ||
    typeof change.forkPoint !== "string" ||
    !GIT_OBJECT_ID.test(change.forkPoint)
  ) {
    return {};
  }

  const repositoryRoot = (
    runGit(["rev-parse", "--show-toplevel"], environment) ?? ""
  ).trim();
  const before = runGit(
    ["show", `${change.forkPoint}:package.json`],
    environment,
  );
  if (!isAbsolute(repositoryRoot) || before === null) return {};

  try {
    return {
      packageManifest: {
        before,
        after: readFile(join(repositoryRoot, "package.json"), "utf8"),
      },
    };
  } catch {
    return {};
  }
}

export function describeScope(changedPaths, evidence = {}) {
  const selected = new Set(classifyChangedPaths(changedPaths, evidence));
  // Print the gates in the order run-push-gates.mjs executes them, not in the
  // classifier's canonical order. An advisory that lists a different order than
  // the runner is a second source of truth.
  const scopes = PUSH_GATE_ORDER.filter((scope) => selected.has(scope));
  return {
    changedPaths,
    scopes,
    commands: pushGatePlan(scopes).map(({ scope, script }) => ({
      scope,
      command: `pnpm ${script}`,
    })),
  };
}

function render(result, base, baseResolved, forkPoint, evidence) {
  const { changedPaths, scopes, commands } = result;
  const baseLabel = baseResolved
    ? `${base} fork point ${forkPoint.slice(0, 9)}`
    : `${base} (unresolved — comparing working tree only)`;
  console.log(`gate:scope — ${changedPaths.length} changed paths vs ${baseLabel}`);

  if (changedPaths.length === 0) {
    console.log("\nNothing changed.");
    return;
  }

  console.log("");
  for (const path of changedPaths.slice(0, MAX_LISTED_PATHS)) {
    const pathScopes = classifyChangedPaths([path], evidence);
    const label =
      pathScopes.length === 0
        ? "no code gate"
        : pathScopes.length === PUSH_GATE_ORDER.length
          ? `all ${pathScopes.length} (fail-closed — path/evidence is not narrowly classifiable)`
          : pathScopes.join(", ");
    console.log(`  ${path.padEnd(58)} ${label}`);
  }
  if (changedPaths.length > MAX_LISTED_PATHS) {
    console.log(`  … and ${changedPaths.length - MAX_LISTED_PATHS} more`);
  }

  if (scopes.length === 0) {
    console.log(
      "\nDocumentation/metadata-only diff — no code gate to run.\n" +
        "No build, no test suite, no sidecar staging. Review and push.",
    );
    return;
  }

  console.log(
    `\n${scopes.length} affected diagnostic suite(s) ` +
      "(optional; not a landing gate):",
  );
  for (const { scope, command } of commands) {
    console.log(`  ${scope.padEnd(24)} → ${command}`);
  }
  if (scopes.length === PUSH_GATE_ORDER.length) {
    console.log(
      "\nNote: every gate was selected. Unknown paths or insufficient semantic\n" +
        "evidence expand fail-closed — check the list above for which one.",
    );
  }
}

async function main() {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  let base = DEFAULT_BASE;
  let asJson = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--json") {
      asJson = true;
    } else if (args[index] === "--base") {
      base = args[index + 1];
      index += 1;
      if (!base) throw new Error("--base requires a ref");
    } else {
      throw new Error(`unknown argument: ${args[index]}`);
    }
  }

  const environment = withoutLocalGitOverrides();
  const change = collectChangedPaths(base, environment);
  const { paths, baseResolved, forkPoint } = change;
  const evidence = collectScopeEvidence(change, environment);
  const result = describeScope(paths, evidence);
  if (asJson) {
    console.log(JSON.stringify({ base, baseResolved, forkPoint, ...result }, null, 2));
    return;
  }
  render(result, base, baseResolved, forkPoint, evidence);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
