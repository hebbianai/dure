#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATOMIC_DIRECTORY_MOVE_UNSUPPORTED,
  moveDirectoryNoReplace,
} from "../../lib/atomic-directory-move.mjs";
import {
  isProcessStartMarkerV1,
  ownedProcessGenerationDigestV1,
  parsePersistedKernelStartMarkerV1,
} from "./owned-process-persistence-v1.mjs";

const SCHEMA = "dure-qa-root-retirement/v2";
const LEGACY_SCHEMA = "dure-qa-root-retirement/v1";
const REAP_RECEIPT_SCHEMA = "dure-qa-hmux-reap/v1";
const PROCESS_EXIT_RECEIPT_SCHEMA = "dure-qa-owned-process-exit/v1";
const HARD_PROCESS_CONTAINMENT = "hard_process_containment_v2";
const UNSUPPORTED_CONTAINMENT = "DURE_QA_ROOT_RETIREMENT_UNSUPPORTED";
const UNSUPPORTED_MOVE = "DURE_QA_ROOT_RETIREMENT_UNSUPPORTED_MOVE";
const UNREACHABLE_RETIREMENT = "DURE_QA_ROOT_RETIREMENT_UNREACHABLE";
const HARD_CONTAINMENT_KINDS = new Map([
  ["linux", "linux-pidfd-subreaper-v1"],
]);
const REQUIRED_PROCESS_DESCRIPTORS = new Set([
  "app-process-group.json",
  "client-process-group.json",
]);
const MAX_JOURNAL_BYTES = 64 * 1024;
const LEGACY_JOURNAL_STATES = new Set([
  "prepared",
  "renaming",
  "renamed",
  "deleting",
  "deleted",
]);
const QUARANTINE_OWNING_STATES = new Set([
  "renaming",
  "renamed",
  "deleting",
]);

function retirementError(message, journal, preservedPath, cause) {
  const detail =
    cause instanceof Error && cause.message ? `; cause=${cause.message}` : "";
  const error = new Error(
    `isolated_root_retirement_failed: ${message}; journal=${journal}; preserved=${preservedPath}${detail}`,
    cause === undefined ? undefined : { cause },
  );
  if (cause?.code === UNREACHABLE_RETIREMENT) {
    error.code = cause.code;
  } else if (
    cause?.code === ATOMIC_DIRECTORY_MOVE_UNSUPPORTED ||
    cause?.code === UNSUPPORTED_MOVE
  ) {
    error.code = UNSUPPORTED_MOVE;
  }
  return error;
}

function moveRetirementRoot(source, destination) {
  try {
    moveDirectoryNoReplace(source, destination);
  } catch (cause) {
    if (cause?.code !== ATOMIC_DIRECTORY_MOVE_UNSUPPORTED) throw cause;
    const error = new Error(cause.message, { cause });
    error.code = UNSUPPORTED_MOVE;
    throw error;
  }
}

