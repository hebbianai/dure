/**
 * Directory transaction authority shared by build-output reclaim and QA root
 * retirement. Raw paths and native output are normalized here once; callers
 * only receive exact, immutable transaction handles.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONFLICT_EXIT = 3;
const UNSUPPORTED_EXIT = 4;
const GENERATION_MISMATCH_EXIT = 6;
const TRANSACTION_BUSY_EXIT = 7;
const CLAIM_SCHEMA = "dure-directory-generation-claim/v1";
const CONTROL_DIRECTORY = ".dure-reclaim";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DECIMAL = /^\d+$/u;
const HELPER = fileURLToPath(
  new URL("../native/atomic-directory-move.py", import.meta.url),
);

export const ATOMIC_DIRECTORY_MOVE_UNSUPPORTED =
  "DURE_ATOMIC_DIRECTORY_MOVE_UNSUPPORTED";
export const DIRECTORY_GENERATION_MISMATCH =
  "DURE_DIRECTORY_GENERATION_MISMATCH";

function invoke(arguments_) {
  const result = spawnSync(
    "python3",
    ["-I", "-S", HELPER, ...arguments_],
    { encoding: "utf8", maxBuffer: 64 * 1024 },
  );
  if (result.status === 0) return result;
  const detail = result.error?.message || result.stderr?.trim();
  if (result.status === CONFLICT_EXIT) {
    const error = new Error(
      detail
        ? `atomic no-replace move refused because the destination exists: ${detail}`
        : "atomic no-replace move refused because the destination exists",
    );
    error.code = "EEXIST";
    throw error;
  }
  if (result.status === UNSUPPORTED_EXIT || result.error?.code === "ENOENT") {
    const error = new Error(
      detail || "atomic no-replace directory move is unavailable on this platform",
    );
    error.code = ATOMIC_DIRECTORY_MOVE_UNSUPPORTED;
    throw error;
  }
  if (result.status === GENERATION_MISMATCH_EXIT) {
    const error = new Error(
      detail
        ? `directory generation changed: ${detail}`
        : "directory generation changed before the atomic operation",
    );
    error.code = DIRECTORY_GENERATION_MISMATCH;
    throw error;
  }
  if (result.status === TRANSACTION_BUSY_EXIT) {
    const error = new Error(
      detail
        ? `directory transaction is active: ${detail}`
        : "directory transaction is active",
    );
    error.code = "EBUSY";
    throw error;
  }
  throw new Error(`atomic directory operation failed: ${detail || "unknown error"}`);
}

export function moveDirectoryNoReplace(source, destination) {
  invoke(["move", source, destination]);
}

function directDirectoryMetadata(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("directory generation is not a direct directory");
  }
  return metadata;
}

export function directoryIdentity(path) {
  const metadata = directDirectoryMetadata(path);
  return Object.freeze({
    device: String(metadata.dev),
    inode: String(metadata.ino),
  });
}

export function directoryGeneration(path) {
  const metadata = directDirectoryMetadata(path);
  return Object.freeze({
    device: String(metadata.dev),
    inode: String(metadata.ino),
    change: String(metadata.ctimeNs),
  });
}

function relativeDirectory(root, path) {
  const candidate = relative(root, path);
  if (
    !candidate ||
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    isAbsolute(candidate)
  ) {
    throw new Error("directory generation is outside its root");
  }
  return candidate;
}

function identityArguments(identity) {
  return [identity.device, identity.inode];
}

function generationArguments(generation) {
  return [generation.device, generation.inode, generation.change];
}

function decimalIdentity(value) {
  return (
    value &&
    typeof value.device === "string" &&
    DECIMAL.test(value.device) &&
    typeof value.inode === "string" &&
    DECIMAL.test(value.inode)
  );
}

function parseNativeValue(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new Error("directory claim returned malformed native output", { cause });
  }
  return value;
}

function parseClaim(value, root, rootIdentity, expectedTransactionId) {
  if (
    value?.schema !== CLAIM_SCHEMA ||
    !["prepared", "isolated", "removing"].includes(value?.state) ||
    !UUID.test(value?.transactionId ?? "") ||
    (expectedTransactionId && value.transactionId !== expectedTransactionId) ||
    typeof value?.source !== "string" ||
    !decimalIdentity(value?.root) ||
    value.root.device !== rootIdentity.device ||
    value.root.inode !== rootIdentity.inode ||
    !decimalIdentity(value?.target) ||
    typeof value.target.change !== "string" ||
    !DECIMAL.test(value.target.change)
  ) {
    throw new Error("directory claim returned an invalid transaction");
  }
  const path = resolve(root, value.source);
  if (relativeDirectory(root, path) !== value.source) {
    throw new Error("directory claim source is outside its root");
  }
  const transaction = join(root, CONTROL_DIRECTORY, value.transactionId);
  return Object.freeze({
    generation: Object.freeze({ ...value.target }),
    path,
    quarantine: join(transaction, "target"),
    root,
    rootGeneration: rootIdentity,
    state: value.state,
    transaction,
    transactionId: value.transactionId,
  });
}

export function claimDirectoryGeneration({
  generation,
  path,
  root,
  rootGeneration,
}) {
  const transactionId = randomUUID();
  const transaction = join(root, CONTROL_DIRECTORY, transactionId);
  const result = invoke([
    "claim",
    root,
    relativeDirectory(root, path),
    relativeDirectory(root, transaction),
    ...identityArguments(rootGeneration),
    ...generationArguments(generation),
  ]);
  return parseClaim(
    parseNativeValue(result.stdout),
    root,
    rootGeneration,
    transactionId,
  );
}

function readDirectoryGenerationClaim({
  root,
  rootGeneration,
  transaction,
  operation,
}) {
  const result = invoke([
    operation,
    root,
    relativeDirectory(root, transaction),
    ...identityArguments(rootGeneration),
  ]);
  const value = parseNativeValue(result.stdout);
  if (
    value?.schema === CLAIM_SCHEMA &&
    value?.state === "resolved" &&
    value?.transactionId === transaction.split(sep).at(-1)
  ) {
    return null;
  }
  return parseClaim(
    value,
    root,
    rootGeneration,
    transaction.split(sep).at(-1),
  );
}

export function inspectDirectoryGenerationClaim(input) {
  return readDirectoryGenerationClaim({ ...input, operation: "inspect" });
}

export function recoverDirectoryGenerationClaim(input) {
  return readDirectoryGenerationClaim({ ...input, operation: "recover" });
}

function collectDirectoryGenerationClaims(root, rootGeneration, readClaim) {
  const control = join(root, CONTROL_DIRECTORY);
  let entries;
  try {
    entries = readdirSync(control, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { claims: [], conflicts: [] };
    return {
      claims: [],
      conflicts: [{ transaction: control, reason: error.message }],
    };
  }
  const claims = [];
  const conflicts = [];
  for (const entry of entries) {
    const transaction = join(control, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      conflicts.push({ transaction, reason: "claim entry is not a direct directory" });
      continue;
    }
    try {
      const claim = readClaim({
        root,
        rootGeneration,
        transaction,
      });
      if (claim) claims.push(claim);
    } catch (error) {
      conflicts.push({ transaction, reason: error.message });
    }
  }
  return { claims, conflicts };
}

export function inspectDirectoryGenerationClaims(root, rootGeneration) {
  return collectDirectoryGenerationClaims(
    root,
    rootGeneration,
    inspectDirectoryGenerationClaim,
  );
}

export function recoverDirectoryGenerationClaims(root, rootGeneration) {
  return collectDirectoryGenerationClaims(
    root,
    rootGeneration,
    recoverDirectoryGenerationClaim,
  );
}

export function restoreDirectoryGeneration(claim) {
  try {
    invoke([
      "restore",
      claim.root,
      relativeDirectory(claim.root, claim.transaction),
      ...identityArguments(claim.rootGeneration),
    ]);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

export function removeDirectoryGeneration(claim) {
  invoke([
    "remove",
    claim.root,
    relativeDirectory(claim.root, claim.transaction),
    ...identityArguments(claim.rootGeneration),
  ]);
}

export const directoryGenerationAuthority = Object.freeze({
  claim: claimDirectoryGeneration,
  inspect: inspectDirectoryGenerationClaims,
  recover: recoverDirectoryGenerationClaims,
  remove: removeDirectoryGeneration,
  restore: restoreDirectoryGeneration,
});
