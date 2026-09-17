import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadVerificationReceipt,
  productReceiptRecords,
  receiptMatchesRun,
  validatedCompleteVerificationReceipts,
  verificationScopesSatisfy,
} from "./ci-verification-receipt.mjs";
import {
  classifyNullDelimitedGitDiff,
  gitDiffNameOnlyArgs,
  parseNullDelimitedGitPaths,
  PUSH_GATE_SCOPES,
} from "./push-gate-scope.mjs";

const DEFAULT_REPOSITORY = "hebbianai/HebbianIDE";
const FULL_SHA = /^[0-9a-f]{40}$/i;

function systemRun(command, args, options = {}) {
  const binaryOutput =
    options.encoding === "buffer" ||
    (command === "git" && (args[0] === "diff" || args[0] === "diff-tree"));
  const result = spawnSync(
    command,
    args,
    binaryOutput
      ? { maxBuffer: options.maxBuffer }
      : { encoding: "utf8", maxBuffer: options.maxBuffer },
  );
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

function commandFailure(command, args, result) {
  const detail =
    result.error?.message ||
    outputText(result.stderr).trim() ||
    "unknown command failure";
  return new Error(
    `wait-ci-green: ${command} ${args.join(" ")} failed: ${detail}`,
  );
}

function requireCommand(run, command, args) {
  const result = run(command, args);
  if (result.status !== 0) {
    throw commandFailure(command, args, result);
  }
  return result.stdout;
}

function positiveInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`wait-ci-green: ${name} must be a positive integer`);
  }
  return resolved;
}

function nonNegativeInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`wait-ci-green: ${name} must be a non-negative integer`);
  }
  return resolved;
}

function integerEnvironment(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`wait-ci-green: ${name} must be an integer`);
  }
  return parsed;
}

function resolveCommit(run, revision) {
  const sha = requireCommand(run, "git", [
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]).trim();
  if (!FULL_SHA.test(sha)) {
    throw new Error(`wait-ci-green: git resolved an invalid commit: ${sha}`);
  }
  return sha.toLowerCase();
}

function isAncestor(run, ancestor, descendant) {
  const args = ["merge-base", "--is-ancestor", ancestor, descendant];
  const result = run("git", args);
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw commandFailure("git", args, result);
}

