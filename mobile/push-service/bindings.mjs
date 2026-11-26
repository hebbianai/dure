// Proven push bindings (#660): which phone key receives a token's alerts.
//
// A binding is written only after its key proved, by signing back a
// challenge alert, that its phone receives the token's alerts. A record
// holds a one-way hash of the environment and token, the phone's public key,
// the grant epoch and how long the latest grant lasts: never the token, a
// computer's fingerprint, an event or a language.
//
// On disk: an append-only journal (one JSON line per change, fsynced before
// the change is answered) and a snapshot, rewritten through a staged file at
// startup and whenever the journal grows past twice the live records. Losing
// both only pauses alerts until each phone proves receipt again.
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

export const MAX_BINDINGS = 100_000;
const WARN_RATIO = 0.8;
const PRUNE_AFTER_SECS = 30 * 24 * 60 * 60;
const SNAPSHOT = "bindings.json";
const JOURNAL = "bindings.log";
const SNAPSHOT_VERSION = 1;
const defaultLog = (line) => process.stderr.write(`${line}\n`);

/** The record id of one token in one APNs environment. */
export function bindingId(environment, token) {
  return createHash("sha256").update(`dure-push-binding-v1\0${environment}\0${token}`).digest("hex");
}

class Corrupt extends Error {}
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const isId = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** `{ key, epoch, until, boundAt }`: an unpadded base64url P-256 point and Unix seconds. */
function readRecord(value) {
  if (!plainObject(value) || typeof value.key !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(value.key) || !count(value.epoch) || !count(value.until) || !count(value.boundAt)) throw new Corrupt();
  return Object.freeze({ key: value.key, epoch: value.epoch, until: value.until, boundAt: value.boundAt });
}

/** Records are kept until 30 days after their latest grant ends. */
const stale = (record, now) => record.until + PRUNE_AFTER_SECS < Math.floor(now() / 1000);
function prune(records, now) {
  for (const [id, record] of records) if (stale(record, now)) records.delete(id);
}

function store(records, journal, { now, max, log }) {
  let warned = false;
  const full = () => {
    if (records.size < max) return false;
    prune(records, now);
    return records.size >= max;
  };
  // The change is already in memory, so a concurrent request sees it. It is
  // undone only if it is still the latest change of that record.
  const persist = (entry, undo) => (journal ? journal.append(entry) : Promise.resolve()).then(() => "saved", () => { undo(); return "unavailable"; });
  return {
    get(id) {
      const record = records.get(id);
      if (record && stale(record, now)) {
        records.delete(id);
        return undefined;
      }
      return record;
    },
    /** Whether a new token would be refused for capacity. */
    full,
    /** Binds, rebinds or renews: `saved`, `capacity` (a new token while full) or `unavailable`. */
    put(id, value) {
      if (!isId(id)) throw new TypeError("Invalid binding id");
      const record = readRecord(value);
      const previous = records.get(id);
      if (!previous && full()) return Promise.resolve("capacity");
      records.set(id, record);
      if (!warned && records.size >= max * WARN_RATIO) {
        warned = true;
        log("Push bindings reached 80% of capacity");
      }
      return persist({ op: "put", id, ...record }, () => {
        if (records.get(id) !== record) return;
        if (previous) records.set(id, previous);
        else records.delete(id);
      });
    },
    drop(id) {
      const previous = records.get(id);
      if (!previous) return Promise.resolve("saved");
      records.delete(id);
      return persist({ op: "drop", id }, () => {
        if (!records.has(id)) records.set(id, previous);
      });
    },
    get size() { return records.size; },
    close: () => journal?.close() ?? Promise.resolve(),
  };
}

/** Bindings in memory only, for tests and a service run without a state directory. */
export function createBindings({ now = Date.now, max = MAX_BINDINGS, log = defaultLog } = {}) {
  return store(new Map(), null, { now, max, log });
}

