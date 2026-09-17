#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readOwnedProcessGroup,
  readOwnedProcessLedger,
  verifyOwnedProcessTreeExited,
} from "./lib/owned-process-group.mjs";
import { ownedProcessGenerationDigestV1 } from "./lib/owned-process-persistence-v1.mjs";

const TEST_NAME =
  "plugin_native_provider_route_conformance_tests::pinned_provider_lifecycle_conforms";
const PACKAGE_EVIDENCE_TEST_NAME =
  "plugin_native_provider_route_conformance_tests::materialize_bundled_package_for_conformance";
const PACKAGE_EVIDENCE_PREFIX = "DURE_QA_EMBEDDED_PACKAGE_EVIDENCE:";
const ROOT_PREFIX = "dure-plugin-provider-conformance-";
const MAX_CARGO_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_CONFORMANCE_RUNTIME_MS = 20 * 60 * 1000;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const PROVIDER_RECEIPT_FILE = "provider-conformance-receipt.json";
const PROVIDER_RECEIPT_SCHEMA_VERSION = 2;
const PACKAGE_MATERIALIZATION_SCHEMA_VERSION = 1;
const PROCESS_EXIT_RECEIPT_SCHEMA = "dure-qa-owned-process-exit/v1";
const LIFECYCLE_OPERATIONS = [
  "list_marketplaces",
  "add_marketplace",
  "install_plugin",
  "list_plugins",
  "remove_plugin",
  "list_plugins",
  "remove_marketplace",
  "list_marketplaces",
];
const INODE_SWAP_MUTATIONS = [
  "add_marketplace",
  "install_plugin",
  "remove_plugin",
  "remove_marketplace",
];
const MACOS_ARM64_PROVIDER_PINS = {
  claude: {
    executable_sha256: "sha256:8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081",
    version: "2.1.220",
  },
  codex: {
    executable_sha256: "sha256:ae1d3ffe6d48aec6a4dc3f50e7eb8e0d11962485a6a9406c5a7012139383da02",
    version: "0.146.0",
  },
};
const MACOS_REQUIRED_CASES = [
  {
    id: "codex_managed",
    provider: "codex",
    registration_target: "managed_profile",
    route_generation:
      "macos_codex_volume_file_id_exec_fchdir_relative_home_package_sealed_lexical_anchor_v3",
    scope: "managed",
  },
  {
    id: "claude_user",
    provider: "claude",
    registration_target: "user",
    route_generation:
      "macos_claude_volume_file_id_exec_home_package_sealed_lexical_anchor_v3",
    scope: "user",
  },
];

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const processGroupRunner = path.join(
  scriptDirectory,
  "lib/owned-process-group.mjs",
);
const providerSourceRoot = path.join(repositoryRoot, "plugins/beads");

export class ProviderConformanceUnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderConformanceUnsupportedError";
    this.code = "plugin_native_provider_conformance_unsupported";
  }
}

function boundedDiagnostic(value) {
  return String(value instanceof Error ? value.message : value)
    .trim()
    .replaceAll(/\s+/gu, " ")
    .slice(0, 2_048);
}

function exactKeys(value, expected, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields do not match schema version 1`);
  }
}

function sha256File(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(file, flags);
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${digest.digest("hex")}`;
}

function validSha256(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function validVersion(value) {
  return (
    typeof value === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)
  );
}

function identity(metadata) {
  return {
    device: String(metadata.dev),
    inode: String(metadata.ino),
    mode: metadata.mode & 0o7777,
    uid: metadata.uid,
  };
}

function sameIdentity(left, right) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

function strictProcessId(value, label, { allowZero = false } = {}) {
  if (
    !Number.isSafeInteger(value) ||
    (allowZero ? value < 0 : value <= 1)
  ) {
    throw new Error(`owned process ${label} must be an exact numeric identity`);
  }
  return value;
}

function strictMarker(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`owned process ${label} is unavailable`);
  }
  return value;
}

function hostIdentity(platform = process.platform, architecture = process.arch) {
  if (platform === "linux") {
    throw new ProviderConformanceUnsupportedError(
      "Linux provider conformance is disabled until host-owned filesystem and network containment is implemented",
    );
  }
  if (platform !== "darwin") {
    throw new ProviderConformanceUnsupportedError(
      `provider conformance is unsupported on ${platform}`,
    );
  }
  if (architecture !== "arm64") {
    throw new ProviderConformanceUnsupportedError(
      `provider conformance is unsupported on darwin/${architecture}`,
    );
  }
  return { arch: "aarch64", os: "macos" };
}

export function requireSupportedProviderConformanceHost(
  platform = process.platform,
  architecture = process.arch,
) {
  return hostIdentity(platform, architecture);
}

