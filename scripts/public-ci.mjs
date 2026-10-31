#!/usr/bin/env node
// Public CI has a documentation-only fast path. Every push, including a
// maintainer's push to main, and every pull request is planned from its
// complete change; any code scope retains all existing public suites, and the
// Rust workspace jobs run when a scope their gate verifies changes. This
// adapter does not invent a second path classifier.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import {
  classifyChangedPaths,
  gitDiffNameOnlyArgs,
  parseNullDelimitedGitPaths,
} from "./lib/push-gate-scope.mjs";

const COMMIT_SHA = /^[0-9a-f]{40}$/i;
// Classifier scopes whose change selects each Rust workspace job.
export const RUST_JOB_SCOPES = Object.freeze({
  runHmuxChecks: Object.freeze(["hmux-core", "hmux-mobile-compat", "terminal-state-protocol"]),
  runAppChecks: Object.freeze(["app-core"]),
});
// Each code job must succeed when its plan output selects it and be skipped
// otherwise.
const CODE_RESULTS = Object.freeze({
  FRONTEND_RESULT: "RUN_CODE_CHECKS",
  SCRIPTS_VITEST_RESULT: "RUN_CODE_CHECKS",
  SCRIPTS_NODE_RESULT: "RUN_CODE_CHECKS",
  SCRIPTS_DEADLINE_RESULT: "RUN_CODE_CHECKS",
  SCRIPTS_PROCESS_RESULT: "RUN_CODE_CHECKS",
  MOBILE_WEB_RESULT: "RUN_CODE_CHECKS",
  SHARED_PROTOCOL_RESULT: "RUN_CODE_CHECKS",
  HMUX_RESULT: "RUN_HMUX_CHECKS",
  APP_RESULT: "RUN_APP_CHECKS",
});

export function planPublicCi({
  eventName,
  base,
  head,
  cwd = process.cwd(),
  environment = process.env,
}) {
  const full = (reason) => ({
    runCodeChecks: true,
    runHmuxChecks: true,
    runAppChecks: true,
    reason,
  });
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
    const selects = (job) => RUST_JOB_SCOPES[job].some((scope) => scopes.includes(scope));
    return {
      runCodeChecks: scopes.length > 0,
      runHmuxChecks: selects("runHmuxChecks"),
      runAppChecks: selects("runAppChecks"),
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
  for (const plan of new Set(Object.values(CODE_RESULTS))) {
    if (!["true", "false"].includes(environment[plan])) {
      throw new Error(`${plan} must be an explicit true or false plan output`);
    }
  }
  for (const [key, plan] of Object.entries(CODE_RESULTS)) {
    const expected = environment[plan] === "true" ? "success" : "skipped";
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
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `run_code_checks=${plan.runCodeChecks}\n` +
        `run_hmux_checks=${plan.runHmuxChecks}\n` +
        `run_app_checks=${plan.runAppChecks}\n`,
    );
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
