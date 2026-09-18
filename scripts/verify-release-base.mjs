#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  assertPinnedCheckout,
  describeExactCiRuns,
  findExactSuccessfulCiRun,
  normalizeFullCommitSha,
} from "./lib/release-gate.mjs";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";

function command(executable, args) {
  return execFileSync(executable, args, {
    encoding: "utf8",
    env: executable === "git" ? withoutLocalGitOverrides() : process.env,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

try {
  const base = normalizeFullCommitSha(process.argv[2], "release base");
  const head = command("git", ["rev-parse", "HEAD"]);
  assertPinnedCheckout(base, head);

  const repository = process.env.GITHUB_REPOSITORY;
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  ) {
    throw new Error("GITHUB_REPOSITORY must be an owner/repository slug");
  }
  // The dispatch pins the source. Development may advance independently.
  const rawRuns = command("gh", [
    "run",
    "list",
    "--repo",
    repository,
    "--commit",
    base,
    "--workflow",
    "public-repository.yml",
    "--limit",
    "20",
    "--json",
    "databaseId,status,conclusion,headSha,url,createdAt",
  ]);
  const runs = JSON.parse(rawRuns);
  const green = findExactSuccessfulCiRun(base, runs);
  if (!green) {
    throw new Error(
      `release_base_ci_not_green: ${base} (${describeExactCiRuns(base, runs)}); ` +
        "wait for that exact CI SHA to succeed, then dispatch Release again",
    );
  }

  console.log(`release base CI green: ${base} (${green.url ?? `run ${green.databaseId}`})`);
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