function directOwnedDirectory(directory, label) {
  const requested = path.resolve(directory);
  const requestedMetadata = fs.lstatSync(requested);
  if (requestedMetadata.isSymbolicLink()) {
    throw new Error(`${label} must be a direct owner-only directory`);
  }
  const resolved = fs.realpathSync(requested);
  const metadata = fs.lstatSync(resolved);
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error(`${label} must be a direct owner-only directory`);
  }
  return resolved;
}

function trustedReadDirectory(directory, label) {
  const requested = path.resolve(directory);
  const requestedMetadata = fs.lstatSync(requested);
  if (requestedMetadata.isSymbolicLink()) {
    throw new Error(`${label} must be a direct trusted directory`);
  }
  const resolved = fs.realpathSync(requested);
  const metadata = fs.lstatSync(resolved);
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o022) !== 0 ||
    (uid !== undefined && metadata.uid !== uid && metadata.uid !== 0)
  ) {
    throw new Error(`${label} must be a direct trusted directory`);
  }
  return resolved;
}

function sourcePath(root, relative) {
  return relative.length === 0
    ? Buffer.from(root)
    : Buffer.concat([Buffer.from(root), Buffer.from("/"), relative]);
}

function sourceEntries(root, relative = Buffer.alloc(0)) {
  const directory = sourcePath(root, relative);
  const entries = [];
  const children = fs
    .readdirSync(directory, { encoding: "buffer", withFileTypes: true })
    .sort((left, right) => Buffer.compare(left.name, right.name));
  for (const entry of children) {
    const childRelative =
      relative.length === 0
        ? entry.name
        : Buffer.concat([relative, Buffer.from("/"), entry.name]);
    const child = sourcePath(root, childRelative);
    const metadata = fs.lstatSync(child);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `provider conformance source contains a symlink: ${childRelative.toString("utf8")}`,
      );
    }
    if (metadata.isDirectory()) {
      entries.push({ contents: Buffer.alloc(0), kind: Buffer.from("d"), relative: childRelative });
      entries.push(...sourceEntries(root, childRelative));
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(
        `provider conformance source contains a special file: ${childRelative.toString("utf8")}`,
      );
    }
    entries.push({ contents: fs.readFileSync(child), kind: Buffer.from("f"), relative: childRelative });
  }
  return entries;
}

function u64be(value) {
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(BigInt(value));
  return result;
}

export function providerConformanceSourceHash(root = providerSourceRoot) {
  const exactRoot = trustedReadDirectory(root, "provider source");
  const entries = sourceEntries(exactRoot).sort((left, right) =>
    Buffer.compare(left.relative, right.relative),
  );
  const digest = crypto.createHash("sha256");
  for (const entry of entries) {
    const relative = entry.relative;
    digest.update(u64be(relative.length));
    digest.update(relative);
    digest.update(entry.kind);
    digest.update(u64be(entry.contents.length));
    digest.update(entry.contents);
  }
  return `sha256:${digest.digest("hex")}`;
}

export function validateProviderBinary(file, label) {
  if (typeof file !== "string" || file.length === 0 || file.includes("\0")) {
    throw new Error(`${label} path is required`);
  }
  const requested = path.resolve(file);
  const requestedMetadata = fs.lstatSync(requested);
  if (requestedMetadata.isSymbolicLink()) {
    throw new Error(`${label} must resolve to a trusted direct executable`);
  }
  const resolved = fs.realpathSync(requested);
  const metadata = fs.lstatSync(resolved);
  const uid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o111) === 0 ||
    (metadata.mode & 0o022) !== 0 ||
    (uid !== undefined && metadata.uid !== uid && metadata.uid !== 0)
  ) {
    throw new Error(`${label} must resolve to a trusted direct executable`);
  }
  return resolved;
}

export function providerEvidence(file, label, pin) {
  exactKeys(pin, ["executable_sha256", "version"], `${label} pin`);
  if (!validSha256(pin.executable_sha256) || !validVersion(pin.version)) {
    throw new Error(`${label} pin is invalid`);
  }
  const executable = validateProviderBinary(file, label);
  const executableSha256 = sha256File(executable);
  if (executableSha256 !== pin.executable_sha256) {
    throw new Error(`${label} does not match the pinned executable hash`);
  }
  const readRoot = trustedReadDirectory(path.dirname(executable), `${label} install root`);
  if (["/", "/opt", "/usr", "/usr/local", "/private", "/tmp", "/var"].includes(readRoot)) {
    throw new Error(`${label} install root is too broad for provider containment`);
  }
  return {
    executable,
    executable_sha256: executableSha256,
    readRoot,
    version: pin.version,
  };
}

