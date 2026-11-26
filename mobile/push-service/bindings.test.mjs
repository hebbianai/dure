import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { bindingId, createBindings, openBindings } from "./bindings.mjs";

const root = mkdtempSync(path.join(tmpdir(), "dure-push-bindings-test-"));
after(() => rmSync(root, { recursive: true }));
let directories = 0;
const directory = () => path.join(root, `state-${++directories}`);
const token = "ab".repeat(32);
const id = bindingId("sandbox", token);
const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
const otherKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString("base64url");
const NOW = 1_795_600_000_000;
const DAY = 24 * 60 * 60;
const record = (change = {}) => ({ key, epoch: 1, until: NOW / 1000 + 14 * DAY, boundAt: NOW / 1000, ...change });
const quiet = () => {
  const lines = [];
  const log = (line) => lines.push(line);
  log.lines = lines;
  return log;
};
const mode = (file) => statSync(file).mode & 0o777;

test("the record id is a one-way hash of the environment and the token", () => {
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.notEqual(bindingId("production", token), id);
  assert.notEqual(bindingId("sandbox", "cd".repeat(32)), id);
});

test("bindings survive a restart, and the files are private and hold no token", async () => {
  const state = directory();
  const first = await openBindings({ directory: state, now: () => NOW, log: quiet() });
  assert.equal(await first.put(id, record()), "saved");
  assert.equal(await first.put(id, record({ epoch: 2 })), "saved");
  const other = bindingId("production", "cd".repeat(32));
  assert.equal(await first.put(other, record({ key: otherKey })), "saved");
  assert.equal(await first.drop(other), "saved");
  await first.close();
  assert.equal(mode(state), 0o700);
  assert.equal(mode(path.join(state, "bindings.log")), 0o600);
  assert.equal(mode(path.join(state, "bindings.json")), 0o600);
  const journal = readFileSync(path.join(state, "bindings.log"), "utf8");
  assert.equal(journal.trim().split("\n").length, 4, "one fsynced line per change");
  for (const text of [journal, readFileSync(path.join(state, "bindings.json"), "utf8")]) {
    assert(!text.includes(token) && !text.includes("cd".repeat(32)), "no token");
    assert(!text.includes("SHA256:") && !text.includes("sandbox") && !text.includes("production"), "no computer or environment");
  }

  const second = await openBindings({ directory: state, now: () => NOW, log: quiet() });
  assert.deepEqual(second.get(id), record({ epoch: 2 }));
  assert.equal(second.get(other), undefined);
  assert.equal(readFileSync(path.join(state, "bindings.log"), "utf8"), "", "startup moves the journal into the snapshot");
  assert.deepEqual(JSON.parse(readFileSync(path.join(state, "bindings.json"), "utf8")), { version: 1, bindings: { [id]: record({ epoch: 2 }) } });
  await second.close();
});

test("a torn final journal line is ignored", async () => {
  const state = directory();
  const first = await openBindings({ directory: state, now: () => NOW, log: quiet() });
  await first.put(id, record());
  await first.close();
  writeFileSync(path.join(state, "bindings.log"), `${readFileSync(path.join(state, "bindings.log"), "utf8")}{"op":"put","id":"${id}","key":"${otherKey}","ep`);
  const log = quiet();
  const second = await openBindings({ directory: state, now: () => NOW, log });
  assert.equal(second.get(id).key, key);
  assert.deepEqual(log.lines, []);
  await second.close();
});

test("any other unreadable file is moved aside and the store starts empty", async () => {
  for (const [label, file, text] of [
    ["a snapshot that is not JSON", "bindings.json", "{"],
    ["a journal line in the middle that is not a change", "bindings.log", `{"op":"rename","id":"${id}"}\n{"op":"drop","id":"${id}"}\n`],
    ["a record without its key", "bindings.log", `{"op":"put","id":"${id}","epoch":1,"until":1,"boundAt":1}\n`],
  ]) {
    const state = directory();
    const first = await openBindings({ directory: state, now: () => NOW, log: quiet() });
    await first.put(id, record());
    await first.close();
    writeFileSync(path.join(state, file), text);
    const log = quiet();
    const second = await openBindings({ directory: state, now: () => NOW + 1, log });
    assert.equal(second.get(id), undefined, label);
    assert.deepEqual(log.lines, ["Push binding store was unreadable; moved it aside and started empty"], label);
    assert.deepEqual(readdirSync(state).sort(), ["bindings.json", `bindings.json.corrupt-${NOW + 1}`, "bindings.log", `bindings.log.corrupt-${NOW + 1}`], label);
    assert.equal(await second.put(id, record()), "saved", label);
    await second.close();
  }
});