async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function load(snapshotFile, journalFile) {
  const records = new Map();
  const snapshot = await readIfPresent(snapshotFile);
  if (snapshot !== undefined) {
    let value;
    try { value = JSON.parse(snapshot); } catch { throw new Corrupt(); }
    if (!plainObject(value) || value.version !== SNAPSHOT_VERSION || !plainObject(value.bindings)) throw new Corrupt();
    for (const [id, record] of Object.entries(value.bindings)) {
      if (!isId(id)) throw new Corrupt();
      records.set(id, readRecord(record));
    }
  }
  const lines = (await readIfPresent(journalFile) ?? "").split("\n");
  // After the last newline: nothing, or a line torn by a crash. A torn line
  // was never fsynced, so its change was never answered as saved.
  lines.pop();
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { throw new Corrupt(); }
    if (!plainObject(entry) || !isId(entry.id)) throw new Corrupt();
    if (entry.op === "put") records.set(entry.id, readRecord(entry));
    else if (entry.op === "drop" && Object.keys(entry).length === 2) records.delete(entry.id);
    else throw new Corrupt();
  }
  return records;
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeSnapshot(directory, records) {
  const target = path.join(directory, SNAPSHOT);
  const staged = `${target}.tmp`;
  const handle = await open(staged, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify({ version: SNAPSHOT_VERSION, bindings: Object.fromEntries(records) }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(staged, target);
  await syncDirectory(directory);
}

/**
 * Bindings kept in `directory`. Opening reads the snapshot and replays the
 * journal, then rewrites the snapshot and starts an empty journal, so a
 * directory that cannot be written fails here, at startup.
 *
 * A file that cannot be read is moved aside and the store starts empty:
 * every binding needs a fresh proof of receipt, so starting empty pauses
 * alerts and opens no takeover.
 */
export async function openBindings({ directory, now = Date.now, max = MAX_BINDINGS, log = defaultLog, slack = 1000 }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const snapshotFile = path.join(directory, SNAPSHOT);
  const journalFile = path.join(directory, JOURNAL);
  let records;
  try {
    records = await load(snapshotFile, journalFile);
  } catch (error) {
    if (!(error instanceof Corrupt)) throw error;
    const aside = `.corrupt-${now()}`;
    for (const file of [snapshotFile, journalFile]) {
      await rename(file, `${file}${aside}`).catch((reason) => { if (reason.code !== "ENOENT") throw reason; });
    }
    log("Push binding store was unreadable; moved it aside and started empty");
    records = new Map();
  }
  prune(records, now);
  await writeSnapshot(directory, records);
  const reset = await open(journalFile, "w", 0o600);
  try { await reset.chmod(0o600); await reset.sync(); } finally { await reset.close(); }
  await chmod(journalFile, 0o600);
  const handle = await open(journalFile, "a", 0o600);

  let tail = Promise.resolve();
  let queued = 0;
  let bytes = 0;
  let lines = 0;
  let broken = false;
  const compact = async () => {
    prune(records, now);
    await writeSnapshot(directory, records);
    await handle.truncate(0);
    await handle.sync();
    bytes = 0;
    lines = 0;
  };
  const journal = {
    append(entry) {
      queued++;
      const run = tail.then(async () => {
        if (broken) throw new Error("The binding journal is unavailable");
        const line = `${JSON.stringify(entry)}\n`;
        try {
          await handle.appendFile(line);
          await handle.sync();
        } catch (error) {
          // Cut a partly written line off, so the next one starts clean.
          try { await handle.truncate(bytes); await handle.sync(); } catch { broken = true; }
          throw error;
        }
        bytes += Buffer.byteLength(line);
        lines++;
        // Only while nothing else is queued is memory exactly what the
        // journal holds, so only then may it become the snapshot.
        if (queued === 1 && lines > 2 * records.size + slack) {
          await compact().catch(() => log("Push binding snapshot could not be rewritten"));
        }
      }).finally(() => { queued--; });
      tail = run.catch(() => {});
      return run;
    },
    async close() {
      await tail;
      await handle.close();
    },
  };
  return store(records, journal, { now, max, log });
}
