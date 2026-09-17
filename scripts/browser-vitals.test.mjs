import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "browser:vitals", workspace_id: "workspace:one", generation: "generation:one" };
const page = { resource, page_id: "page:one", document_revision: "3" };
const lease = { resource, controller_id: "agent:one", epoch: "5" };
const control = { resource, controller: lease, current_page: page, next_command_sequence: "9" };
function fixture({ fault, controlled = true } = {}) {
  const calls = [];
  return { calls, run: args => collectBrowserCommand({
    args: ["--resource", resource.resource_id, "--idempotency-key", "vitals-once", ...(controlled ? ["--controller", lease.controller_id, "--epoch", lease.epoch] : []), ...args],
    sourceEnvironment: {}, cwd: "/task",
    resolveBackend: async () => ({ profile: { id: "chosen", transport: { kind: "ssh" } } }),
    requestBackend: async (_profile, { body }) => {
      calls.push(body);
      if (body.kind === "observe") return { result: { result: { control, pages: [{ page }] } } };
      if (fault) throw new Error("browser_response_lost");
      return { result: { result: { response: { success: true, data: { url: "https://example.test", ttfb: 12, report: "Page metrics" } } } } };
    },
  }) };
}

test.each([
  [["vitals"], undefined],
  [["vitals", "https://example.test/한글"], "https://example.test/한글"],
  [["vitals", "--url", "https://example.test"], "https://example.test"],
  [["web-vitals"], undefined],
  [["exec", "--command", "vitals"], undefined],
  [["exec", "--command", "web-vitals --json https://example.test"], "https://example.test"],
  [["exec", "--command", "vitals --url https://example.test --json"], "https://example.test"],
])("%j submits one reload measurement with the selected authority", async (args, url) => {
  const f = fixture(); const result = await f.run(args);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls.map(c => c.kind), ["observe", "action"]);
  assert.deepEqual(f.calls[1], { kind: "action", caller: lease.controller_id,
    authority: { lease, page, operation_id: "vitals-once", command_sequence: "9" },
    action: { kind: "vitals", ...(url === undefined ? {} : { url }) } });
  assert.equal(result.result.response.data.ttfb, 12);
});

test("a measurement requires control and never retries a lost result", async () => {
  const denied = fixture({ controlled: false });
  assert.equal((await denied.run(["vitals"])).ok, false);
  assert.equal(denied.calls.filter(c => c.kind === "action").length, 0);
  const lost = fixture({ fault: true }); const result = await lost.run(["vitals"]);
  assert.equal(result.ok, false); assert.equal(result.operation_id, "vitals-once");
  assert.equal(lost.calls.filter(c => c.kind === "action").length, 1);
});

test.each([
  ["vitals", "https://one.test", "https://two.test"],
  ["vitals", "javascript:alert(1)"], ["vitals", ""],
  ["exec", "--command", "vitals --backend foreign"],
  ["exec", "--command", "vitals --page foreign"],
].map(args => [args]))("invalid measurement %j fails before backend contact", async args => {
  const f = fixture(); assert.equal((await f.run(args)).ok, false); assert.deepEqual(f.calls, []);
});