export function parseCargoTestExecutable(output) {
  const executables = new Set();
  for (const line of output.split("\n")) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      message?.reason === "compiler-artifact" &&
      message?.profile?.test === true &&
      message?.target?.name === "agent_ide_lib" &&
      typeof message.executable === "string"
    ) {
      executables.add(path.resolve(message.executable));
    }
  }
  if (executables.size !== 1) {
    throw new Error(
      `expected one agent_ide_lib conformance binary, observed ${executables.size}`,
    );
  }
  return validateProviderBinary(
    [...executables][0],
    "compiled conformance test binary",
  );
}

export function assertSingleSessionLedger(
  descriptor,
  ledger,
  receipt,
  { requireBoundedProviderGroup = true } = {},
) {
  if (!Array.isArray(ledger) || ledger.length === 0) {
    throw new Error("owned process ledger is empty");
  }
  strictProcessId(descriptor.groupId, "descriptor group");
  strictProcessId(descriptor.leaderPid, "descriptor leader");
  strictMarker(descriptor.leaderStartMarker, "descriptor leader start marker");
  strictMarker(
    descriptor.leaderKernelStartMarker,
    "descriptor leader kernel start marker",
  );
  const identities = new Set();
  for (const record of ledger) {
    strictProcessId(record.pid, "ledger pid");
    strictProcessId(record.parentPid, "ledger parent pid", { allowZero: true });
    strictProcessId(record.groupId, "ledger group");
    strictProcessId(record.sessionId, "ledger session", { allowZero: true });
    strictMarker(record.startMarker, "ledger start marker");
    strictMarker(record.kernelStartMarker, "ledger kernel start marker");
    const generation = `${record.pid}\0${record.startMarker}\0${record.kernelStartMarker}`;
    if (identities.has(generation)) {
      throw new Error("owned process ledger contains a duplicate generation");
    }
    identities.add(generation);
  }
  const leaderRecords = ledger.filter((record) => record.pid === descriptor.leaderPid);
  const leader = leaderRecords.find(
    (record) =>
      record.groupId === descriptor.groupId &&
      record.startMarker === descriptor.leaderStartMarker &&
      record.kernelStartMarker === descriptor.leaderKernelStartMarker,
  );
  if (leaderRecords.length !== 1 || !leader) {
    throw new Error("owned process ledger omitted its exact leader generation");
  }
  if (descriptor.terminateDetachedOwnedGenerations !== true) {
    throw new Error("owned process descriptor does not terminate detached generations");
  }
  if (
    requireBoundedProviderGroup &&
    !ledger.some(
      (record) =>
        record.pid !== descriptor.leaderPid &&
        record.groupId !== descriptor.groupId,
    )
  ) {
    throw new Error(
      "provider conformance did not observe a bounded provider process group",
    );
  }
  if (
    receipt?.schema !== PROCESS_EXIT_RECEIPT_SCHEMA ||
    receipt?.platform !== process.platform ||
    receipt?.descriptor?.groupId !== descriptor.groupId ||
    receipt?.descriptor?.leader?.pid !== descriptor.leaderPid ||
    receipt?.descriptor?.leader?.startMarker !== descriptor.leaderStartMarker ||
    receipt?.descriptor?.leader?.kernelStartMarker !==
      descriptor.leaderKernelStartMarker ||
    receipt?.ownedGenerations?.count !== ledger.length ||
    receipt?.ownedGenerations?.digest !==
      ownedProcessGenerationDigestV1(ledger)
  ) {
    throw new Error(
      "owned process exit receipt does not bind the exact final ledger",
    );
  }
}

function schemeString(value) {
  if (/\0|\r|\n/u.test(value)) {
    throw new Error("sandbox path contains a control character");
  }
  return JSON.stringify(value);
}

function sandboxRoot(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} must be an absolute sandbox path`);
  }
  return path.resolve(value);
}

function sandboxAncestorMetadata(roots) {
  const ancestors = new Set(["/"]);
  for (const root of roots) {
    for (let current = path.dirname(root); current !== "/"; current = path.dirname(current)) {
      ancestors.add(current);
    }
  }
  return [...ancestors].sort();
}

export function macosSandboxProfile({
  providerRoots = [],
  stateRoot,
  testBinaryRoot,
}) {
  const exactStateRoot = sandboxRoot(stateRoot, "sandbox state root");
  const exactTestBinaryRoot = sandboxRoot(
    testBinaryRoot,
    "sandbox test binary root",
  );
  const writableRoots = ["home", "state", "tmp", "xdg-cache", "xdg-config"].map(
    (child) => path.join(exactStateRoot, child),
  );
  const readRoots = [
    "/System/Library",
    "/usr/bin",
    "/usr/lib",
    "/usr/share",
    "/bin",
    "/sbin",
    "/private/var/db/timezone",
    exactStateRoot,
    exactTestBinaryRoot,
    ...providerRoots.map((root) => sandboxRoot(root, "sandbox provider root")),
  ];
  const ancestorMetadata = sandboxAncestorMetadata(readRoots);
  return `
