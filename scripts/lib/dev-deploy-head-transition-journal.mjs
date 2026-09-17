import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { appControlDirectory } from "./app-channel.mjs";
import {
  HEAD_TRANSITION_MODE,
  assertHeadTransitionAuditText,
} from "./dev-deploy-head-transition-options.mjs";

// Keep the established pathname so an interrupted schema-v1 adoption remains
// discoverable after the implementation is generalized.
const JOURNAL_FILE = "dev-deploy-head-adoption-v1.json";
const CURRENT_SCHEMA_VERSION = 2;
const JOURNAL_STATES = new Set([
  "planned",
  "retained",
  "head_adopted",
  "verified",
]);

function assertObjectId(value, label) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error(`${label} is not a full Git object id`);
  }
}

function assertIdentityText(value, label) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\0") ||
    value.length > 8_192
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function schemaVersion(identity) {
  return identity.schemaVersion === 1 ? 1 : CURRENT_SCHEMA_VERSION;
}

export function headTransitionMode(identity) {
  return schemaVersion(identity) === 1
    ? HEAD_TRANSITION_MODE.INTEGRATED_TARGET
    : identity.mode;
}

function wipIdentityValues(wipCheckpoint = {}) {
  return [
    wipCheckpoint.ref ?? "",
    wipCheckpoint.object ?? "",
    wipCheckpoint.base ?? "",
    wipCheckpoint.worktree ?? "",
    wipCheckpoint.operationId ?? "",
  ];
}

function transactionValues(identity) {
  if (schemaVersion(identity) === 1) {
    return [
      identity.root,
      identity.channel,
      identity.currentHead,
      identity.targetHead,
      identity.mergeTree,
      identity.retainedRef,
    ];
  }
  return [
    "schema-v2",
    identity.root,
    identity.channel,
    identity.mode,
    identity.currentHead,
    identity.targetHead,
    identity.mergeTree ?? "",
    identity.retainedRef,
    identity.reason ?? "",
    identity.evidence ?? "",
    ...wipIdentityValues(identity.wipCheckpoint),
  ];
}

export function headTransitionTransactionId(identity) {
  return createHash("sha256")
    .update(transactionValues(identity).join("\0"))
    .digest("hex");
}

export function sameHeadTransitionIdentity(left, right) {
  if (!left || !right || schemaVersion(left) !== schemaVersion(right)) {
    return false;
  }
  const leftValues = transactionValues(left);
  const rightValues = transactionValues(right);
  return (
    left.transactionId === right.transactionId &&
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  );
}

function pathFor(home, channel) {
  return join(appControlDirectory(home, channel), JOURNAL_FILE);
}

function assertCommonJournalIdentity(pathname, value) {
  for (const [field, label] of [
    ["currentHead", "journal current head"],
    ["targetHead", "journal target head"],
  ]) {
    assertObjectId(value[field], label);
  }
  for (const [field, label] of [
    ["root", "journal root"],
    ["channel", "journal channel"],
    ["retainedRef", "journal retained ref"],
  ]) {
    assertIdentityText(value[field], label);
  }
  if (!/^[0-9a-f]{64}$/.test(value.transactionId)) {
    throw new Error(`invalid head transition journal ${pathname}: identity`);
  }
}

function assertSchemaOne(pathname, value) {
  assertObjectId(value.mergeTree, "journal merge tree");
  if (
    Object.hasOwn(value, "mode") ||
    Object.hasOwn(value, "reason") ||
    Object.hasOwn(value, "evidence") ||
    Object.hasOwn(value, "wipCheckpoint")
  ) {
    throw new Error(
      `invalid head transition journal ${pathname}: schema-v1 retirement fields`,
    );
  }
}

function assertWipCheckpoint(pathname, checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new Error(
      `invalid head transition journal ${pathname}: WIP checkpoint`,
    );
  }
  assertObjectId(checkpoint.object, "journal WIP checkpoint object");
  assertObjectId(checkpoint.base, "journal WIP checkpoint base");
  for (const [field, label] of [
    ["ref", "journal WIP checkpoint ref"],
    ["worktree", "journal WIP checkpoint worktree"],
    ["operationId", "journal WIP checkpoint operation id"],
  ]) {
    assertIdentityText(checkpoint[field], label);
  }
}

