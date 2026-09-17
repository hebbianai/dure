#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { migrationIndex, orderMigrationIssues, readMigrationRecords, renderMigratedIssue } from "./lib/beads-github-migration.mjs";

const args = process.argv.slice(2);
function argument(name) {
  const value = args[args.indexOf(name) + 1];
  if (!args.includes(name) || !value || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
}
const repository = argument("--repository");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("Invalid repository");
const sourcePath = path.resolve(argument("--source"));
const statePath = path.resolve(argument("--state"));
const archivePath = argument("--archive");
const source = fs.readFileSync(sourcePath, "utf8");
const records = readMigrationRecords(source);
const sourceSha256 = crypto.createHash("sha256").update(source).digest("hex");
const pending = orderMigrationIssues(records);
const byId = new Map(records.filter((record) => record._type === "issue").map((record) => [record.id, record]));
const archiveCount = records.length - pending.length;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {
  schemaVersion: 1, repository, sourceSha256, archivePath, issues: {}, lastWriteAt: 0,
};
if (state.repository !== repository || state.sourceSha256 !== sourceSha256 || state.archivePath !== archivePath) {
  throw new Error("Resume receipt does not match the exact source and destination");
}
const preview = pending.map((record) => ({ sourceId: record.id, ...renderMigratedIssue(record, { repository, archivePath, records: byId, index: new Map() }) }));
if (!args.includes("--apply")) {
  console.log(JSON.stringify({ repository, sourceSha256, unfinished: pending.length, archivedRecords: archiveCount, labels: [...new Set(preview.flatMap((record) => record.labels))], largestBodyCharacters: Math.max(...preview.map((record) => [...record.body].length)) }, null, 2));
  process.exit(0);
}

fs.mkdirSync(path.dirname(statePath), { recursive: true });
const lockPath = `${statePath}.lock`;
const lock = fs.openSync(lockPath, "wx", 0o600);
fs.writeSync(lock, JSON.stringify({ pid: process.pid, sourceSha256, repository }));
function save() {
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statePath);
}
function gh(args, input) {
  return execFileSync("gh", args, { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] });
}
function read(endpoint, paginate = false) {
  return JSON.parse(gh(["api", endpoint, ...(paginate ? ["--paginate", "--slurp"] : [])]));
}
async function write(endpoint, body) {
  // Stay below GitHub's hourly content-creation limit, leaving room for collaborators.
  await delay(Math.max(0, state.lastWriteAt + 9_000 - Date.now()));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    state.lastWriteAt = Date.now();
    save();
    try {
      const response = gh(["api", "--include", "--method", "POST", endpoint, "--input", "-"], JSON.stringify(body));
      const separator = /\r?\n\r?\n/u.exec(response);
      if (!separator) throw new Error("Missing GitHub response headers");
      return JSON.parse(response.slice(separator.index + separator[0].length));
    } catch (error) {
      const diagnostic = `${error.stderr ?? ""}\n${error.stdout ?? ""}`;
      if (!/HTTP (403|429)/u.test(diagnostic) || !/rate limit|abuse detection/iu.test(diagnostic)) throw error;
      const retryAfter = /retry.after[^0-9]*(\d+)/iu.exec(diagnostic)?.[1];
      const resetAt = /x-ratelimit-reset[^0-9]*(\d+)/iu.exec(diagnostic)?.[1];
      const pause = Math.max(60_000 * 2 ** attempt, Number(retryAfter ?? 0) * 1000, Number(resetAt ?? 0) * 1000 - Date.now());
      console.log(`Rate limited; retaining progress and waiting ${Math.ceil(pause / 1000)} seconds.`);
      await delay(pause);
    }
  }
  throw new Error("Rate limit persisted; resume this exact receipt later");
}

try {
  const repo = read(`repos/${repository}`);
  if (!repo.private || !repo.has_issues || repo.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("Migration requires the exact private repository with Issues enabled");
  }
  const destinationIssues = read(`repos/${repository}/issues?state=all&per_page=100`, true).flat();
  const lookup = (number) => read(`repos/${repository}/issues/${number}`);
  const index = migrationIndex(destinationIssues, { receipts: state.issues, lookup });
  for (const [id, receipt] of index) {
    state.issues[id] = receipt;
  }
  state.inflight = null;
  save();
  const labels = new Set(read(`repos/${repository}/labels?per_page=100`, true).flat().map((label) => label.name));
  for (const name of new Set(preview.flatMap((record) => record.labels))) {
    if (labels.has(name)) continue;
    await write(`repos/${repository}/labels`, { name, color: name.startsWith("priority:p0") ? "B60205" : "6F42C1", description: name === "source:beads" ? "Imported from the preserved Beads tracker archive" : `Task ${name.replace(":", " ")}` });
    labels.add(name);
  }
  for (const record of pending) {
    if (index.has(record.id)) continue;
    state.inflight = record.id;
    save();
    const body = renderMigratedIssue(record, { repository, archivePath, records: byId, index });
    const created = await write(`repos/${repository}/issues`, body);
    if (created.title !== body.title || created.body !== body.body || created.state !== "open" || !body.labels.every((label) => created.labels.some((actual) => actual.name === label))) {
      throw new Error(`Creation receipt mismatch for ${record.id}; inspect before resuming`);
    }
    const receipt = { number: created.number, id: created.id, url: created.html_url };
    index.set(record.id, receipt);
    state.issues[record.id] = receipt;
    state.inflight = null;
    save();
    console.log(`${Object.keys(state.issues).length}/${pending.length} ${record.id} -> #${created.number}`);
  }
  const observed = migrationIndex(read(`repos/${repository}/issues?state=all&per_page=100`, true).flat(), { receipts: state.issues, lookup });
  for (const record of pending) {
    if (observed.get(record.id)?.number !== state.issues[record.id]?.number) throw new Error(`Final mapping mismatch: ${record.id}`);
  }
  state.completedAt = new Date().toISOString();
  state.verifiedCount = pending.length;
  save();
  console.log(`Migration verified: ${pending.length} unfinished issues; ${archiveCount} archived records.`);
} finally {
  fs.closeSync(lock);
  fs.unlinkSync(lockPath);
}
