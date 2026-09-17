#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_VERIFICATION_SCOPES,
  normalizeCommitSha,
  productReceiptRecords,
  verificationScopesSatisfy,
} from "./lib/ci-verification-receipt.mjs";
import { waitForExactGreenCiProductProof } from "./lib/wait-ci-green.mjs";

export const HMUX_RELEASE_PRODUCT_PROOF_SCHEMA =
  "dure-hmux-release-product-proof/v1";

const MAX_EXACT_CI_RUNS = 20;
const MAX_EXACT_RECEIPT_RUNS = 8;
const CI_RUN_FIELDS = "databaseId,headSha,status,conclusion,url";

function systemRun(command, args, options = {}) {
  const binaryOutput = options.encoding === "buffer";
  const result = spawnSync(command, args, {
    encoding: binaryOutput ? undefined : "utf8",
    maxBuffer: options.maxBuffer,
  });
  return {
    error: result.error,
    status: result.status ?? 1,
    stderr: result.stderr ?? (binaryOutput ? Buffer.alloc(0) : ""),
    stdout: result.stdout ?? (binaryOutput ? Buffer.alloc(0) : ""),
  };
}

function outputText(value) {
  return Buffer.isBuffer(value) ? value.toString("utf8") : (value ?? "");
}

function failedResult(message) {
  return { error: undefined, status: 1, stderr: message, stdout: "" };
}

function requireCommand(run, command, args) {
  const result = run(command, args);
  if (result.status !== 0) {
    const detail =
      result.error?.message ||
      outputText(result.stderr).trim() ||
      "unknown command failure";
    throw new Error(
      `hmux-release-product-proof: ${command} ${args.join(" ")} failed: ${detail}`,
    );
  }
  return outputText(result.stdout);
}

function expectedGlobalCiRunArgs(repository) {
  return [
    "run",
    "list",
    "--repo",
    repository,
    "--workflow",
    "CI",
    "--event",
    "push",
    "--branch",
    "main",
    "--limit",
    "100",
    "--json",
    CI_RUN_FIELDS,
  ];
}

function exactCiRunArgs(repository, sourceCommit) {
  return [
    "run",
    "list",
    "--repo",
    repository,
    "--workflow",
    "CI",
    "--event",
    "push",
    "--branch",
    "main",
    "--commit",
    sourceCommit,
    "--limit",
    String(MAX_EXACT_CI_RUNS),
    "--json",
    CI_RUN_FIELDS,
  ];
}