function assertSchemaTwo(pathname, value) {
  if (value.mode === HEAD_TRANSITION_MODE.INTEGRATED_TARGET) {
    assertObjectId(value.mergeTree, "journal merge tree");
    if (
      Object.hasOwn(value, "reason") ||
      Object.hasOwn(value, "evidence") ||
      Object.hasOwn(value, "wipCheckpoint")
    ) {
      throw new Error(
        `invalid head transition journal ${pathname}: integrated mode fields`,
      );
    }
    return;
  }
  if (value.mode !== HEAD_TRANSITION_MODE.RETIRE_PRESERVED_HEAD) {
    throw new Error(
      `invalid head transition journal ${pathname}: unsupported mode`,
    );
  }
  if (Object.hasOwn(value, "mergeTree")) {
    throw new Error(
      `invalid head transition journal ${pathname}: retirement merge tree`,
    );
  }
  assertHeadTransitionAuditText(value.reason, "journal retire reason");
  assertHeadTransitionAuditText(value.evidence, "journal retire evidence");
  assertWipCheckpoint(pathname, value.wipCheckpoint);
}

function parseJournal(pathname, source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid head transition journal ${pathname}: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid head transition journal ${pathname}: expected object`);
  }
  if (value.schemaVersion !== 1 && value.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`invalid head transition journal ${pathname}: unsupported schema`);
  }
  if (!JOURNAL_STATES.has(value.state)) {
    throw new Error(`invalid head transition journal ${pathname}: unsupported state`);
  }
  assertCommonJournalIdentity(pathname, value);
  if (value.schemaVersion === 1) assertSchemaOne(pathname, value);
  else assertSchemaTwo(pathname, value);
  if (headTransitionTransactionId(value) !== value.transactionId) {
    throw new Error(`invalid head transition journal ${pathname}: transaction id`);
  }
  return value;
}

function assertOwnerDirectory(directory) {
  const stat = lstatSync(directory);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(
      `head transition journal directory is not owner-only: ${directory}`,
    );
  }
}

export function readHeadTransitionJournal({ home, channel }) {
  const pathname = pathFor(home, channel);
  if (!existsSync(pathname)) return undefined;
  assertOwnerDirectory(dirname(pathname));
  const stat = lstatSync(pathname);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    stat.size > 64 * 1024
  ) {
    throw new Error(`head transition journal is not owner-only: ${pathname}`);
  }
  return parseJournal(pathname, readFileSync(pathname, "utf8"));
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function journalValue(plan, state) {
  if (schemaVersion(plan) === 1) {
    return {
      schemaVersion: 1,
      state,
      transactionId: plan.transactionId,
      root: plan.root,
      channel: plan.channel,
      currentHead: plan.currentHead,
      targetHead: plan.targetHead,
      mergeTree: plan.mergeTree,
      retainedRef: plan.retainedRef,
    };
  }
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    state,
    transactionId: plan.transactionId,
    root: plan.root,
    channel: plan.channel,
    mode: plan.mode,
    currentHead: plan.currentHead,
    targetHead: plan.targetHead,
    ...(plan.mode === HEAD_TRANSITION_MODE.INTEGRATED_TARGET
      ? { mergeTree: plan.mergeTree }
      : {
          reason: plan.reason,
          evidence: plan.evidence,
          wipCheckpoint: plan.wipCheckpoint,
        }),
    retainedRef: plan.retainedRef,
  };
}

export function writeHeadTransitionJournal(plan, state) {
  const directory = appControlDirectory(plan.home, plan.channel);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertOwnerDirectory(directory);
  const pathname = pathFor(plan.home, plan.channel);
  const temporary = join(
    directory,
    `.${JOURNAL_FILE}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  const value = journalValue(plan, state);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
      fsyncSync(descriptor);
    } finally {
      const closing = descriptor;
      descriptor = undefined;
      closeSync(closing);
    }
    renameSync(temporary, pathname);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const persisted = readHeadTransitionJournal({
    home: plan.home,
    channel: plan.channel,
  });
  if (!sameHeadTransitionIdentity(persisted, value) || persisted.state !== state) {
    throw new Error("head transition journal verification failed");
  }
  return persisted;
}