function unreachableRetirementError() {
  const error = new Error(
    "isolated_root_retirement_failed: exact root generation is unreachable",
  );
  error.code = UNREACHABLE_RETIREMENT;
  return error;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function stageDurableJson(destination, value) {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return temporary;
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function writeExclusiveJson(destination, value) {
  const temporary = stageDurableJson(destination, value);
  try {
    fs.linkSync(temporary, destination);
    fsyncDirectory(path.dirname(destination));
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeAtomicJson(destination, value) {
  const temporary = stageDurableJson(destination, value);
  try {
    fs.renameSync(temporary, destination);
    fsyncDirectory(path.dirname(destination));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function trustedTemporaryBoundary(boundary) {
  const requested = path.resolve(boundary);
  const resolved = fs.realpathSync(requested);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      "isolated_root_retirement_failed: temporary boundary is not a direct directory",
    );
  }
  return resolved;
}

function assertRetirableRoot(
  root,
  temporaryBoundary = trustedTemporaryBoundary(os.tmpdir()),
) {
  const requested = path.resolve(root);
  const requestedStat = fs.lstatSync(requested);
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    throw new Error("isolated_root_retirement_failed: root is not a direct directory");
  }
  const resolved = fs.realpathSync(requested);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("isolated_root_retirement_failed: root is not a direct directory");
  }
  const uid = process.getuid?.();
  if (
    fs.realpathSync(path.dirname(resolved)) !== temporaryBoundary ||
    !["dure-", "hebbian-"].some((prefix) =>
      path.basename(resolved).startsWith(prefix),
    ) ||
    (stat.mode & 0o7777) !== 0o700 ||
    (uid !== undefined && stat.uid !== uid)
  ) {
    throw new Error("isolated_root_retirement_failed: root is outside the QA temp boundary");
  }
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    path: resolved,
  };
}

export function authorizeIsolatedRootRetirement(
  root,
  temporaryBoundary = os.tmpdir(),
) {
  const boundary = trustedTemporaryBoundary(temporaryBoundary);
  return {
    ...assertRetirableRoot(root, boundary),
    temporaryBoundary: boundary,
  };
}

function prepareJournalDirectory(journalRoot, target, temporaryBoundary) {
  const requested = path.resolve(journalRoot);
  const requestedParent = fs.realpathSync(path.dirname(requested));
  const canonicalRequested = path.join(
    requestedParent,
    path.basename(requested),
  );
  if (
    requestedParent !== temporaryBoundary ||
    canonicalRequested === target ||
    canonicalRequested.startsWith(`${target}${path.sep}`) ||
    canonicalRequested === temporaryBoundary
  ) {
    throw new Error(
      "isolated_root_retirement_failed: journal directory must be outside the retired root and inside its temporary boundary",
    );
  }
  fs.mkdirSync(canonicalRequested, { mode: 0o700, recursive: true });
  const resolved = fs.realpathSync(canonicalRequested);
  if (
    resolved === target ||
    resolved.startsWith(`${target}${path.sep}`) ||
    !resolved.startsWith(`${temporaryBoundary}${path.sep}`)
  ) {
    throw new Error(
      "isolated_root_retirement_failed: journal directory resolved outside its retirement boundary",
    );
  }
  const stat = fs.lstatSync(resolved);
  const uid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (uid !== undefined && stat.uid !== uid)
  ) {
    throw new Error(
      "isolated_root_retirement_failed: journal directory is not owner-controlled",
    );
  }
  fs.chmodSync(resolved, 0o700);
  return resolved;
}

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function rootGenerationAt(target, expected) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    throw error;
  }
  return stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    String(stat.dev) === expected.device &&
    String(stat.ino) === expected.inode
    ? "exact"
    : "foreign";
}

export function assertSameRootGeneration(target, expected) {
  const generation = rootGenerationAt(target, expected);
  if (generation === "absent") fs.lstatSync(target);
  if (generation !== "exact") {
    throw new Error(
      "isolated_root_retirement_failed: root generation changed before deletion",
    );
  }
}

function parseReceipt(receiptJson, label) {
  let receipt;
  try {
    receipt = JSON.parse(receiptJson);
  } catch (cause) {
    throw new Error(
      `isolated_root_retirement_failed: malformed ${label} receipt`,
      { cause },
    );
  }
  return receipt;
}

function parseVerifiedRootIdentity(receiptJson) {
  const receipt = parseReceipt(receiptJson, "Hmux cleanup");
  const identity = receipt?.stateRootIdentity;
  if (
    receipt?.schema !== REAP_RECEIPT_SCHEMA ||
    typeof identity?.device !== "string" ||
    !/^\d+$/u.test(identity.device) ||
    typeof identity?.inode !== "string" ||
    !/^\d+$/u.test(identity.inode)
  ) {
    throw new Error(
      "isolated_root_retirement_failed: invalid Hmux cleanup generation receipt",
    );
  }
  return { device: identity.device, inode: identity.inode };
}

function sameIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode;
}