function listCiRuns(run, repository) {
  const output = requireCommand(run, "gh", [
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
    "databaseId,headSha,status,conclusion,url",
  ]);
  let records;
  try {
    records = JSON.parse(output);
  } catch (error) {
    throw new Error(`wait-ci-green: gh returned invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(records)) {
    throw new Error("wait-ci-green: gh run list did not return an array");
  }
  return records;
}

function isGreen(record) {
  return record.status === "completed" && record.conclusion === "success";
}

function requiredScopesForCommit(run, targetSha) {
  try {
    const output = requireCommand(run, "git", [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--no-renames",
      "--name-only",
      "-z",
      "-r",
      targetSha,
      "--",
    ]);
    return classifyNullDelimitedGitDiff(output);
  } catch {
    return [...PUSH_GATE_SCOPES];
  }
}

function changedPathsBetween(run, base, head) {
  const args = gitDiffNameOnlyArgs(base, head);
  return parseNullDelimitedGitPaths(requireCommand(run, "git", args));
}

function exactRunSummary(records, targetSha) {
  const exact = records.filter(
    (record) => record.headSha?.toLowerCase() === targetSha,
  );
  if (exact.length === 0) {
    return "not registered";
  }
  return exact
    .map(
      (record) =>
        `${record.databaseId ?? "unknown"}:${record.status ?? "unknown"}/${
          record.conclusion ?? "pending"
        }`,
    )
    .join(", ");
}

function bindProductArtifacts(records, artifacts) {
  if (!Array.isArray(artifacts)) {
    return [];
  }
  const artifactsByRun = new Map(
    artifacts.map((artifact) => [String(artifact.databaseId), artifact]),
  );
  return records.flatMap((record) => {
    const artifact = artifactsByRun.get(String(record.databaseId));
    if (
      !artifact ||
      !/^[1-9][0-9]*$/.test(String(artifact.artifactId ?? "")) ||
      typeof artifact.headSha !== "string" ||
      artifact.headSha.toLowerCase() !== record.headSha?.toLowerCase()
    ) {
      return [];
    }
    return [{ ...record, artifactId: artifact.artifactId }];
  });
}

async function successfulContainingRun({
  allowDescendants,
  completeReceipts,
  records,
  requiredScopes,
  run,
  targetSha,
}) {
  const completeByRunId = new Map(
    completeReceipts.map((candidate) => [
      String(candidate.record.databaseId),
      candidate,
    ]),
  );
  const candidates = [
    ...records
      .filter(
        (record) =>
          record.headSha?.toLowerCase() === targetSha && isGreen(record),
      )
      .map((record) => ({ record, relationship: "exact" })),
    ...(allowDescendants
      ? records
          .filter(
            (record) =>
              record.headSha?.toLowerCase() !== targetSha && isGreen(record),
          )
          .map((record) => ({ record, relationship: "descendant" }))
      : []),
  ];

  for (const { record, relationship } of candidates) {
    if (!isGreen(record) || !FULL_SHA.test(record.headSha ?? "")) {
      continue;
    }
    const completeCandidate = completeByRunId.get(String(record.databaseId));
    if (!completeCandidate) {
      continue;
    }
    const candidate = record.headSha.toLowerCase();
    if (relationship === "descendant") {
      const exists = run("git", ["cat-file", "-e", `${candidate}^{commit}`]);
      if (
        exists.status !== 0 ||
        !isAncestor(run, targetSha, candidate) ||
        !isAncestor(run, candidate, "origin/main")
      ) {
        continue;
      }
    }

    try {
      const { observedScopes, receipt } = completeCandidate;
      const isAllScopesReceipt = verificationScopesSatisfy(
        PUSH_GATE_SCOPES,
        observedScopes,
      );
      if (
        !receiptMatchesRun(receipt, record) ||
        !isAncestor(run, receipt.verifiedBase, receipt.verifiedHead) ||
        (!isAllScopesReceipt &&
          !isAncestor(run, receipt.verifiedBase, targetSha)) ||
        !verificationScopesSatisfy(requiredScopes, observedScopes)
      ) {
        continue;
      }
      return {
        ...record,
        relationship,
        requiredScopes,
        targetSha,
        verificationScopes: observedScopes,
        verifiedBase: receipt.verifiedBase,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function waitForCiProductProof(
  targetRevision,
  { allowDescendants, failFastExact, ...options },
) {
  const run = options.run ?? systemRun;
  const delay =
    options.delay ??
    ((milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const maxPolls = positiveInteger(
    options.maxPolls,
    integerEnvironment("HEBBIAN_CI_WAIT_POLLS", 40),
    "maxPolls",
  );
  const pollIntervalMs = nonNegativeInteger(
    options.pollIntervalMs,
    integerEnvironment("HEBBIAN_CI_POLL_INTERVAL_MS", 30_000),
    "pollIntervalMs",
  );
  const repository =
    options.repository ?? process.env.HEBBIAN_REPO ?? DEFAULT_REPOSITORY;
  const targetSha = resolveCommit(run, targetRevision);
  const verificationHeadRevision =
    options.verificationHeadRevision ?? "origin/main";
  const fetchOriginMain = options.fetchOriginMain ?? true;
  const requiredScopes = requiredScopesForCommit(run, targetSha);
  const defaultLoadReceipt = (record) =>
    downloadVerificationReceipt(run, repository, record);
  const loadReceipt = options.loadReceipt ?? defaultLoadReceipt;
  const listProductReceipts =
    options.listProductReceipts ??
    (() =>
      productReceiptRecords(repository, (args) =>
        requireCommand(run, "gh", args),
      ));
  let summary = "not registered";

  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (fetchOriginMain) {
      requireCommand(run, "git", [
        "fetch",
        "--quiet",
        "origin",
        "main:refs/remotes/origin/main",
      ]);
    }
    const verificationHead = resolveCommit(run, verificationHeadRevision);
    const ancestryRevision = fetchOriginMain
      ? verificationHeadRevision
      : verificationHead;
    if (
      targetSha !== verificationHead &&
      !isAncestor(run, targetSha, ancestryRevision)
    ) {
      throw new Error(
        `wait-ci-green: ${targetSha} is not an ancestor of ${verificationHeadRevision}`,
      );
    }

    const records = listCiRuns(run, repository);
    summary = exactRunSummary(records, targetSha);
    let candidateRecords = records;
    let receiptRecords = records;
    let proofReceiptLoader = loadReceipt;
    if (failFastExact) {
      const exact = records.filter(
        (record) => record.headSha?.toLowerCase() === targetSha,
      );
      const greenExact = exact.filter(isGreen);
      if (greenExact.length === 0) {
        if (
          exact.length > 0 &&
          exact.every((record) => record.status === "completed")
        ) {
          throw new Error(
            `wait-ci-green: completed exact CI did not publish valid green product proof for ${targetSha} (exact runs: ${summary})`,
          );
        }
        if (poll + 1 < maxPolls) {
          await delay(pollIntervalMs);
          continue;
        }
        candidateRecords = [];
        receiptRecords = [];
      } else if (options.loadReceipt) {
        candidateRecords = greenExact;
        receiptRecords = records.filter(isGreen);
      } else {
        let artifacts = [];
        try {
          artifacts = listProductReceipts();
        } catch {
          // Missing artifact metadata cannot authorize a release.
        }
        candidateRecords = bindProductArtifacts(greenExact, artifacts);
        receiptRecords = candidateRecords.length > 0 ? artifacts : [];
        proofReceiptLoader = (record) =>
          record.artifactId ? defaultLoadReceipt(record) : null;
      }
    }
    const completeReceipts = await validatedCompleteVerificationReceipts({
      changedPaths: (base, head) => changedPathsBetween(run, base, head),
      head: verificationHead,
      isAncestor: (ancestor, descendant) =>
        isAncestor(run, ancestor, descendant),
      loadReceipt: proofReceiptLoader,
      records: receiptRecords,
    });
    const green = await successfulContainingRun({
      allowDescendants,
      completeReceipts,
      records: candidateRecords,
      requiredScopes,
      run,
      targetSha,
    });
    if (green) {
      return green;
    }

    if (failFastExact) {
      const exact = records.filter(
        (record) => record.headSha?.toLowerCase() === targetSha,
      );
      if (
        exact.length > 0 &&
        exact.every((record) => record.status === "completed")
      ) {
        throw new Error(
          `wait-ci-green: completed exact CI did not publish valid green product proof for ${targetSha} (exact runs: ${summary})`,
        );
      }
    }

    if (poll + 1 < maxPolls) {
      await delay(pollIntervalMs);
    }
  }

  throw new Error(
    `wait-ci-green: no CI run covering ${JSON.stringify(requiredScopes)} containing ${targetSha} after ${maxPolls} polls (exact runs: ${summary})`,
  );
}

export async function waitForGreenCi(targetRevision, options = {}) {
  return waitForCiProductProof(targetRevision, {
    ...options,
    allowDescendants: true,
    failFastExact: false,
  });
}

export async function waitForExactGreenCiProductProof(
  targetRevision,
  options = {},
) {
  return waitForCiProductProof(targetRevision, {
    ...options,
    allowDescendants: false,
    failFastExact: true,
    fetchOriginMain: false,
    verificationHeadRevision: targetRevision,
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  waitForGreenCi(process.argv[2])
    .then((record) => {
      const relation =
        record.relationship === "exact"
          ? "exact commit"
          : "git-proven descendant";
      process.stdout.write(
        `wait-ci-green: CI run ${record.databaseId} is green for ${relation} ${record.headSha} ` +
          `(${JSON.stringify(record.verificationScopes)} satisfies ${JSON.stringify(record.requiredScopes)}); target ${record.targetSha}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
