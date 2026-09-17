import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const password = "fixture 암호화 secret";
const key = createHash("sha256").update(password).digest();
const plaintext = Buffer.from(JSON.stringify({ cookies: [], origins: [{ origin: "https://example.test", localStorage: [{ name: "secret", value: "x".repeat(130000) }] }] }));
const nonce = Buffer.from("000102030405060708090a0b", "hex");
const cipher = createCipheriv("aes-256-gcm", key, nonce);
const encrypted = Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
const resource = { resource_id: "state-resource", generation: "generation", workspace_id: "workspace" };
const page = { resource, page_id: "page", document_revision: "3" };
const lease = { resource, controller_id: "state-proof", epoch: "4" };

async function fixture(environment, { confirmEncryption = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dure-state-encryption-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "input.json.enc"), encrypted);
  await writeFile(join(root, "plain.json"), plaintext);
  const calls = []; const chunks = [];
  const artifact = { size: encrypted.length, sha256: createHash("sha256").update(encrypted).digest("hex"), mimeType: "application/octet-stream" };
  return { root, calls, chunks, async run(values) {
    return collectBrowserCommand({ args: ["state", resource.resource_id, ...values, "--page", page.page_id, "--controller", lease.controller_id, "--epoch", lease.epoch, "--idempotency-key", "encryption-proof"], cwd: root, sourceEnvironment: environment,
      resolveBackend: async () => ({ profile: { id: "remote-state-backend" } }),
      requestBackend: async (_profile, { body }) => {
        calls.push(body);
        if (body.kind === "observe") return { result: { result: { control: { resource, current_page: page, controller: lease, next_command_sequence: "7" }, pages: [{ page }] } } };
        if (body.kind === "upload_chunk") {
          chunks.push(Buffer.from(body.chunk.base64, "base64"));
          const received = Buffer.concat(chunks).length;
          return { result: { result: { id: "a".repeat(64), file: body.chunk.file, received, complete: received === body.chunk.file.size } } };
        }
        if (body.kind === "action") return { result: { result: { response: { success: true, data: { encrypted: confirmEncryption } } } } };
        assert.equal(body.kind, "artifact");
        const part = encrypted.subarray(body.offset, body.offset + 64 * 1024);
        return { result: { artifact, offset: body.offset, base64: part.toString("base64"), eof: body.offset + part.length === encrypted.length } };
      },
    });
  } };
}

test.each(["DURE_BROWSER_ENCRYPTION_KEY", "AGENT_BROWSER_ENCRYPTION_KEY"])("encrypted save uses one derived key and publishes only verified ciphertext: %s", async (name) => {
  const f = await fixture({ [name]: password });
  const result = await f.run(["save", "export.json"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls.find((body) => body.kind === "action").action, { kind: "state_save", encryption_key: key.toString("hex") });
  assert.deepEqual(await readFile(join(f.root, "export.json.enc")), encrypted);
  assert.equal((await readdir(f.root)).includes("export.json"), false);
  assert.equal(JSON.stringify(f.calls).includes(password), false);
  assert.equal(JSON.stringify(result).includes(key.toString("hex")), false);
});

test.each(["input.json.enc", "input.json"])("encrypted load stages original ciphertext and derives its key without a plaintext file: %s", async (filename) => {
  const f = await fixture({ DURE_BROWSER_ENCRYPTION_KEY: password });
  const result = await f.run(["load", filename]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Buffer.concat(f.chunks), encrypted);
  assert.deepEqual(f.calls.find((body) => body.kind === "action").action, { kind: "state_load", file: "a".repeat(64), encryption_key: key.toString("hex") });
  assert.deepEqual((await readdir(f.root)).sort(), ["input.json.enc", "plain.json"]);
  assert.equal(JSON.stringify(f.calls).includes(password), false);
});

test("plain files stay plain with a configured key; missing, empty and conflicting keys cannot stage ciphertext", async () => {
  const plain = await fixture({ DURE_BROWSER_ENCRYPTION_KEY: password });
  assert.equal((await plain.run(["load", "plain.json"])).ok, true);
  assert.deepEqual(Buffer.concat(plain.chunks), plaintext);
  assert.equal(plain.calls.find((body) => body.kind === "action").action.encryption_key, undefined);
  for (const environment of [{}, { DURE_BROWSER_ENCRYPTION_KEY: "" }, { DURE_BROWSER_ENCRYPTION_KEY: password, AGENT_BROWSER_ENCRYPTION_KEY: "different" }]) {
    const f = await fixture(environment);
    const result = await f.run(["load", "input.json.enc"]);
    assert.equal(result.ok, false);
    assert.equal(f.calls.some((body) => ["upload_chunk", "action"].includes(body.kind)), false);
  }
});

test("encrypted save refuses an unconfirmed backend response before publishing a file", async () => {
  const f = await fixture({ DURE_BROWSER_ENCRYPTION_KEY: password }, { confirmEncryption: false });
  const result = await f.run(["save", "export.json"]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "browser_state_encryption_unconfirmed");
  assert.equal(f.calls.some((body) => body.kind === "artifact"), false);
  assert.deepEqual((await readdir(f.root)).sort(), ["input.json.enc", "plain.json"]);
});
