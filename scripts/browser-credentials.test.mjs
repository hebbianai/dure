import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const page = { resource: { resource_id: "r", generation: "g", workspace_id: "w" }, page_id: "p", document_revision: "4" };
const lease = { resource: page.resource, controller_id: "agent", epoch: "8" };
const shared = ["--page", "p", "--controller", "agent", "--epoch", "8"];

test("credentials use the existing header mutation with the caller's operation authority", async () => {
  for (const [values, expected] of [
    [["credentials", "--user", "사용자", "--pass", "암호:one"], "사용자:암호:one"],
    [["credentials", "", ""], ":"],
    [["auth", "empty", ""], "empty:"],
    [["credentials", "reset"], null],
  ]) {
    const calls = [];
    const result = await collectBrowserCommand({
      args: ["set", "r", ...shared, ...values, "--idempotency-key", "credential-once"],
      resolveBackend: async () => ({ profile: { id: "credential-test" } }),
      requestBackend: async (_profile, { body }) => {
        calls.push(body);
        return { result: { result: body.kind === "observe" ? { control: { resource: page.resource, controller: lease, next_command_sequence: "9" }, pages: [{ page }] } : { response: { success: true, data: { applied: true } } } } };
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(calls, [
      { kind: "observe", resource_id: "r" },
      { kind: "action", caller: "agent", authority: { lease, page, operation_id: "credential-once", command_sequence: "9" }, action: { kind: "environment", action: { kind: "headers", headers: expected === null ? {} : { authorization: `Basic ${Buffer.from(expected).toString("base64")}` } } } },
    ]);
    assert.equal(JSON.stringify(result).includes("authorization"), false);
  }
});

test("ambiguous or malformed credentials are rejected before any backend contact", async () => {
  for (const args of [
    ["set", "r", "credentials"], ["set", "r", "credentials", "user"],
    ["set", "r", "credentials", "--user", "user"], ["set", "r", "credentials", "--pass", "password"],
    ["set", "r", "credentials", "user", "password", "extra"],
    ["set", "r", "credentials", "user", "password", "--user", "different", "--pass", "different"],
    ["set", "r", "credentials", "reset", "--user", "user", "--pass", "password"],
    ["set", "r", "credentials", "bad:user", "password"], ["set", "r", "credentials", "user", "bad\npassword"],
    ["set", "r", "credentials", "user", "x".repeat(64 * 1024)],
    ["set", "r", "credentials", "user", "password", "--mobile"],
    ["set", "r", "headers", "{}", "--user", "user", "--pass", "password"],
    ["show", "r", "--user", "user"], ["headers", "r", "{}", "--pass", "password"],
  ]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args, resolveBackend: async () => { contacts++; throw new Error("unexpected backend contact"); } });
    assert.equal(contacts, 0);
    assert.equal(result.ok, false);
    assert.match(result.error.code, /^browser_(credentials|command|environment|headers)_invalid$/);
    assert.equal(JSON.stringify(result).includes("password"), false);
  }
});

test("stale controller credentials cannot dispatch a header mutation", async () => {
  let writes = 0;
  const result = await collectBrowserCommand({
    args: ["set", "r", "credentials", "user", "password", ...shared],
    resolveBackend: async () => ({ profile: { id: "credential-test" } }),
    requestBackend: async (_profile, { body }) => {
      if (body.kind === "action") writes++;
      return { result: { result: { control: { resource: page.resource, controller: { ...lease, epoch: "10" }, next_command_sequence: "9" }, pages: [{ page }] } } };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "browser_controller_changed");
  assert.equal(writes, 0);
});