function retirementTransactionId(target) {
  const digest = crypto
    .createHash("sha256")
    .update(`${target.path}\0${target.device}\0${target.inode}`)
    .digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

function verifiedReceiptIdentity(value, label) {
  if (
    typeof value?.device !== "string" ||
    !/^\d+$/u.test(value.device) ||
    typeof value?.inode !== "string" ||
    !/^\d+$/u.test(value.inode)
  ) {
    throw new Error(
      `isolated_root_retirement_failed: invalid ${label} identity`,
    );
  }
  return { device: value.device, inode: value.inode };
}

function verifiedProcessIdentity(value, label, platform) {
  const kernelMarker = parsePersistedKernelStartMarkerV1(
    value?.kernelStartMarker,
  );
  const kernelMarkerIsExact = kernelMarker?.kind === "exact" &&
    ((platform === "darwin" &&
      kernelMarker.processIdentity.startsWith("kernel-start-v3:macos:")) ||
      (platform === "linux" &&
        kernelMarker.processIdentity.startsWith("linux:")));
  if (
    !Number.isSafeInteger(value?.pid) ||
    value.pid <= 1 ||
    !isProcessStartMarkerV1(value?.startMarker) ||
    typeof value?.kernelStartMarker !== "string" ||
    !kernelMarkerIsExact
  ) {
    throw new Error(
      platform === "linux"
        ? "isolated_root_retirement_failed: boot-bound Linux process generation is required"
        : `isolated_root_retirement_failed: invalid ${label} process identity`,
    );
  }
  return value;
}

function assertReceiptFile(root, name, identity, label) {
  const file = path.join(root.path, name);
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    String(stat.dev) !== identity.device ||
    String(stat.ino) !== identity.inode
  ) {
    throw new Error(
      `isolated_root_retirement_failed: ${label} generation changed after exit verification`,
    );
  }
  return { file, stat };
}

function verifyReceiptLedger(
  root,
  descriptorName,
  ownedGenerations,
  receiptDescriptor,
  leader,
  supervisor,
  hardContainmentKind,
) {
  const ledgerIdentity = verifiedReceiptIdentity(
    ownedGenerations.ledgerIdentity,
    "ownership ledger",
  );
  const { file, stat } = assertReceiptFile(
    root,
    `${descriptorName}.ownership-ledger.json`,
    ledgerIdentity,
    "ownership ledger",
  );
  if (stat.size <= 0 || stat.size > 64 * 1024 * 1024) {
    throw new Error(
      "isolated_root_retirement_failed: ownership ledger size is invalid",
    );
  }
  const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    ledger?.schemaVersion !== 1 ||
    ledger?.healthy !== true ||
    ledger?.groupId !== receiptDescriptor.groupId ||
    ledger?.hardContainmentKind !== hardContainmentKind ||
    ledger?.leaderKernelStartMarker !== leader.kernelStartMarker ||
    ledger?.leaderStartMarker !== leader.startMarker ||
    ledger?.livenessWitnessVersion !== "inherited-fd-v1" ||
    ledger?.supervisorPid !== supervisor.pid ||
    ledger?.supervisorKernelStartMarker !== supervisor.kernelStartMarker ||
    ledger?.supervisorStartMarker !== supervisor.startMarker ||
    ledger?.terminateDetachedOwnedGenerations !== true ||
    !Array.isArray(ledger?.processes) ||
    ledger.processes.length !== ownedGenerations.count ||
    ledger.processes.length > 32_768 ||
    ownedProcessGenerationDigestV1(ledger.processes) !==
      ownedGenerations.digest
  ) {
    throw new Error(
      "isolated_root_retirement_failed: ownership ledger no longer matches its exit receipt",
    );
  }
}

function verifyReceiptDescriptor(
  root,
  descriptorName,
  descriptorIdentity,
  receiptDescriptor,
  leader,
  supervisor,
  hardContainmentKind,
) {
  const { file, stat } = assertReceiptFile(
    root,
    descriptorName,
    descriptorIdentity,
    "process descriptor",
  );
  if (stat.size <= 0 || stat.size > 64 * 1024) {
    throw new Error(
      "isolated_root_retirement_failed: process descriptor size is invalid",
    );
  }
  const descriptor = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    descriptor?.schemaVersion !== 1 ||
    descriptor?.livenessWitnessVersion !== "inherited-fd-v1" ||
    descriptor?.terminateDetachedOwnedGenerations !== true ||
    descriptor?.hardContainmentKind !== hardContainmentKind ||
    descriptor?.groupId !== receiptDescriptor.groupId ||
    descriptor?.leaderPid !== leader.pid ||
    descriptor?.leaderStartMarker !== leader.startMarker ||
    descriptor?.leaderKernelStartMarker !== leader.kernelStartMarker ||
    descriptor?.supervisorPid !== supervisor.pid ||
    descriptor?.supervisorStartMarker !== supervisor.startMarker ||
    descriptor?.supervisorKernelStartMarker !== supervisor.kernelStartMarker
  ) {
    throw new Error(
      "isolated_root_retirement_failed: process descriptor no longer matches its exit receipt",
    );
  }
}

