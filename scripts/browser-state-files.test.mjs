import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const state = { cookies: [{ name: "session", value: "fixture", domain: "example.test", path: "/" }], origins: [{ origin: "https://example.test", localStorage: [{ name: "한글", value: "저장 값" }], sessionStorage: [] }] };
const password = "state file fixture 암호";
const key = createHash("sha256").update(password).digest();
const nonce = Buffer.from("000102030405060708090a0b", "hex");
const cipher = createCipheriv("aes-256-gcm", key, nonce);
const ciphertext = Buffer.concat([nonce, cipher.update(JSON.stringify(state)), cipher.final(), cipher.getAuthTag()]);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dure-state-files-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "data"), directory = join(home, "browser", "states");
  const environment = { DURE_HOME: home };
  const run = (args, extra = {}) => collectBrowserCommand({ args, sourceEnvironment: { ...environment, ...extra }, cwd: root,
    resolveBackend: () => { throw Error("local file command resolved a backend"); },
    requestBackend: () => { throw Error("local file command dispatched a browser request"); },
  });
  return { root, directory, environment, run };
}

test("managed list/clean/clear work without a backend or a directory and do not create one", async () => {
  const f = await fixture();
  const listed = await f.run(["state", "list"]);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.result, { directory: f.directory, files: [] });
  assert.deepEqual((await f.run(["state", "clean"])).result, { cleaned: 0, keptCount: 0, days: 30 });
  assert.deepEqual((await f.run(["state", "clear"])).result, { deleted: 0 });
  assert.deepEqual(await readdir(f.root), []);
});

test.each(["direct", "exec"])("listing and age cleanup affect only immediate regular managed state files: %s", async (syntax) => {
  const f = await fixture();
  await mkdir(f.directory, { recursive: true, mode: 0o700 });
  for (const name of ["old.json", "new.json.enc", "keep.txt"]) await writeFile(join(f.directory, name), name === "new.json.enc" ? ciphertext : JSON.stringify(state));
  await mkdir(join(f.directory, "nested.json"));
  await writeFile(join(f.directory, "nested.json", "inside.json"), "nested");
  const outside = join(f.root, "outside.json"); await writeFile(outside, "workspace data");
  await symlink(outside, join(f.directory, "linked.json"));
  await utimes(join(f.directory, "old.json"), new Date(0), new Date(0));
  const listed = await f.run(["state", "list"]);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.result.files.map(f => f.filename), ["new.json.enc", "old.json"]);
  assert.equal(listed.result.files[0].encrypted, true);
  assert.equal(listed.result.files[0].size, ciphertext.length);
  assert.equal(listed.result.files[1].modified, 0);
  const cleaned = await f.run(syntax === "exec" ? ["exec", "browser:context", "--command", "state clean --days 1"] : ["state", "clean", "--days", "1"]);
  assert.equal(cleaned.ok, true, JSON.stringify(cleaned));
  assert.deepEqual(cleaned.result, { cleaned: 1, keptCount: 1, days: 1 });
  assert.deepEqual((await f.run(["state", "clear"])).result, { deleted: 1 });
  assert.deepEqual((await readdir(f.directory)).sort(), ["keep.txt", "linked.json", "nested.json"]);
  assert.equal(await readFile(outside, "utf8"), "workspace data");
  assert.equal(await readFile(join(f.directory, "nested.json", "inside.json"), "utf8"), "nested");
});

test.each(["direct", "exec"])("local show and rename preserve encrypted bytes and explicit caller paths: %s", async (syntax) => {
  const f = await fixture();
  await writeFile(join(f.root, "state file.json.enc"), ciphertext, { mode: 0o600 });
  const invoke = (command, extra) => f.run(syntax === "exec" ? ["exec", "browser:context", "--command", command] : ["state", ...command.slice(6).match(/"[^"]+"|[^ ]+/g).map(s => s.replaceAll('"', ""))], extra);
  const shown = await invoke('state show "state file.json.enc"', { AGENT_BROWSER_ENCRYPTION_KEY: password });
  assert.equal(shown.ok, true, JSON.stringify(shown));
  assert.deepEqual(shown.result.state, state);
  assert.equal(shown.result.encrypted, true);
  assert.equal(shown.result.summary, "1 cookies, 1 origins");
  assert.equal(JSON.stringify(shown).includes(password), false);
  const renamed = await invoke('state rename "state file.json.enc" "한글 이름"');
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.equal(renamed.result.to, join(f.root, "한글 이름.json.enc"));
  assert.deepEqual(await readFile(renamed.result.to), ciphertext);
  assert.equal((await stat(renamed.result.to)).mode & 0o777, 0o600);
  const removed = await f.run(["state", "clear", "한글 이름.json.enc"]);
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.deepEqual(await readdir(f.root), []);
});

test("show authenticates encrypted files and rejects invalid JSON/shape and oversized inputs", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "valid.json"), JSON.stringify(state));
  assert.deepEqual((await f.run(["state", "show", "valid.json"])).result?.state, state);
  await writeFile(join(f.root, "state.enc"), ciphertext);
  const tampered = Buffer.from(ciphertext); tampered[tampered.length - 1] ^= 1;
  await writeFile(join(f.root, "tampered.enc"), tampered);
  await writeFile(join(f.root, "truncated.enc"), ciphertext.subarray(0, 27));
  for (const [file, text] of [["bad.json", "{"], ["shape.json", '{"cookies":false,"origins":[]}']]) await writeFile(join(f.root, file), text);
  for (const [file, secret, code] of [
    ["state.enc", undefined, "browser_state_key_required"],
    ["state.enc", "wrong key", "browser_state_decryption_failed"],
    ["tampered.enc", password, "browser_state_decryption_failed"],
    ["truncated.enc", password, "browser_state_decryption_failed"],
    ["bad.json", undefined, "browser_state_file_invalid"],
    ["shape.json", undefined, "browser_state_file_invalid"],
  ]) {
    const result = await f.run(["state", "show", file], secret === undefined ? {} : { DURE_BROWSER_ENCRYPTION_KEY: secret });
    assert.equal(result.ok, false, file); assert.equal(result.error.code, code, file);
    assert.equal(result.result, undefined);
  }
  const { open } = await import("node:fs/promises");
  const file = await open(join(f.root, "large.json"), "wx");
  try { await file.truncate(64 * 1024 * 1024 + 1); } finally { await file.close(); }
  assert.equal((await f.run(["state", "show", "large.json"])).error.code, "browser_state_file_too_large");
});

test("rename cannot overwrite another file, escape the directory or act through a symlink", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "source.json"), JSON.stringify(state));
  await writeFile(join(f.root, "target.json"), "retained");
  await symlink(join(f.root, "target.json"), join(f.root, "link.json"));
  for (const args of [
    ["rename", "source.json", "target"], ["rename", "source.json", "../escape"],
    ["rename", "link.json", "renamed"], ["show", "link.json"], ["clear", "link.json"],
    ["clean", "--days", "-1"], ["clean", "--days", "1.5"], ["clean", "--days", ""], ["clean", "--days", " "], ["clean", "--days", "0x10"], ["clear", "source.json", "extra"], ["list", "--days", "1"],
  ]) assert.equal((await f.run(["state", ...args])).ok, false, JSON.stringify(args));
  assert.equal(await readFile(join(f.root, "target.json"), "utf8"), "retained");
  assert.deepEqual(JSON.parse(await readFile(join(f.root, "source.json"), "utf8")), state);
});