function sameArgs(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function parseObservedExactRuns(result, sourceCommit) {
  if (result.status !== 0) return [];
  try {
    const records = JSON.parse(outputText(result.stdout));
    if (!Array.isArray(records)) return [];
    return records.filter(
      (record) => record?.headSha?.toLowerCase() === sourceCommit,
    );
  } catch {
    return [];
  }
}

function exactProductReceiptRecords(run, repository, runId) {
  const normalizedRunId = String(runId ?? "");
  if (!/^[1-9][0-9]*$/.test(normalizedRunId)) {
    throw new Error(
      "hmux-release-product-proof: exact workflow run id must be positive",
    );
  }
  return productReceiptRecords(repository, (args) => {
    const [command, endpoint, ...rest] = args;
    const marker = "/actions/artifacts?";
    if (
      command !== "api" ||
      rest.length !== 0 ||
      typeof endpoint !== "string" ||
      !endpoint.includes(marker)
    ) {
      throw new Error(
        "hmux-release-product-proof: product receipt endpoint is invalid",
      );
    }
    return requireCommand(run, "gh", [
      "api",
      endpoint.replace(
        marker,
        `/actions/runs/${normalizedRunId}/artifacts?`,
      ),
    ]);
  });
}

function resolveSourceCommit(run, sourceRevision) {
  try {
    return normalizeCommitSha(sourceRevision, "Hmux release source commit");
  } catch {
    return normalizeCommitSha(
      requireCommand(run, "git", [
        "rev-parse",
        "--verify",
        `${sourceRevision}^{commit}`,
      ]).trim(),
      "Hmux release source commit",
    );
  }
}

export function exactHmuxReleaseCiProofWaitOptions(
  sourceRevision,
  repository,
  run = systemRun,
) {
  const sourceCommit = resolveSourceCommit(run, sourceRevision);
  const expectedArgs = expectedGlobalCiRunArgs(repository);
  let observedExactRuns = [];

  return {
    listProductReceipts: () =>
      observedExactRuns
        .filter(
          (record) =>
            record?.status === "completed" &&
            record?.conclusion === "success",
        )
        .slice(0, MAX_EXACT_RECEIPT_RUNS)
        .flatMap((record) =>
          exactProductReceiptRecords(run, repository, record.databaseId),
        ),
    run: (command, args, options) => {
      if (command !== "gh" || args[0] !== "run" || args[1] !== "list") {
        return run(command, args, options);
      }
      if (!sameArgs(args, expectedArgs)) {
        return failedResult(
          "hmux-release-product-proof: unexpected CI run-list command",
        );
      }
      const result = run(
        "gh",
        exactCiRunArgs(repository, sourceCommit),
        options,
      );
      observedExactRuns = parseObservedExactRuns(result, sourceCommit);
      return result;
    },
  };
}

function positiveIntegerEnvironment(name, fallback, maximum) {
  const source = process.env[name];
  const value =
    source === undefined || source === "" ? fallback : Number(source);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function canonicalScopes(values, label) {
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array`);
  }
  const selected = new Set(values);
  if (
    selected.size !== values.length ||
    values.some((value) => !ALL_VERIFICATION_SCOPES.includes(value))
  ) {
    throw new Error(`${label} must contain unique supported scopes`);
  }
  const canonical = ALL_VERIFICATION_SCOPES.filter((scope) =>
    selected.has(scope),
  );
  if (!values.every((scope, index) => scope === canonical[index])) {
    throw new Error(`${label} must be canonical`);
  }
  return canonical;
}

export function createHmuxReleaseProductProof(record) {
  const sourceCommit = normalizeCommitSha(
    record?.targetSha,
    "release source commit",
  );
  if (
    record?.relationship !== "exact" ||
    normalizeCommitSha(record?.headSha, "CI run head") !== sourceCommit
  ) {
    throw new Error("release product proof requires an exact-SHA CI run");
  }
  const ciRunId = String(record?.databaseId ?? "");
  if (!/^[1-9][0-9]*$/.test(ciRunId)) {
    throw new Error("release product proof requires a positive CI run id");
  }
  const requiredScopes = canonicalScopes(
    record.requiredScopes,
    "required release scopes",
  );
  const verificationScopes = canonicalScopes(
    record.verificationScopes,
    "observed CI scopes",
  );
  if (!verificationScopesSatisfy(requiredScopes, verificationScopes)) {
    throw new Error("CI product proof does not cover the release scopes");
  }

  return {
    ciRunId,
    requiredScopes,
    schema: HMUX_RELEASE_PRODUCT_PROOF_SCHEMA,
    sourceCommit,
    verificationScopes,
    verifiedBase: normalizeCommitSha(record.verifiedBase, "verified base"),
    verifiedHead: sourceCommit,
  };
}

async function writeProductProof(sourceRevision, outputPath) {
  if (!sourceRevision || !outputPath) {
    throw new Error("source revision and proof output path are required");
  }
  const repository = process.env.GITHUB_REPOSITORY;
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  ) {
    throw new Error("GITHUB_REPOSITORY must be an owner/repository slug");
  }
  const record = await waitForExactGreenCiProductProof(sourceRevision, {
    ...exactHmuxReleaseCiProofWaitOptions(sourceRevision, repository),
    maxPolls: positiveIntegerEnvironment(
      "DURE_HMUX_RELEASE_CI_WAIT_POLLS",
      60,
      120,
    ),
    pollIntervalMs: positiveIntegerEnvironment(
      "DURE_HMUX_RELEASE_CI_POLL_INTERVAL_MS",
      30_000,
      60_000,
    ),
    repository,
  });
  const proof = createHmuxReleaseProductProof(record);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(
    `hmux-release-product-proof: CI run ${proof.ciRunId} proves exact source ${proof.sourceCommit}\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  writeProductProof(process.argv[2], process.argv[3]).catch((error) => {
    process.stderr.write(`hmux-release-product-proof: ${error.message}\n`);
    process.exitCode = 1;
  });
}
