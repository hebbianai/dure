import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const OWNER_FILE = /^owner-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;

function readOwner(directory) {
  try {
    if (!lstatSync(directory).isDirectory()) return null;
    const entries = readdirSync(directory);
    if (entries.length !== 1) return null;
    const match = OWNER_FILE.exec(entries[0]);
    if (!match) return null;
    const pathname = join(directory, entries[0]);
    const stat = lstatSync(pathname);
    if (!stat.isFile() || stat.size > 4096) return null;
    const owner = JSON.parse(readFileSync(pathname, "utf8"));
    if (
      owner.schemaVersion !== 1 || owner.generation !== match[1] ||
      owner.hostname !== hostname() ||
      !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    ) return null;
    return { directory, pathname, pid: owner.pid };
  } catch {
    // Incomplete publication, legacy locks and observation failures are unknown.
    return null;
  }
}

function ownerAbsent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // A reused PID stays protected. Neither age nor an observation error proves
    // absence; only the OS's ESRCH result authorizes recovery.
    return error?.code === "ESRCH";
  }
}

export function releaseDureCliMutationLock(lock) {
  try {
    unlinkSync(lock.pathname);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  // Only the winner of the generation-specific unlink may remove the directory.
  // A losing reclaimer must not remove a successor's newly-created empty lock.
  rmdirSync(lock.directory);
  return true;
}

export function acquireDureCliMutationLock(installRoot, lockWaitMs) {
  const directory = join(installRoot, ".mutation-lock");
  const owner = {
    schemaVersion: 1,
    generation: randomUUID(),
    hostname: hostname(),
    pid: process.pid,
  };
  const pathname = join(directory, `owner-${owner.generation}.json`);
  const startedAt = performance.now();
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  let recovered = false;
  for (;;) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // Allow one immediate recovery even for a nonblocking caller, but never
      // extend the wait budget by repeatedly recovering terminated contenders.
      const previous = !recovered || performance.now() - startedAt < lockWaitMs
        ? readOwner(directory)
        : null;
      if (previous && ownerAbsent(previous.pid)) {
        if (releaseDureCliMutationLock(previous)) {
          recovered = true;
          continue;
        }
      }
      if (performance.now() - startedAt >= lockWaitMs) {
        throw new Error(`another Dure CLI install holds ${directory}`, { cause: error });
      }
      Atomics.wait(sleep, 0, 0, Math.min(50, lockWaitMs - (performance.now() - startedAt)));
      continue;
    }
    // Publish before any protected mutation. An interruption during publication
    // leaves an unknown lock, which requires explicit operator reconciliation.
    writeFileSync(pathname, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
    return Object.freeze({ directory, pathname });
  }
}