(version 1)
(deny default)
(allow process*)
(allow signal (target self))
(allow signal (target children))
(allow sysctl-read)
(allow file-read*
${[...new Set(readRoots)].map((root) => `  (subpath ${schemeString(root)})`).join("\n")}
${ancestorMetadata.map((root) => `  (literal ${schemeString(root)})`).join("\n")}
  (literal "/etc")
  (literal "/etc/codex")
  (literal "/etc/codex/requirements.toml")
  (literal "/dev/null")
  (literal "/dev/random")
  (literal "/dev/urandom"))
(allow file-write*
${writableRoots.map((root) => `  (subpath ${schemeString(root)})`).join("\n")}
  (literal "/dev/null"))
(allow mach-lookup
  (global-name "com.apple.cfprefsd.xpc.agent")
  (global-name "com.apple.cfprefsd.xpc.daemon")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.opendirectoryd.libinfo"))
(deny network*)
`;
}

function assertReceiptCase(actual, expected) {
  exactKeys(
    actual,
    [
      "id",
      "inode_swap_mutations",
      "lifecycle_operations",
      "provider",
      "registration_target",
      "route_generation",
      "scope",
      "status",
    ],
    `provider conformance case ${expected.id}`,
  );
  for (const field of [
    "id",
    "provider",
    "registration_target",
    "route_generation",
    "scope",
  ]) {
    if (actual[field] !== expected[field]) {
      throw new Error(`provider conformance case ${expected.id} has an invalid ${field}`);
    }
  }
  if (
    actual.status !== "passed" ||
    !Array.isArray(actual.lifecycle_operations) ||
    JSON.stringify(actual.lifecycle_operations) !== JSON.stringify(LIFECYCLE_OPERATIONS) ||
    !Array.isArray(actual.inode_swap_mutations) ||
    JSON.stringify(actual.inode_swap_mutations) !== JSON.stringify(INODE_SWAP_MUTATIONS)
  ) {
    throw new Error(`provider conformance case ${expected.id} is incomplete`);
  }
}

export function validateProviderConformanceReceipt(
  receipt,
  {
    host,
    package_materialization: expectedMaterialization,
    providers,
    source_sha256: sourceSha256,
  },
) {
  exactKeys(
    receipt,
    [
      "cases",
      "host",
      "package_materialization",
      "providers",
      "schema_version",
      "source_sha256",
      "status",
    ],
    "provider conformance receipt",
  );
  if (receipt.schema_version !== PROVIDER_RECEIPT_SCHEMA_VERSION) {
    throw new Error("provider conformance receipt has an unsupported schema version");
  }
  if (receipt.status !== "passed") {
    throw new Error("provider conformance receipt did not pass");
  }
  exactKeys(receipt.host, ["arch", "os"], "provider conformance host");
  if (receipt.host.os !== host.os || receipt.host.arch !== host.arch) {
    throw new Error("provider conformance receipt host does not match this runner");
  }
  if (!validSha256(receipt.source_sha256) || receipt.source_sha256 !== sourceSha256) {
    throw new Error("provider conformance receipt source hash does not match");
  }
  exactKeys(
    receipt.package_materialization,
    [
      "embedded_authority_sha256",
      "file_manifest_sha256",
      "plugin_id",
      "plugin_version",
      "root_device",
      "root_inode",
      "schema_version",
    ],
    "provider conformance package materialization",
  );
  const materialization = receipt.package_materialization;
  if (
    materialization.schema_version !== PACKAGE_MATERIALIZATION_SCHEMA_VERSION ||
    materialization.plugin_id !== "dure.beads" ||
    !validVersion(materialization.plugin_version) ||
    !validSha256(materialization.embedded_authority_sha256) ||
    !validSha256(materialization.file_manifest_sha256) ||
    materialization.embedded_authority_sha256 === materialization.file_manifest_sha256 ||
    !/^[1-9][0-9]*$/.test(materialization.root_device) ||
    !/^[1-9][0-9]*$/.test(materialization.root_inode)
  ) {
    throw new Error("provider conformance package materialization is invalid");
  }
  if (
    typeof expectedMaterialization !== "object" ||
    expectedMaterialization === null ||
    JSON.stringify(materialization) !== JSON.stringify(expectedMaterialization)
  ) {
    throw new Error(
      "provider conformance package materialization does not match build-embedded evidence",
    );
  }
  exactKeys(receipt.providers, ["claude", "codex"], "provider conformance providers");
  for (const provider of ["codex", "claude"]) {
    const actual = receipt.providers[provider];
    exactKeys(
      actual,
      ["executable_sha256", "status", "version"],
      `${provider} conformance provider`,
    );
    if (!validVersion(actual.version) || actual.status !== "passed") {
      throw new Error(`${provider} conformance provider is not pinned and passed`);
    }
    if (
      !validSha256(actual.executable_sha256) ||
      actual.executable_sha256 !== providers[provider].executable_sha256
    ) {
      throw new Error(`${provider} conformance executable hash does not match`);
    }
    if (actual.version !== providers[provider].version) {
      throw new Error(`${provider} conformance version does not match its pin`);
    }
  }
  if (!Array.isArray(receipt.cases) || receipt.cases.length !== MACOS_REQUIRED_CASES.length) {
    throw new Error("provider conformance receipt does not contain the full case matrix");
  }
  const cases = new Map();
  for (const entry of receipt.cases) {
    if (typeof entry?.id !== "string" || cases.has(entry.id)) {
      throw new Error("provider conformance receipt contains a duplicate or invalid case");
    }
    cases.set(entry.id, entry);
  }
  for (const expected of MACOS_REQUIRED_CASES) {
    const actual = cases.get(expected.id);
    if (!actual) {
      throw new Error(`provider conformance receipt omitted ${expected.id}`);
    }
    assertReceiptCase(actual, expected);
  }
  return receipt;
}

export function readProviderConformanceReceipt(file, expected) {
  const lexicalMetadata = fs.lstatSync(file);
  if (lexicalMetadata.isSymbolicLink()) {
    throw new Error("provider conformance receipt is not a direct owner-only file");
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(file, flags);
  const metadata = fs.fstatSync(descriptor);
  const uid = process.getuid?.();
  if (
    !metadata.isFile() ||
    String(metadata.dev) !== String(lexicalMetadata.dev) ||
    String(metadata.ino) !== String(lexicalMetadata.ino) ||
    metadata.size <= 0 ||
    metadata.size > MAX_RECEIPT_BYTES ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o077) !== 0 ||
    (uid !== undefined && metadata.uid !== uid)
  ) {
    fs.closeSync(descriptor);
    throw new Error("provider conformance receipt is not a direct owner-only file");
  }
  let receipt;
  try {
    const contents = Buffer.alloc(metadata.size + 1);
    let offset = 0;
    while (offset < contents.length) {
      const count = fs.readSync(
        descriptor,
        contents,
        offset,
        contents.length - offset,
        null,
      );
      if (count === 0) break;
      offset += count;
    }
    const finalMetadata = fs.fstatSync(descriptor);
    if (
      offset !== metadata.size ||
      finalMetadata.size !== metadata.size ||
      String(finalMetadata.dev) !== String(metadata.dev) ||
      String(finalMetadata.ino) !== String(metadata.ino) ||
      (finalMetadata.mode & 0o7777) !== (metadata.mode & 0o7777) ||
      finalMetadata.uid !== metadata.uid
    ) {
      throw new Error("provider conformance receipt changed while it was read");
    }
    receipt = JSON.parse(contents.subarray(0, offset).toString("utf8"));
  } catch (error) {
    throw new Error(`provider conformance receipt is invalid: ${boundedDiagnostic(error)}`);
  } finally {
    fs.closeSync(descriptor);
  }
  return validateProviderConformanceReceipt(receipt, expected);
}

export function assertProviderSourceStable({
  finalSourceSha256,
  initialSourceSha256,
  receipt,
}) {
  if (
    !validSha256(initialSourceSha256) ||
    !validSha256(finalSourceSha256) ||
    finalSourceSha256 !== initialSourceSha256 ||
    receipt?.source_sha256 !== initialSourceSha256 ||
    receipt?.source_sha256 !== finalSourceSha256
  ) {
    throw new Error(
      "provider conformance source changed across the Rust execution boundary",
    );
  }
}

function compileConformanceTest() {
  const result = spawnSync(
    "cargo",
    [
      "test",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--lib",
      TEST_NAME,
      "--features",
      "provider-conformance-test-support",
      "--no-run",
      "--message-format=json",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: process.env,
      maxBuffer: MAX_CARGO_OUTPUT_BYTES,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `could not compile provider conformance test: ${boundedDiagnostic(
        result.error ?? result.stderr ?? `exit ${result.status}`,
      )}`,
    );
  }
  return parseCargoTestExecutable(result.stdout);
}

function stateRootAuthority(root, parent) {
  const rootMetadata = fs.lstatSync(root);
  const parentMetadata = fs.lstatSync(parent);
  return Object.freeze({
    device: String(rootMetadata.dev),
    inode: String(rootMetadata.ino),
    lexicalPath: root,
    mode: rootMetadata.mode & 0o7777,
    parent,
    parentDevice: String(parentMetadata.dev),
    parentInode: String(parentMetadata.ino),
    parentMode: parentMetadata.mode & 0o7777,
    parentUid: parentMetadata.uid,
    uid: rootMetadata.uid,
  });
}

function assertStateRootAuthority(authority, lexicalPath = authority?.lexicalPath) {
  if (
    typeof authority !== "object" ||
    authority === null ||
    typeof lexicalPath !== "string" ||
    path.resolve(lexicalPath) !== lexicalPath ||
    path.dirname(lexicalPath) !== authority.parent ||
    !path.basename(lexicalPath).startsWith(ROOT_PREFIX)
  ) {
    throw new Error("provider conformance root authority is invalid");
  }
  const parentMetadata = fs.lstatSync(authority.parent);
  const parentIdentity = {
    device: String(parentMetadata.dev),
    inode: String(parentMetadata.ino),
    mode: parentMetadata.mode & 0o7777,
    uid: parentMetadata.uid,
  };
  if (
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink() ||
    !sameIdentity(parentIdentity, {
      device: authority.parentDevice,
      inode: authority.parentInode,
      mode: authority.parentMode,
      uid: authority.parentUid,
    })
  ) {
    throw new Error("provider conformance root parent changed");
  }
  const metadata = fs.lstatSync(lexicalPath);
  const observed = identity(metadata);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !sameIdentity(observed, authority) ||
    authority.mode !== 0o700 ||
    (process.getuid?.() !== undefined && authority.uid !== process.getuid())
  ) {
    throw new Error("provider conformance root changed before cleanup");
  }
  return lexicalPath;
}

export function createStateRoot(temporaryParent = "/tmp") {
  const temporaryRoot = fs.realpathSync(temporaryParent);
  const root = fs.mkdtempSync(path.join(temporaryRoot, ROOT_PREFIX));
  fs.chmodSync(root, 0o700);
  const resolved = directOwnedDirectory(root, "provider conformance root");
  if (
    path.dirname(resolved) !== temporaryRoot ||
    !path.basename(resolved).startsWith(ROOT_PREFIX)
  ) {
    throw new Error("provider conformance root escaped its explicit temp parent");
  }
  for (const child of ["home", "package", "state", "tmp", "xdg-cache", "xdg-config"]) {
    fs.mkdirSync(path.join(resolved, child), { mode: 0o700 });
  }
  return stateRootAuthority(resolved, temporaryRoot);
}

function conformanceCommand({ host, packageEvidence, root, sourceSha256, testBinary }) {
  const providers = {
    codex: providerEvidence(
      process.env.DURE_QA_CODEX_BIN,
      "DURE_QA_CODEX_BIN",
      MACOS_ARM64_PROVIDER_PINS.codex,
    ),
    claude: providerEvidence(
      process.env.DURE_QA_CLAUDE_BIN,
      "DURE_QA_CLAUDE_BIN",
      MACOS_ARM64_PROVIDER_PINS.claude,
    ),
  };
  const environment = [
    `DURE_QA_CODEX_BIN=${providers.codex.executable}`,
    `DURE_QA_CLAUDE_BIN=${providers.claude.executable}`,
    `DURE_QA_PROVIDER_CONFORMANCE_ROOT=${path.join(root, "state")}`,
    `DURE_QA_PROVIDER_PACKAGE_ROOT=${path.join(root, "package")}`,
    `HOME=${path.join(root, "home")}`,
    `TMPDIR=${path.join(root, "tmp")}`,
    `XDG_CACHE_HOME=${path.join(root, "xdg-cache")}`,
    `XDG_CONFIG_HOME=${path.join(root, "xdg-config")}`,
    "NO_COLOR=1",
    "RUST_BACKTRACE=1",
    "TERM=dumb",
  ];
  const testArguments = [
    testBinary,
    "--exact",
    TEST_NAME,
    "--ignored",
    "--nocapture",
    "--test-threads=1",
  ];
  if (process.platform === "darwin") {
    const profile = path.join(root, "sandbox.sb");
    fs.writeFileSync(
      profile,
      macosSandboxProfile({
        providerRoots: [providers.codex.readRoot, providers.claude.readRoot],
        stateRoot: root,
        testBinaryRoot: path.dirname(testBinary),
      }),
      { flag: "wx", mode: 0o600 },
    );
    return {
      args: ["-i", ...environment, "/usr/bin/sandbox-exec", "-f", profile, ...testArguments],
      command: "/usr/bin/env",
      expectedReceipt: {
        host,
        package_materialization: packageEvidence.package_materialization,
        providers,
        source_sha256: sourceSha256,
      },
      mode: "run-observed",
      redacted: {
        command: "/usr/bin/env",
        host,
        providers: {
          claude: {
            executable_name: path.basename(providers.claude.executable),
            executable_sha256: providers.claude.executable_sha256,
            version: providers.claude.version,
          },
          codex: {
            executable_name: path.basename(providers.codex.executable),
            executable_sha256: providers.codex.executable_sha256,
            version: providers.codex.version,
          },
        },
        source_sha256: sourceSha256,
        embedded_authority_sha256:
          packageEvidence.package_materialization.embedded_authority_sha256,
        file_manifest_sha256:
          packageEvidence.package_materialization.file_manifest_sha256,
        test_name: TEST_NAME,
      },
    };
  }
  if (process.platform === "linux") {
    throw new ProviderConformanceUnsupportedError(
      "Linux provider conformance cannot run before host-owned filesystem and network containment is implemented",
    );
  }
  throw new ProviderConformanceUnsupportedError(
    `provider conformance is unsupported on ${process.platform}`,
  );
}

export function materializeEmbeddedPackageEvidence({ root, sourceSha256, testBinary }) {
  const packageRoot = path.join(root, "package");
  const result = spawnSync(
    testBinary,
    [
      "--exact",
      PACKAGE_EVIDENCE_TEST_NAME,
      "--ignored",
      "--nocapture",
      "--test-threads=1",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DURE_QA_PROVIDER_PACKAGE_ROOT: packageRoot,
      },
      maxBuffer: MAX_RECEIPT_BYTES,
      timeout: 2 * 60 * 1000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `could not materialize build-embedded provider package: ${boundedDiagnostic(
        result.error ?? result.stderr ?? `exit ${result.status}`,
      )}`,
    );
  }
  return parseEmbeddedPackageEvidence(result.stdout, sourceSha256);
}

export function parseEmbeddedPackageEvidence(output, sourceSha256) {
  const evidenceLines = String(output)
    .split(/\r?\n/u)
    .filter((line) => line.includes(PACKAGE_EVIDENCE_PREFIX));
  if (evidenceLines.length !== 1) {
    throw new Error("embedded package materializer did not publish one exact evidence record");
  }
  let evidence;
  try {
    const prefixIndex = evidenceLines[0].indexOf(PACKAGE_EVIDENCE_PREFIX);
    evidence = JSON.parse(
      evidenceLines[0].slice(prefixIndex + PACKAGE_EVIDENCE_PREFIX.length),
    );
  } catch {
    throw new Error("embedded package materializer published invalid JSON evidence");
  }
  exactKeys(
    evidence,
    [
      "embedded_authority_sha256",
      "file_manifest_sha256",
      "plugin_id",
      "plugin_version",
      "root_device",
      "root_inode",
      "schema_version",
      "source_sha256",
    ],
    "build-embedded package evidence",
  );
  if (
    evidence.schema_version !== PACKAGE_MATERIALIZATION_SCHEMA_VERSION ||
    evidence.plugin_id !== "dure.beads" ||
    !validVersion(evidence.plugin_version) ||
    !validSha256(evidence.embedded_authority_sha256) ||
    !validSha256(evidence.file_manifest_sha256) ||
    evidence.embedded_authority_sha256 === evidence.file_manifest_sha256 ||
    !/^[1-9][0-9]*$/.test(evidence.root_device) ||
    !/^[1-9][0-9]*$/.test(evidence.root_inode) ||
    evidence.source_sha256 !== sourceSha256
  ) {
    throw new Error(
      "build-embedded package evidence does not match the exact checkout freshness hash",
    );
  }
  const { source_sha256, ...packageMaterialization } = evidence;
  return {
    package_materialization: packageMaterialization,
    source_sha256,
  };
}

function defaultTrash(target) {
  return spawnSync("/usr/bin/trash", [target], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

export function retireStateRoot(
  authority,
  { platform = process.platform, trash = defaultTrash } = {},
) {
  if (platform !== "darwin") {
    throw new ProviderConformanceUnsupportedError(
      `provider conformance cleanup is unsupported on ${platform}`,
    );
  }
  const expected = assertStateRootAuthority(authority);
  const quarantine = path.join(
    authority.parent,
    `${ROOT_PREFIX}quarantine-${crypto.randomUUID()}`,
  );
  fs.renameSync(expected, quarantine);
  try {
    assertStateRootAuthority(authority, quarantine);
    const result = trash(quarantine);
    if (result?.error || result?.status !== 0 || fs.existsSync(quarantine)) {
      const error = new Error(
        `could not retire provider conformance root: ${boundedDiagnostic(
          result?.error ?? result?.stderr ?? `exit ${result?.status}`,
        )}`,
      );
      error.retainedEvidencePath = quarantine;
      throw error;
    }
  } catch (error) {
    if (error instanceof Error && !error.retainedEvidencePath) {
      error.retainedEvidencePath = quarantine;
    }
    throw error;
  }
}

function writeOwnerOnlyFile(file, contents) {
  fs.writeFileSync(file, contents, { flag: "wx", mode: 0o600 });
  const metadata = fs.lstatSync(file);
  const uid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o077) !== 0 ||
    (uid !== undefined && metadata.uid !== uid)
  ) {
    throw new Error("provider conformance evidence file is not owner-only");
  }
}

function capturedBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.from(String(value));
}

export function persistAndReplayOutput(root, result) {
  const stdout = capturedBytes(result.stdout);
  const stderr = capturedBytes(result.stderr);
  const overflow =
    result.error?.code === "ENOBUFS" ||
    stdout.byteLength > MAX_CARGO_OUTPUT_BYTES ||
    stderr.byteLength > MAX_CARGO_OUTPUT_BYTES;
  const boundedStdout = stdout.subarray(0, MAX_CARGO_OUTPUT_BYTES);
  const boundedStderr = stderr.subarray(0, MAX_CARGO_OUTPUT_BYTES);
  writeOwnerOnlyFile(path.join(root, "stdout.log"), boundedStdout);
  writeOwnerOnlyFile(path.join(root, "stderr.log"), boundedStderr);
  if (boundedStdout.length > 0) process.stdout.write(boundedStdout);
  if (boundedStderr.length > 0) process.stderr.write(boundedStderr);
  return overflow;
}

export function writeInvocationManifest(root, redacted) {
  writeOwnerOnlyFile(
    path.join(root, "invocation-manifest.json"),
    `${JSON.stringify({
      ...redacted,
      schema_version: 1,
      status: "prepared",
    })}\n`,
  );
}

async function main() {
  const host = requireSupportedProviderConformanceHost();
  const testBinary = compileConformanceTest();
  const authority = createStateRoot();
  const root = authority.lexicalPath;
  let processReceipt;
  let providerReceipt;
  let retainedEvidencePath = root;
  try {
    const sourceSha256 = providerConformanceSourceHash();
    const packageEvidence = materializeEmbeddedPackageEvidence({
      root,
      sourceSha256,
      testBinary,
    });
    writeOwnerOnlyFile(
      path.join(root, "embedded-package-evidence.json"),
      `${JSON.stringify(packageEvidence)}\n`,
    );
    const invocation = conformanceCommand({
      host,
      packageEvidence,
      root,
      sourceSha256,
      testBinary,
    });
    writeInvocationManifest(root, invocation.redacted);
    const descriptorPath = path.join(root, "owned-process.json");
    const result = spawnSync(
      process.execPath,
      [
        processGroupRunner,
        invocation.mode,
        descriptorPath,
        "--",
        invocation.command,
        ...invocation.args,
      ],
      {
        cwd: repositoryRoot,
        env: process.env,
        maxBuffer: MAX_CARGO_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: MAX_CONFORMANCE_RUNTIME_MS,
      },
    );
    let verificationError;
    try {
      const descriptor = readOwnedProcessGroup(descriptorPath);
      processReceipt = await verifyOwnedProcessTreeExited(descriptor);
      const finalLedger = readOwnedProcessLedger(descriptor);
      assertSingleSessionLedger(descriptor, finalLedger, processReceipt, {
        requireBoundedProviderGroup: !result.error && result.status === 0,
      });
    } catch (error) {
      verificationError = error;
    }
    const outputOverflow = persistAndReplayOutput(root, result);
    if (verificationError) throw verificationError;
    if (outputOverflow) {
      throw new Error(
        `provider conformance output exceeded ${MAX_CARGO_OUTPUT_BYTES} bytes`,
      );
    }
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `provider conformance exited with ${result.status ?? result.signal ?? "unknown"}`,
      );
    }
    const expectedCapability = "exact_process_observation_v1";
    if (processReceipt.capability !== expectedCapability) {
      throw new Error(
        `provider conformance receipt capability was ${processReceipt.capability}`,
      );
    }
    const finalSourceSha256 = providerConformanceSourceHash();
    providerReceipt = readProviderConformanceReceipt(
      path.join(root, "state", PROVIDER_RECEIPT_FILE),
      invocation.expectedReceipt,
    );
    assertProviderSourceStable({
      finalSourceSha256,
      initialSourceSha256: sourceSha256,
      receipt: providerReceipt,
    });
    retireStateRoot(authority);
  } catch (error) {
    retainedEvidencePath = error?.retainedEvidencePath ?? retainedEvidencePath;
    console.error(`Provider conformance evidence retained at ${retainedEvidencePath}`);
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({
      process_receipt: processReceipt,
      provider_receipt: providerReceipt,
      status: "passed",
    })}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
