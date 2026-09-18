#!/usr/bin/env node
// Maintainer main pushes are exempt. Other events use the existing scope
// classifier, retaining all public suites for any code change.
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
  ref,
  actorPermission,
  base,
  head,
  cwd = process.cwd(),
  environment = process.env,
}) {
  const full = (reason) => ({ runChecks: true, runCodeChecks: true, reason });
  if (
    eventName === "push" && ref === "refs/heads/main" && (
      ["maintain", "admin"].includes(actorPermission?.role_name) ||
      actorPermission?.permission === "admin" ||
      actorPermission?.user?.permissions?.maintain === true ||
      actorPermission?.user?.permissions?.admin === true
    )
  ) {
    return { runChecks: false, runCodeChecks: false, reason: "maintainer-main-push" };
  }
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
      runChecks: true,
      runCodeChecks: scopes.length > 0,
      reason: scopes.length > 0 ? "code-or-shared-inputs" : "documentation-only",
      changedPathCount: paths.length,
      scopes,
    };
  } catch {
    return full("comparison-unavailable");
  }
}

export async function lookupActorPermission({
  eventName, ref, actor, repository, token,
  apiUrl = "https://api.github.com", fetchImpl = fetch,
}) {
  if (eventName !== "push" || ref !== "refs/heads/main" || !actor || !repository || !token) return null;
  try {
    const response = await fetchImpl(
      `${apiUrl}/repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10",
        },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      },
    );
    if (!response.ok) return null;
    const permission = await response.json();
    return permission?.user?.login?.toLowerCase() === actor.toLowerCase() ? permission : null;
  } catch {
    // An unavailable permission lookup retains the normal public checks.
    return null;
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

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length > 0) throw new Error("Unexpected public CI arguments");
  if (command === "plan") {
    const actorPermission = await lookupActorPermission({
      eventName: process.env.CI_EVENT_NAME,
      ref: process.env.CI_REF,
      actor: process.env.CI_ACTOR,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
    });
    const plan = planPublicCi({
      eventName: process.env.CI_EVENT_NAME,
      ref: process.env.CI_REF,
      actorPermission,
      base: process.env.CI_BASE_SHA,
      head: process.env.CI_HEAD_SHA,
    });
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
    appendFileSync(process.env.GITHUB_OUTPUT, `run_checks=${plan.runChecks}\nrun_code_checks=${plan.runCodeChecks}\n`);
    console.log(JSON.stringify(plan));
  } else if (command === "check") {
    requirePublicCiSuccess(process.env);
    console.log("Every selected public repository check succeeded.");
  } else {
    throw new Error("Usage: node scripts/public-ci.mjs <plan|check>");
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
