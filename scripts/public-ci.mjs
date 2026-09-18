#!/usr/bin/env node
// Public CI has a documentation-only fast path. Any code scope retains all
// existing public suites; this adapter does not invent a second path classifier.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import {
  classifyChangedPaths,
  gitDiffNameOnlyArgs,
  parseNullDelimitedGitPaths,
} from "./lib/push-gate-scope.mjs";

const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const CODE_RESULTS = [
  "FRONTEND_RESULT",
  "SCRIPTS_RESULT",
  "MOBILE_WEB_RESULT",
  "SHARED_PROTOCOL_RESULT",
];

export function planPublicCi({
  eventName,
  base,
  head,
  cwd = process.cwd(),
  environment = process.env,
}) {
  const full = (reason) => ({ runCodeChecks: true, reason });
  if (eventName !== "push" && eventName !== "pull_request") {
    return full("manual-or-unsupported-event");
  }
  if (
    !COMMIT_SHA.test(base ?? "") ||
    !COMMIT_SHA.test(head ?? "") ||
    /^0+$/.test(base) ||
    /^0+$/.test(head)
  ) {
    return full("missing-comparison");
  }

  const git = (args) =>
    execFileSync("git", args, {
      cwd,
      env: withoutLocalGitOverrides(environment),
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    if (git(["rev-parse", "HEAD"]).toString().trim() !== head.toLowerCase()) {
      return full("checkout-mismatch");
    }
    // PR runs compare the event's base with the checked-out merge commit.
    // Push runs cover the entire before..after range, including all commits.
    git(["merge-base", "--is-ancestor", base, head]);
    const paths = parseNullDelimitedGitPaths(git(gitDiffNameOnlyArgs(base, head)));
    const scopes = classifyChangedPaths(paths);
    return {
      runCodeChecks: scopes.length > 0,
      reason: scopes.length > 0 ? "code-or-shared-inputs" : "documentation-only",
      changedPathCount: paths.length,
      scopes,
    };
  } catch {
    return full("comparison-unavailable");
  }
}

export function requirePublicCiSuccess(environment) {
  for (const key of ["PLAN_RESULT", "DOCUMENTATION_RESULT"]) {
    if (environment[key] !== "success") {
      throw new Error(`${key} must succeed; received ${environment[key] ?? "missing"}`);
    }
  }
  if (!["true", "false"].includes(environment.RUN_CODE_CHECKS)) {
    throw new Error("RUN_CODE_CHECKS must be an explicit true or false plan output");
  }
  const expected = environment.RUN_CODE_CHECKS === "true" ? "success" : "skipped";
  for (const key of CODE_RESULTS) {
    if (environment[key] !== expected) {
      throw new Error(`${key} must be ${expected}; received ${environment[key] ?? "missing"}`);
    }
  }
}

function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length > 0) throw new Error("Unexpected public CI arguments");
  if (command === "plan") {
    const plan = planPublicCi({
      eventName: process.env.CI_EVENT_NAME,
      base: process.env.CI_BASE_SHA,
      head: process.env.CI_HEAD_SHA,
    });
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
    appendFileSync(process.env.GITHUB_OUTPUT, `run_code_checks=${plan.runCodeChecks}\n`);
    console.log(JSON.stringify(plan));
  } else if (command === "check") {
    requirePublicCiSuccess(process.env);
    console.log("Every selected public repository check succeeded.");
  } else {
    throw new Error("Usage: node scripts/public-ci.mjs <plan|check>");
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