function verifyProcessExitReceipt(root, receiptJson) {
  const receipt = parseReceipt(receiptJson, "owned process exit");
  const descriptor = receipt?.descriptor;
  const descriptorName = descriptor?.name;
  if (receipt?.schema !== PROCESS_EXIT_RECEIPT_SCHEMA) {
    throw new Error(
      "isolated_root_retirement_failed: invalid process exit receipt schema",
    );
  }
  const hardContainmentKind = HARD_CONTAINMENT_KINDS.get(receipt.platform);
  if (
    receipt.capability !== HARD_PROCESS_CONTAINMENT ||
    !hardContainmentKind ||
    receipt?.hardContainment?.kind !== hardContainmentKind ||
    receipt?.hardContainment?.generationAtomicSignals !== true
  ) {
    const error = new Error(
      "isolated_root_retirement_unsupported: process containment is not generation-atomic",
    );
    error.code = UNSUPPORTED_CONTAINMENT;
    throw error;
  }
  if (
    !REQUIRED_PROCESS_DESCRIPTORS.has(descriptorName) ||
    !sameIdentity(
      verifiedReceiptIdentity(
        receipt?.stateRootIdentity,
        "process state root",
      ),
      root,
    ) ||
    !Number.isSafeInteger(descriptor?.groupId) ||
    descriptor.groupId <= 1 ||
    !Number.isSafeInteger(receipt?.ownedGenerations?.count) ||
    receipt.ownedGenerations.count <= 0 ||
    receipt.ownedGenerations.count > 32_768 ||
    typeof receipt?.ownedGenerations?.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receipt.ownedGenerations.digest)
  ) {
    throw new Error(
      "isolated_root_retirement_failed: incomplete hard process containment receipt",
    );
  }
  const descriptorIdentity = verifiedReceiptIdentity(
    descriptor.identity,
    "process descriptor",
  );
  const leader = verifiedProcessIdentity(
    descriptor.leader,
    "process leader",
    receipt.platform,
  );
  const supervisor = verifiedProcessIdentity(
    descriptor.supervisor,
    "process supervisor",
    receipt.platform,
  );
  if (leader.pid !== descriptor.groupId) {
    throw new Error(
      "isolated_root_retirement_failed: process leader does not match its group",
    );
  }
  verifyReceiptDescriptor(
    root,
    descriptorName,
    descriptorIdentity,
    descriptor,
    leader,
    supervisor,
    hardContainmentKind,
  );
  verifyReceiptLedger(
    root,
    descriptorName,
    receipt.ownedGenerations,
    descriptor,
    leader,
    supervisor,
    hardContainmentKind,
  );
  return descriptorName;
}

export function verifiedRetirementIdentityFromReceipts(
  root,
  hmuxCleanupReceipt,
  processExitReceipts,
) {
  const target = assertRetirableRoot(root);
  const hmuxIdentity = parseVerifiedRootIdentity(hmuxCleanupReceipt);
  if (!sameIdentity(target, hmuxIdentity)) {
    throw new Error(
      "isolated_root_retirement_failed: Hmux receipt names another root generation",
    );
  }
  if (!Array.isArray(processExitReceipts) || processExitReceipts.length !== 2) {
    throw new Error(
      "isolated_root_retirement_failed: two process containment receipts are required",
    );
  }
  const descriptors = new Set(
    processExitReceipts.map((receipt) =>
      verifyProcessExitReceipt(target, receipt),
    ),
  );
  if (
    descriptors.size !== REQUIRED_PROCESS_DESCRIPTORS.size ||
    [...REQUIRED_PROCESS_DESCRIPTORS].some(
      (descriptor) => !descriptors.has(descriptor),
    )
  ) {
    throw new Error(
      "isolated_root_retirement_failed: process containment receipts do not cover the QA owners",
    );
  }
  return { device: target.device, inode: target.inode };
}

