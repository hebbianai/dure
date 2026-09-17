import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

test("invalid dialog proposals fail before contacting a backend", async () => {
  for (const values of [[], ["unknown"], ["dismiss", "text"], ["status", "text"], ["accept", "a", "b"], ["accept", "한".repeat(22000)]]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args: ["dialog", "r", ...values, "--page", "p"], resolveBackend: async () => { contacts++; throw new Error("unexpected backend"); } });
    assert.equal(contacts, 0);
    assert.equal(result.error.code, "browser_dialog_invalid");
  }
});

test("dialog response uses the observed dialog and sequence without ordinary observation or retry", async () => {
  const page = { resource: { resource_id: "r", generation: "g", workspace_id: "w" }, page_id: "p", document_revision: "7" };
  const identity = { page, revision: "23" };
  const lease = { resource: page.resource, controller_id: "agent", epoch: "9" };
  const calls = [];
  const result = await collectBrowserCommand({ args: ["dialog", "r", "accept", "--page", "p", "--controller", "agent", "--epoch", "9", "--idempotency-key", "answer", "--", "--help"],
    resolveBackend: async () => ({ profile: { id: "test" } }),
    requestBackend: async (_profile, request) => {
      calls.push(request);
      assert.ok(request.requiredCapabilities.includes("browser.resource.v1"));
      if (request.body.kind === "dialog_state") return { result: { result: { page, control: { resource: page.resource, controller: lease, next_command_sequence: "11", in_flight: "click" }, dialog: { identity } } } };
      return { result: { result: { response: { success: true } } } };
    } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.body.kind), ["dialog_state", "dialog_respond"]);
  assert.deepEqual(calls[1].body, { kind: "dialog_respond", caller: "agent", authority: { lease, page, operation_id: "answer", command_sequence: "11" }, dialog: identity, response: { kind: "accept", text: "--help" } });
});
