import { appRootUnder } from "./dure-home.mjs";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseQueuedDeployState } from "./dev-deploy-queue.mjs";
import { parseDevDeployExecutorGeneration } from "./dev-deploy-transaction.mjs";
import {
  devDeployRunnerGeneration,
  devDeployRunnerLiveness,
  parseDevDeployRunnerGeneration,
} from "./dev-deploy-runner-generation.mjs";
import {
  isProcessAlive,
  processIdentity,
} from "./process-identity.mjs";

export {
  isProcessAlive,
  processIdentity,
  processLiveness,
} from "./process-identity.mjs";

const MAX_STATE_BYTES = 1024 * 1024;

function safeLstat(pathname) {
  try {
    return lstatSync(pathname);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function ownerDirectory(directory, create) {
  let existing = safeLstat(directory);
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    throw new Error(`dev deploy queue directory is unsafe: ${directory}`);
  }
  if (!existing && !create) return false;
  if (!existing) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    existing = lstatSync(directory);
  }
  if (
    existing.isSymbolicLink() ||
    !existing.isDirectory() ||
    (existing.mode & 0o077) !== 0 ||
    (process.getuid && existing.uid !== process.getuid())
  ) {
    throw new Error(`dev deploy queue directory is not owner-only: ${directory}`);
  }
  return true;
}

function assertRegularFile(pathname, label) {
  const stat = safeLstat(pathname);
  if (stat?.isSymbolicLink() || (stat && !stat.isFile())) {
    throw new Error(`${label} is unsafe: ${pathname}`);
  }
  if (
    stat &&
    ((stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()))
  ) {
    throw new Error(`${label} is not owner-only: ${pathname}`);
  }
  return stat;
}

function readJsonFile(pathname, label) {
  const stat = assertRegularFile(pathname, label);
  if (!stat) return null;
  if (stat.size > MAX_STATE_BYTES) {
    throw new Error(`${label} exceeds ${MAX_STATE_BYTES} bytes`);
  }
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeJsonFile(pathname, value) {
  const directory = dirname(pathname);
  const temporary = `${pathname}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor = openSync(temporary, "wx", 0o600);
  let committed = false;
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, pathname);
    fsyncDirectory(directory);
    committed = true;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (!committed) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

function parseRunnerOwner(source) {
  let owner;
  try {
    owner = JSON.parse(source);
  } catch {
    throw new Error("dev deploy runner lease is invalid JSON");
  }
  try {
    if (owner?.executorGeneration !== undefined) {
      parseDevDeployExecutorGeneration(owner.executorGeneration);
    }
  } catch {
    throw new Error("dev deploy runner lease is invalid");
  }
  if (
    !Number.isSafeInteger(owner?.pid) ||
    owner.pid < 1 ||
    !Number.isSafeInteger(owner.startedAtMs) ||
    typeof owner.token !== "string" ||
    !/^[a-f0-9]{32}$/.test(owner.token) ||
    typeof owner.processIdentity !== "string" ||
    !owner.processIdentity
  ) {
    throw new Error("dev deploy runner lease is invalid");
  }
  parseDevDeployRunnerGeneration(
    owner.processGeneration,
    "dev deploy runner lease",
  );
  return owner;
}

function sameRunnerOwner(left, right) {
  if (!left || !right) return left === right;
  return left.token === right.token;
}

export class DevDeployQueueStore {
  constructor({
    homeDirectory = homedir(),
    alive = isProcessAlive,
    identity = processIdentity,
  } = {}) {
    const directory = join(appRootUnder(homeDirectory), "dev-deploy");
    this.paths = Object.freeze({
      directory,
      state: join(directory, "queue-v2.json"),
      database: join(directory, "coordination-v1.sqlite"),
      log: join(directory, "runner-v1.log"),
    });
    this.alive = alive;
    this.identity = identity;
    this.selfProcessIdentity = identity(process.pid);
    this.database = null;
  }

  close() {
    this.database?.close();
    this.database = null;
  }

  read() {
    if (!ownerDirectory(this.paths.directory, false)) return null;
    const value = readJsonFile(this.paths.state, "dev deploy queue state");
    return value ? parseQueuedDeployState(value) : null;
  }

  mutate(mutation) {
    return this.#transaction(() => {
      const current = this.read();
      const next = mutation(current);
      if (next) writeJsonFile(this.paths.state, parseQueuedDeployState(next));
      return next;
    });
  }

  acquireRunner(executorGeneration) {
    if (executorGeneration !== undefined) {
      parseDevDeployExecutorGeneration(
        executorGeneration,
        "dev deploy runner executor generation",
      );
    }
    if (!this.selfProcessIdentity) {
      throw new Error("cannot determine dev deploy runner process identity");
    }
    const observation = this.runnerLeaseObservation();
    const observed = observation.owner;
    if (observed && observation.liveness !== "stale") {
      return null;
    }
    const owner = {
      pid: process.pid,
      startedAtMs: Date.now(),
      token: randomBytes(16).toString("hex"),
      ...devDeployRunnerGeneration(this.selfProcessIdentity),
      ...(executorGeneration ? { executorGeneration } : {}),
    };
    return this.#transaction(() => {
      const current = this.#runnerOwner();
      if (!sameRunnerOwner(current, observed)) return null;
      this.database
        .prepare(
          "INSERT INTO runner_lease(singleton, owner_json) VALUES(1, ?) " +
            "ON CONFLICT(singleton) DO UPDATE SET owner_json = excluded.owner_json",
        )
        .run(JSON.stringify(owner));
      return owner;
    });
  }

  activeRunner() {
    const observation = this.runnerLeaseObservation();
    return observation.owner && observation.liveness !== "stale"
      ? observation.owner
      : null;
  }

  activeRunnerFor(executorGeneration) {
    parseDevDeployExecutorGeneration(
      executorGeneration,
      "dev deploy runner executor generation",
    );
    const owner = this.activeRunner();
    return owner?.executorGeneration === executorGeneration ? owner : null;
  }

  runnerLeaseObservation() {
    const owner = this.#runnerOwner();
    return {
      owner,
      liveness: devDeployRunnerLiveness(owner, this.alive, this.identity),
    };
  }

  workerLiveness(worker) {
    return devDeployRunnerLiveness(worker, this.alive, this.identity);
  }

  workerAlive(worker) {
    return this.workerLiveness(worker) !== "stale";
  }

  releaseRunner(owner) {
    if (!owner) return;
    this.#transaction(() => {
      const current = this.#runnerOwner();
      if (current?.token === owner.token) {
        this.database
          .prepare("DELETE FROM runner_lease WHERE singleton = 1")
          .run();
      }
    });
  }

  assertLogPath() {
    ownerDirectory(this.paths.directory, true);
    assertRegularFile(this.paths.log, "dev deploy queue log");
  }

  #runnerOwner() {
    this.#openDatabase();
    const row = this.database
      .prepare("SELECT owner_json FROM runner_lease WHERE singleton = 1")
      .get();
    return row ? parseRunnerOwner(row.owner_json) : null;
  }

  #transaction(action) {
    this.#openDatabase();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  #openDatabase() {
    if (this.database) return;
    ownerDirectory(this.paths.directory, true);
    this.database = new DatabaseSync(this.paths.database);
    chmodSync(this.paths.database, 0o600);
    this.database.exec("PRAGMA busy_timeout = 2000");
    this.database.exec("PRAGMA journal_mode = DELETE");
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS runner_lease (" +
        "singleton INTEGER PRIMARY KEY CHECK (singleton = 1), " +
        "owner_json TEXT NOT NULL)",
    );
  }
}