function readRetirementJournal(journal) {
  const resolved = path.resolve(journal);
  const stat = fs.lstatSync(resolved);
  const uid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > MAX_JOURNAL_BYTES ||
    (uid !== undefined && stat.uid !== uid)
  ) {
    throw new Error("isolated_root_retirement_failed: invalid recovery journal");
  }
  const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const transactionId = value?.transactionId;
  const target = value?.target;
  if (
    (value?.schema !== SCHEMA && value?.schema !== LEGACY_SCHEMA) ||
    (value?.schema === SCHEMA
      ? value?.state !== undefined
      : !LEGACY_JOURNAL_STATES.has(value?.state)) ||
    typeof transactionId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(transactionId) ||
    path.basename(resolved) !== `${transactionId}.json` ||
    typeof target?.path !== "string" ||
    typeof target?.device !== "string" ||
    !/^\d+$/u.test(target.device) ||
    typeof target?.inode !== "string" ||
    !/^\d+$/u.test(target.inode) ||
    (value.schema === SCHEMA
      ? typeof value.temporaryBoundary !== "string"
      : value.temporaryBoundary !== undefined &&
        typeof value.temporaryBoundary !== "string")
  ) {
    throw new Error("isolated_root_retirement_failed: malformed recovery journal");
  }
  const hasExplicitBoundary = value.temporaryBoundary !== undefined;
  const temporaryBoundary = trustedTemporaryBoundary(
    hasExplicitBoundary ? value.temporaryBoundary : os.tmpdir(),
  );
  const targetPath = path.resolve(target.path);
  const journalRoot = fs.realpathSync(path.dirname(resolved));
  if (
    target.path !== targetPath ||
    path.dirname(targetPath) !== temporaryBoundary ||
    journalRoot === targetPath ||
    journalRoot.startsWith(`${targetPath}${path.sep}`) ||
    (hasExplicitBoundary &&
      (value.temporaryBoundary !== temporaryBoundary ||
        path.dirname(resolved) !== journalRoot ||
        journalRoot === temporaryBoundary ||
        !journalRoot.startsWith(`${temporaryBoundary}${path.sep}`))) ||
    !["dure-", "hebbian-"].some((prefix) =>
      path.basename(targetPath).startsWith(prefix),
    ) ||
    value.quarantine !== `${targetPath}.retiring-${transactionId}`
  ) {
    throw new Error("isolated_root_retirement_failed: unsafe recovery boundary");
  }
  if (
    value.schema === SCHEMA &&
    transactionId !==
      retirementTransactionId({ ...target, path: targetPath })
  ) {
    throw new Error(
      "isolated_root_retirement_failed: malformed target reservation",
    );
  }
  return {
    ...value,
    journal: resolved,
    quarantine: value.quarantine,
    target: { ...target, path: targetPath },
    ...(hasExplicitBoundary ? { temporaryBoundary } : {}),
  };
}

function reserveRetirementJournal(transaction) {
  const { journal, ...record } = transaction;
  while (!writeExclusiveJson(journal, record)) {
    let existing;
    try {
      existing = readRetirementJournal(journal);
    } catch (error) {
      if (error?.code === "ENOENT") {
        const targetGeneration = rootGenerationAt(
          record.target.path,
          record.target,
        );
        const quarantineGeneration = rootGenerationAt(
          record.quarantine,
          record.target,
        );
        if (
          targetGeneration === "exact" ||
          quarantineGeneration === "exact"
        ) continue;
        if (
          targetGeneration === "absent" &&
          quarantineGeneration === "absent"
        ) return undefined;
        throw unreachableRetirementError();
      }
      throw error;
    }
    if (existing.schema !== SCHEMA) {
      throw new Error(
        "isolated_root_retirement_failed: target reservation identity collision",
      );
    }
    return existing;
  }
  return transaction;
}

function retirementJournalFiles(journalRoot) {
  const root = fs.realpathSync(path.resolve(journalRoot));
  const stat = fs.lstatSync(root);
  const uid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (uid !== undefined && stat.uid !== uid)
  ) {
    throw new Error(
      "isolated_root_retirement_failed: recovery directory is not owner-controlled",
    );
  }
  const journals = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".json"));
  return journals.map((entry) => path.join(root, entry.name));
}

