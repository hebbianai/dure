import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";
import { encodeRef } from "../cli/lib/browser-reference.mjs";

const resource = { resource_id: "highlight-resource", generation: "generation", workspace_id: "workspace" };
const page = { resource, page_id: "page", document_revision: "4" };
const lease = { resource, controller_id: "agent", epoch: "8" };
const snapshot = { page, revision: "12" };
const view = { control: { resource, controller: lease, next_command_sequence: "7" }, pages: [{ page }] };
const authority = ["--page", page.page_id, "--controller", lease.controller_id, "--epoch", lease.epoch];

function fixture({ observed = view, loseResponse = false } = {}) {
  const calls = [];
  const run = (values, flags = authority) => collectBrowserCommand({
    args: ["highlight", resource.resource_id, ...values, ...flags, "--idempotency-key", "highlight-operation"],
    resolveBackend: async () => ({ profile: { id: "backend" } }),
    requestBackend: async (_profile, request) => {
      calls.push(request);
      if (request.body.kind === "observe") return { result: { result: observed } };
      if (loseResponse) throw new Error("browser_response_lost");
      return { result: { result: { response: { success: true, data: { highlighted: true } } } } };
    },
  });
  return { run, calls };
}

test("highlight dispatches a CSS target under the exact observed authority", async () => {
  const { run, calls } = fixture();
  const result = await run(["#disabled"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls.map((call) => call.body.kind), ["observe", "action"]);
  assert.deepEqual(calls[1].requiredCapabilities, ["browser.resource.v1"]);
  assert.deepEqual(calls[1].body, {
    kind: "action", caller: lease.controller_id,
    authority: { lease, page, operation_id: "highlight-operation", command_sequence: "7" },
    action: { kind: "highlight", target: { kind: "css", selector: "#disabled" } },
  });
});

test("highlight preserves snapshot identity and permits the reference to supply its page", async () => {
  const { run, calls } = fixture();
  const result = await run([encodeRef(snapshot, "e9")], authority.slice(2));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls[1].body.action, { kind: "highlight", target: { kind: "reference", reference: { snapshot, element: "e9" } } });
  assert.deepEqual(calls[1].body.authority.page, page);
});

test("highlight rejects missing or obsolete controller authority and unobserved CSS pages", async () => {
  for (const flags of [["--page", page.page_id], [...authority.slice(0, 3), "other", "--epoch", lease.epoch], [...authority.slice(0, 5), "stale"]]) {
    const { run, calls } = fixture();
    const result = await run(["#target"], flags);
    assert.equal(result.error.code, "browser_controller_changed");
    assert.deepEqual(calls.map((call) => call.body.kind), ["observe"]);
  }
  const { run, calls } = fixture({ observed: { ...view, pages: [] } });
  assert.equal((await run(["#target"])).error.code, "browser_page_required");
  assert.equal(calls.length, 1);
});

test("highlight rejects references to another page or resource before action dispatch", async () => {
  for (const other of [{ ...page, page_id: "other" }, { ...page, resource: { ...resource, resource_id: "other" } }]) {
    const { run, calls } = fixture();
    const result = await run([encodeRef({ ...snapshot, page: other }, "e9")]);
    assert.equal(result.error.code, "browser_reference_page_mismatch");
    assert.equal(calls.length, 1);
  }
  const { run, calls } = fixture();
  assert.equal((await run(["@e9"])).error.code, "browser_reference_invalid");
  assert.equal(calls.length, 1);
});

test("highlight arity errors do not contact the backend", async () => {
  for (const values of [[], ["#one", "#two"]]) {
    const { run, calls } = fixture();
    assert.equal((await run(values)).error.code, "browser_command_invalid");
    assert.equal(calls.length, 0);
  }
});

test("highlight retains its operation ID after response loss without redispatching", async () => {
  const { run, calls } = fixture({ loseResponse: true });
  const result = await run(["#target"]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "browser_response_lost");
  assert.equal(result.operation_id, "highlight-operation");
  assert.deepEqual(calls.map((call) => call.body.kind), ["observe", "action"]);
});
