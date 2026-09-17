import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "down", generation: "generation:one", workspace_id: "workspace:one" };
const page = { resource, page_id: "page:one", document_revision: "5" };
const lease = { resource, controller_id: "agent", epoch: "8" };
const control = { resource, controller: lease, current_page: page, next_command_sequence: "12" };
const authority = ["--controller", "agent", "--epoch", "8"];

function client({ observed = control, failAt } = {}) {
  const calls = [];
  const selected = [];
  return { calls, selected, run: (args) => collectBrowserCommand({
    args: ["--idempotency-key", "default:once", ...args], cwd: "/tasks/한글",
    resolveBackend: async (selection) => { selected.push(selection); return { profile: { id: "defaults", transport: { kind: "local" } } }; },
    requestBackend: async (profile, { body }) => {
      calls.push({ body, deadlineMs: profile.deadlineMs });
      if (body.kind === failAt) throw new Error("browser_response_lost");
      return { result: { result: body.kind === "list" ? { workspace_id: resource.workspace_id, resources: [control] }
        : body.kind === "observe" ? { control: observed, pages: [{ page }] } : { response: { success: true } } } };
    },
  }) };
}

test.each(["up", "down", "left", "right"])("named scroll %s defaults to 300 through the existing controlled action", async (direction) => {
  const explicit = client();
  const expected = await explicit.run(["scroll", resource.resource_id, direction, "300", ...authority]);
  assert.equal(expected.ok, true);
  for (const target of [["--resource", resource.resource_id], ["--worktree", "current"], []]) {
    const current = client();
    assert.deepEqual(await current.run(["scroll", "--direction", direction, ...target, ...authority]), expected);
    assert.deepEqual(current.calls.slice(target[0] === "--resource" ? 0 : 1), explicit.calls);
    assert.deepEqual(current.calls.at(-1).body.action, { kind: "scroll", direction, amount: 300 });
  }
});

const conditions = [
  ["url", "https://example.com/ready"], ["load", "domcontentloaded"],
  ["fn", "true"], ["text", "Ready"], ["selector", "input"],
];
const combinations = Array.from({ length: 31 }, (_, index) => conditions.filter((_, bit) => ((index + 1) & (1 << bit)) !== 0));

test.each(combinations.map((entries) => [entries]))("named wait %j selects the verified priority independently of flag order", async (entries) => {
  const [kind, value] = entries[0];
  const explicit = client();
  const extra = ["--timeout", "27", ...(kind === "selector" ? ["--state", "hidden"] : [])];
  const expected = await explicit.run(["wait", resource.resource_id, kind === "fn" ? "function" : kind, value, ...extra, ...authority]);
  assert.equal(expected.ok, true);
  for (const order of [entries, [...entries].reverse()]) {
    const current = client();
    const args = order.flatMap(([name, argument]) => [`--${name}`, argument]);
    const result = await current.run(["wait", ...args, "--state", "hidden", "--timeout", "27", "--resource", resource.resource_id, ...authority]);
    assert.deepEqual(result, expected);
    assert.deepEqual(current.calls, explicit.calls);
    assert.equal(current.calls.at(-1).deadlineMs, 45027);
    assert.equal(current.calls.filter(({ body }) => ["wait", "action"].includes(body.kind)).length, 1);
  }
});

test("an ignored function condition cannot execute or acquire a controller", async () => {
  for (const chosen of [["url", "https://example.com"], ["load", "domcontentloaded"]]) {
    const c = client({ observed: { ...control, controller: null } });
    const result = await c.run(["wait", `--${chosen[0]}`, chosen[1], "--fn", "throw new Error('must not run')", "--selector", "#missing", "--resource", resource.resource_id]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(c.calls.at(-1).body.wait.condition.kind, chosen[0]);
    assert.equal(c.calls.some(({ body }) => ["action", "control"].includes(body.kind)), false);
  }
  const chosenFunction = client({ observed: { ...control, controller: null } });
  const result = await chosenFunction.run(["wait", "--fn", "true", "--text", "Ready", "--resource", resource.resource_id]);
  assert.equal(result.ok, false);
  assert.equal(chosenFunction.calls.some(({ body }) => ["action", "control"].includes(body.kind)), false);
});

test("explicit scroll amounts and positional selector state remain unchanged", async () => {
  for (const amount of ["0", "1", "1000000"]) {
    const c = client();
    assert.equal((await c.run(["scroll", "--direction", "down", "--amount", amount, "--resource", resource.resource_id, ...authority])).ok, true);
    assert.equal(c.calls.at(-1).body.action.amount, Number(amount));
  }
  const c = client();
  assert.equal((await c.run(["wait", resource.resource_id, "selector", "input", "--state", "detached"])).ok, true);
  assert.equal(c.calls.at(-1).body.wait.condition.state, "detached");
});

test("defaulted actions retain controller and resource fences and do not retry", async () => {
  const args = ["scroll", "--direction", "down", ...authority];
  for (const observed of [
    { ...control, controller: { ...lease, epoch: "9" } },
    { ...control, resource: { ...resource, generation: "other" } },
  ]) {
    const c = client({ observed });
    assert.equal((await c.run(args)).ok, false);
    assert.equal(c.calls.some(({ body }) => body.kind === "action"), false);
  }
  const c = client({ failAt: "action" });
  const result = await c.run(args);
  assert.equal(result.error.code, "browser_response_lost");
  assert.equal(result.operation_id, "default:once");
  assert.equal(c.calls.filter(({ body }) => body.kind === "action").length, 1);
});

test("bare, duplicate and contradictory default-option arguments still fail before selection", async () => {
  for (const args of [
    ["wait"], ["wait", "--resource", resource.resource_id],
    ["wait", "--text", "one", "--text", "two"], ["wait", "--url", "https://example.com", "--fn"],
    ["scroll", "--amount", "20"], ["scroll", "--direction", "down", "--amount", ""],
    ["scroll", resource.resource_id, "--direction", "down", "--resource", "another"],
  ]) {
    const c = client();
    const result = await c.run(args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(c.calls.some(({ body }) => body.kind === "action"), false);
    // Explicit numeric validation historically occurs after observation.
    if (!args.includes("")) assert.deepEqual(c.selected, [], JSON.stringify(args));
  }
});