function scanRetirementIntents(journalRoot, target) {
  let match;
  for (const journal of retirementJournalFiles(journalRoot)) {
    let transaction;
    try {
      transaction = readRetirementJournal(journal);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (
      !sameIdentity(target, transaction.target) ||
      (target.path !== transaction.target.path &&
        target.path !== transaction.quarantine)
    ) continue;
    if (match) {
      throw new Error(
        "isolated_root_retirement_failed: multiple journals reserve one target generation",
      );
    }
    match = transaction;
  }
  return match;
}

function convergeRetirementIntent(
  transaction,
  onBoundary,
  onState = () => {},
) {
  const paths = {
    journal: transaction.journal,
    quarantine: transaction.quarantine,
    target: transaction.target.path,
  };
  let changed = false;
  const complete = () => {
    onState("deleted");
    onBoundary("after_delete", paths);
    fs.rmSync(transaction.journal, { force: true });
    fsyncDirectory(path.dirname(transaction.journal));
    return { changed };
  };
  const releaseUnreachable = () => {
    fs.rmSync(transaction.journal, { force: true });
    fsyncDirectory(path.dirname(transaction.journal));
    throw unreachableRetirementError();
  };
  while (true) {
    const targetGeneration = rootGenerationAt(
      transaction.target.path,
      transaction.target,
    );
    const quarantineGeneration = rootGenerationAt(
      transaction.quarantine,
      transaction.target,
    );
    if (targetGeneration === "exact" && quarantineGeneration !== "absent") {
      throw new Error(
        "isolated_root_retirement_failed: target and quarantine both exist during recovery",
      );
    }
    if (targetGeneration === "exact") {
      onState("renaming");
      onBoundary("before_rename", paths);
      try {
        moveRetirementRoot(
          transaction.target.path,
          transaction.quarantine,
        );
      } catch (error) {
        if (
          rootGenerationAt(transaction.target.path, transaction.target) !==
          "exact"
        ) {
          continue;
        }
        throw error;
      }
      fsyncDirectory(path.dirname(transaction.target.path));
      changed = true;
      onBoundary("after_move", paths);
      const movedGeneration = rootGenerationAt(
        transaction.quarantine,
        transaction.target,
      );
      if (movedGeneration === "foreign") {
        releaseUnreachable();
      }
      if (movedGeneration === "exact") {
        onState("renamed");
        onBoundary("after_rename", paths);
      }
      continue;
    }
    if (quarantineGeneration === "exact") {
      onState("deleting");
      onBoundary("before_delete", paths);
      try {
        fs.rmSync(transaction.quarantine, { recursive: true });
      } catch (error) {
        const remaining = rootGenerationAt(
          transaction.quarantine,
          transaction.target,
        );
        if (remaining === "absent") return complete();
        if (remaining === "foreign") releaseUnreachable();
        throw error;
      }
      fsyncDirectory(path.dirname(transaction.quarantine));
      changed = true;
      onBoundary("after_remove", paths);
      return complete();
    }
    if (targetGeneration === "foreign" || quarantineGeneration === "foreign") {
      releaseUnreachable();
    }
    return complete();
  }
}

function recoverLegacyRetirementJournal(transaction, onBoundary) {
  const targetGeneration = rootGenerationAt(
    transaction.target.path,
    transaction.target,
  );
  const quarantineGeneration = rootGenerationAt(
    transaction.quarantine,
    transaction.target,
  );
  if (targetGeneration !== "absent") {
    assertSameRootGeneration(transaction.target.path, transaction.target);
    if (quarantineGeneration !== "absent") {
      throw new Error(
        "isolated_root_retirement_failed: target and quarantine both exist during recovery",
      );
    }
    return { journal: transaction.journal, state: "preserved" };
  }
  if (quarantineGeneration === "foreign") {
    assertSameRootGeneration(transaction.quarantine, transaction.target);
  }
  const { journal, ...record } = transaction;
  if (quarantineGeneration === "exact") {
    if (!QUARANTINE_OWNING_STATES.has(transaction.state)) {
      throw new Error(
        "isolated_root_retirement_failed: journal state cannot own its quarantine",
      );
    }
    writeAtomicJson(journal, {
      ...record,
      state: "deleting",
      updatedAtMs: Date.now(),
    });
    onBoundary("after_deleting_journal", {
      journal,
      quarantine: transaction.quarantine,
    });
    fs.rmSync(transaction.quarantine, { recursive: true });
    fsyncDirectory(path.dirname(transaction.quarantine));
  } else if (
    !["prepared", "renaming", "deleting", "deleted"].includes(
      transaction.state,
    )
  ) {
    throw new Error(
      "isolated_root_retirement_failed: journal cannot prove the root was deleted",
    );
  }
  writeAtomicJson(journal, {
    ...record,
    state: "deleted",
    updatedAtMs: Date.now(),
  });
  fs.rmSync(journal);
  fsyncDirectory(path.dirname(journal));
  return { journal, state: "recovered" };
}

export function recoverRetirementJournal(journal, options = {}) {
  const transaction = readRetirementJournal(journal);
  const onBoundary = options.onBoundary ?? (() => {});
  if (transaction.schema === SCHEMA) {
    convergeRetirementIntent(transaction, onBoundary);
    return { journal: transaction.journal, state: "recovered" };
  }
  return recoverLegacyRetirementJournal(transaction, onBoundary);
}

export function recoverRetirementJournals(journalRoot) {
  return retirementJournalFiles(journalRoot).map((journal) =>
    recoverRetirementJournal(journal),
  );
}

export function retirementCompleted(outcome) {
  return outcome?.state === "retired" || outcome?.state === "already_retired";
}

export function retireIsolatedRoot(
  root,
  journalRoot,
  verifiedRootIdentity,
  options = {},
) {
  const { temporaryBoundary, ...targetIdentity } =
    authorizeIsolatedRootRetirement(
      root,
      options.temporaryBoundary ?? os.tmpdir(),
    );
  if (
    targetIdentity.device !== verifiedRootIdentity?.device ||
    targetIdentity.inode !== verifiedRootIdentity?.inode
  ) {
    throw new Error(
      "isolated_root_retirement_failed: root generation changed since cleanup verification",
    );
  }
  const transactions = prepareJournalDirectory(
    journalRoot,
    targetIdentity.path,
    temporaryBoundary,
  );
  const transactionId = retirementTransactionId(targetIdentity);
  const quarantine = `${targetIdentity.path}.retiring-${transactionId}`;
  const journal = path.join(transactions, `${transactionId}.json`);
  const onBoundary = options.onBoundary ?? (() => {});
  let state = "prepared";
  const candidate = {
    journal,
    quarantine,
    schema: SCHEMA,
    target: targetIdentity,
    temporaryBoundary,
    transactionId,
  };
  let transaction = candidate;

  try {
    onBoundary("before_journal", {
      journal,
      quarantine,
      target: targetIdentity.path,
    });
    const existing = scanRetirementIntents(transactions, targetIdentity);
    if (existing?.schema === LEGACY_SCHEMA) {
      return {
        journal: existing.journal,
        quarantine: existing.quarantine,
        state: "reserved",
        target: targetIdentity.path,
      };
    }
    transaction = existing ?? reserveRetirementJournal(candidate);
    if (!transaction) {
      return {
        journal,
        quarantine,
        state: "already_retired",
        target: targetIdentity.path,
      };
    }
    if (transaction === candidate) {
      onBoundary("after_journal", {
        journal,
        quarantine,
        target: targetIdentity.path,
      });
    }
    const { changed } = convergeRetirementIntent(
      transaction,
      onBoundary,
      (nextState) => {
        state = nextState;
      },
    );
    return {
      journal: transaction.journal,
      quarantine: transaction.quarantine,
      state: changed ? "retired" : "already_retired",
      target: transaction.target.path,
    };
  } catch (cause) {
    const preservedPath = pathExists(transaction.quarantine)
      ? transaction.quarantine
      : pathExists(transaction.target.path)
        ? transaction.target.path
        : "deleted";
    throw retirementError(
      `retirement stopped in ${state}`,
      transaction.journal,
      preservedPath,
      cause,
    );
  }
}

async function main() {
  const [
    command,
    root,
    journalRoot,
    cleanupReceipt,
    ...processExitReceipts
  ] = process.argv.slice(2);
  if (
    command === "recover" &&
    root &&
    !journalRoot &&
    !cleanupReceipt &&
    processExitReceipts.length === 0
  ) {
    process.stdout.write(
      `${JSON.stringify(recoverRetirementJournals(root))}\n`,
    );
    return;
  }
  if (
    command !== "retire" ||
    !root ||
    !journalRoot ||
    !cleanupReceipt ||
    processExitReceipts.length !== 2
  ) {
    throw new Error(
      "usage: isolated-root-retirement.mjs retire <isolated-root> <journal-root> <hmux-cleanup-receipt-json> <app-process-exit-receipt-json> <client-process-exit-receipt-json> | recover <journal-root>",
    );
  }
  const outcome = retireIsolatedRoot(
    root,
    journalRoot,
    verifiedRetirementIdentityFromReceipts(
      root,
      cleanupReceipt,
      processExitReceipts,
    ),
  );
  if (!retirementCompleted(outcome)) {
    throw new Error(
      `isolated_root_retirement_incomplete: outcome=${outcome?.state ?? "unknown"}`,
    );
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode =
      error?.code === UNSUPPORTED_CONTAINMENT ||
      error?.code === UNSUPPORTED_MOVE
        ? 2
        : 1;
  });
}