test("the journal is folded into the snapshot through a staged file once it outgrows the live records", async () => {
  const state = directory();
  const bindings = await openBindings({ directory: state, now: () => NOW, log: quiet(), slack: 3 });
  const lines = () => readFileSync(path.join(state, "bindings.log"), "utf8").split("\n").filter(Boolean).length;
  for (let epoch = 1; epoch <= 5; epoch++) assert.equal(await bindings.put(id, record({ epoch })), "saved");
  assert.equal(lines(), 5, "2 * 1 live record + 3");
  assert.equal(await bindings.put(id, record({ epoch: 6 })), "saved");
  assert.equal(lines(), 0, "the sixth line folded them all");
  assert.deepEqual(JSON.parse(readFileSync(path.join(state, "bindings.json"), "utf8")).bindings[id], record({ epoch: 6 }));
  assert.deepEqual(readdirSync(state).sort(), ["bindings.json", "bindings.log"], "no staged file is left behind");
  assert.equal(mode(path.join(state, "bindings.json")), 0o600);
  await bindings.put(id, record({ epoch: 7 }));
  assert.equal(lines(), 1);
  await bindings.close();
  const reopened = await openBindings({ directory: state, now: () => NOW, log: quiet() });
  assert.equal(reopened.get(id).epoch, 7);
  await reopened.close();
});

test("records are pruned 30 days after their grant ends", async () => {
  let now = NOW;
  const bindings = createBindings({ now: () => now, log: quiet() });
  await bindings.put(id, record());
  now += (14 + 30) * DAY * 1000;
  assert(bindings.get(id), "kept through day 30 after the grant ended");
  now += 1000;
  assert.equal(bindings.get(id), undefined);

  const state = directory();
  const first = await openBindings({ directory: state, now: () => NOW, log: quiet() });
  await first.put(id, record());
  await first.close();
  const later = await openBindings({ directory: state, now: () => NOW + (44 * DAY + 1) * 1000, log: quiet() });
  assert.equal(later.size, 0);
  assert.deepEqual(JSON.parse(readFileSync(path.join(state, "bindings.json"), "utf8")).bindings, {});
  await later.close();
});

test("at the cap a new token is refused while existing records renew, and none is evicted", async () => {
  const log = quiet();
  const bindings = createBindings({ now: () => NOW, max: 5, log });
  const ids = ["01", "02", "03", "04", "05"].map((suffix) => bindingId("sandbox", suffix.repeat(32)));
  for (const [index, each] of ids.entries()) {
    assert.equal(await bindings.put(each, record()), "saved");
    assert.equal(log.lines.length, index >= 3 ? 1 : 0, "one warning at 80%");
  }
  assert.equal(bindings.full(), true);
  assert.equal(await bindings.put(id, record()), "capacity");
  assert.equal(bindings.get(id), undefined);
  assert.equal(await bindings.put(ids[0], record({ key: otherKey, epoch: 3 })), "saved", "a rebind is not a new record");
  assert.equal(bindings.size, 5);
  assert.deepEqual(log.lines, ["Push bindings reached 80% of capacity"]);
});

test("a change that cannot be written is undone and answered unavailable", async () => {
  const state = directory();
  const bindings = await openBindings({ directory: state, now: () => NOW, log: quiet() });
  assert.equal(await bindings.put(id, record()), "saved");
  await bindings.close();
  assert.equal(await bindings.put(id, record({ key: otherKey })), "unavailable");
  assert.equal(bindings.get(id).key, key, "the previous binding stands");
  assert.equal(await bindings.drop(id), "unavailable");
  assert.equal(bindings.get(id).key, key);
  const fresh = bindingId("production", token);
  assert.equal(await bindings.put(fresh, record()), "unavailable");
  assert.equal(bindings.get(fresh), undefined);
});

test("a directory that cannot be written fails when the store opens", async () => {
  const blocked = path.join(root, "not-a-directory");
  writeFileSync(blocked, "");
  await assert.rejects(openBindings({ directory: blocked, now: () => NOW, log: quiet() }));
});
