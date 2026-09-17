import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, mkdtempSync, readFileSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertOwnerOnlyDirectory,
  createDescriptor,
  descriptorPath,
  readDescriptor,
  writeDescriptor,
} from "../lib/dev-launch-client.mjs";
import {
  DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
  DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
} from "../lib/dev-launch-contract.mjs";
import { openDevLaunchLog } from "../lib/dev-launch-storage.mjs";

function icacls(pathname, ...args) {
  const systemRoot = process.env.SystemRoot;
  assert.ok(
    systemRoot && win32.isAbsolute(systemRoot),
    "Windows SystemRoot must be absolute",
  );
  const result = spawnSync(
    win32.join(systemRoot, "System32", "icacls.exe"),
    [pathname, ...args],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout;
}

function permissions(pathname) {
  return process.platform === "win32" ? icacls(pathname) : statSync(pathname).mode;
}

function exposeToOtherUsers(pathname, mode) {
  if (process.platform === "win32") icacls(pathname, "/grant", "*S-1-1-0:(R)");
  else chmodSync(pathname, mode);
}

export function runDevLaunchStorageSmoke() {
  const fixture = mkdtempSync(join(tmpdir(), "dure-dev-storage-"));
  const home = join(fixture, "private home");
  const channel = "dev-storage-fixture";
  const worktreeRoot = join(fixture, "worktree");
  const pathname = descriptorPath(home, channel);
  const options = { home, channel, worktreeRoot };
  const initial = {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    state: "preparing",
    worktreeRoot,
    channel,
    socketPath: join(fixture, "unused-endpoint"),
    capability: "c".repeat(64),
    capabilities: [],
    sourceGeneration: "d".repeat(64),
    supervisor: {
      pid: process.pid,
      processIdentity: "storage-only-fixture",
      generation: "a".repeat(64),
    },
    launch: null,
    publishedAtMs: Date.now(),
  };
  try {
    // Detached startup opens the log before publishing the control descriptor.
    const firstLog = openDevLaunchLog(home, channel);
    try {
      writeFileSync(firstLog.descriptor, "first\n");
      const nextLog = openDevLaunchLog(home, channel);
      try {
        writeFileSync(nextLog.descriptor, "second\n");
      } finally {
        closeSync(nextLog.descriptor);
      }
    } finally {
      closeSync(firstLog.descriptor);
    }
    const logPath = join(dirname(pathname), "dev-launch.log");
    assert.equal(readFileSync(logPath, "utf8"), "first\nsecond\n");

    assertOwnerOnlyDirectory(dirname(pathname), { create: true });
    createDescriptor(pathname, initial);
    assert.equal(readDescriptor(options).value.state, "preparing");
    assert.throws(() => createDescriptor(pathname, initial));
    assert.equal(readDescriptor(options).value.capability, initial.capability);

    const ready = {
      ...initial,
      state: "ready",
      launch: {
        pid: process.pid + 1,
        processIdentity: "storage-only-child-fixture",
        generation: "b".repeat(64),
      },
    };
    writeDescriptor(pathname, ready);
    const reread = readDescriptor(options).value;
    assert.equal(reread.state, "ready");
    assert.deepEqual(reread.launch, ready.launch);
    assert.equal(reread.capability, initial.capability);

    const directoryLink = join(fixture, "directory-link");
    symlinkSync(dirname(pathname), directoryLink, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => assertOwnerOnlyDirectory(directoryLink, { create: true }));
    const logTarget = join(dirname(pathname), "log-target");
    renameSync(logPath, logTarget);
    symlinkSync(logTarget, logPath, "file");
    assert.throws(() => openDevLaunchLog(home, channel));
    assert.equal(readFileSync(logTarget, "utf8"), "first\nsecond\n");

    const source = readFileSync(pathname, "utf8");
    exposeToOtherUsers(pathname, 0o644);
    const filePermissions = permissions(pathname);
    assert.throws(() => readDescriptor(options));
    assert.equal(readFileSync(pathname, "utf8"), source);
    assert.equal(permissions(pathname), filePermissions);

    exposeToOtherUsers(dirname(pathname), 0o755);
    const directoryPermissions = permissions(dirname(pathname));
    assert.throws(() => assertOwnerOnlyDirectory(dirname(pathname), { create: true }));
    assert.equal(permissions(dirname(pathname)), directoryPermissions);

    if (process.platform === "win32") {
      const inherited = join(fixture, "inherited-directory");
      assertOwnerOnlyDirectory(inherited, { create: true });
      icacls(inherited, "/inheritancelevel:e");
      const inheritedPermissions = permissions(inherited);
      assert.throws(() => assertOwnerOnlyDirectory(inherited, { create: true }));
      assert.equal(permissions(inherited), inheritedPermissions);
    }
    return {
      schemaVersion: 1,
      platform: process.platform,
      create: "verified",
      exclusiveCreate: "verified",
      publishAndReread: "verified",
      appendLog: "verified",
      linksRejected: "verified",
      unsafePermissionsPreserved: "verified",
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(runDevLaunchStorageSmoke()));
}
