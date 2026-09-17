import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const page = { resource: { resource_id: "r", generation: "g", workspace_id: "w" }, page_id: "p", document_revision: "7" };
const lease = { resource: page.resource, controller_id: "agent", epoch: "9" };
const shared = ["--page", "p", "--controller", "agent", "--epoch", "9"];
const resolveBackend = async () => ({ profile: { id: "intercept-test" } });

test("invalid interception combinations fail before resolving a backend", async () => {
  for (const args of [
    ["intercept", "r", "unknown", ...shared], ["intercept", "r", "enable", "--page", "p"],
    ["intercept", "r", "list", ...shared, "--abort"], ["intercept", "r", "disable", ...shared, "--patterns", "*"],
    ["intercept", "r", "enable", ...shared, "--abort", "--body", ""],
    ["intercept", "r", "enable", ...shared, "--status", "200"],
    ["intercept", "r", "enable", ...shared, "--body", "", "--status", "NaN"],
    ["intercept", "r", "enable", ...shared, "--body", "", "--response-headers", "[]"],
    ["intercept", "r", "enable", ...shared, "--body", "", "--response-headers", '{"content-type":"a"}', "--content-type", "b"],
    ["show", "r", "--abort"], ["intercept", "r", "enable", ...shared, "--resource-type", "Fetch", "--resource-types", "XHR"],
  ]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args, resolveBackend: async () => { contacts++; throw new Error("unexpected backend"); } });
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(contacts, 0);
  }
});

test("listing configured rules is passive and preserves unavailable observation", async () => {
  const calls = [];
  const result = await collectBrowserCommand({ args: ["intercept", "r", "list", "--page", "p"], resolveBackend,
    requestBackend: async (_profile, { body, requiredCapabilities }) => {
      calls.push(body);
      assert.deepEqual(requiredCapabilities, ["browser.resource.v1", "browser.network.v1"]);
      return { result: { result: body.kind === "control_state" ? { resource: page.resource, controller: null } : { page, enabled: true, available: false, rules: [] } } };
    } });
  assert.equal(result.ok, true);
  assert.equal(result.result.available, false);
  assert.deepEqual(calls, [{ kind: "control_state", resource_id: "r" }, { kind: "interception_state", resource: page.resource, page_id: "p" }]);
});

test("rules carry every pattern, UTF-8 response and original operation authority", async () => {
  for (const fault of [null, "lease", "page"]) {
    const calls = [];
    const result = await collectBrowserCommand({ args: ["intercept", "r", "enable", ...shared, "--patterns", "*/one, */two", "--body", "한글", "--resource-type", "Fetch, XHR", "--idempotency-key", "route-once"], resolveBackend,
      requestBackend: async (_profile, { body }) => {
        calls.push(body);
        const value = body.kind === "control_state" ? { resource: page.resource, controller: fault === "lease" ? { ...lease, epoch: "10" } : lease, next_command_sequence: "11" }
          : body.kind === "interception_state" ? { page: fault === "page" ? { ...page, page_id: "other" } : page }
            : { response: { success: true } };
        return { result: { result: value } };
      } });
    assert.equal(result.ok, !fault);
    if (fault) assert.equal(calls.some((call) => call.kind === "action"), false);
    else assert.deepEqual(calls[2], { kind: "action", caller: "agent", authority: { lease, page, operation_id: "route-once", command_sequence: "11" },
      action: { kind: "interception", action: { kind: "enable", rule: { patterns: ["*/one", "*/two"], resource_types: ["Fetch", "XHR"], effect: { kind: "respond", body: "한글", status: 200, headers: {} } } } } });
  }
});

test.each([
  ["network route '*/api,one' --abort --resource-type Fetch,XHR", { kind: "enable", rule: { patterns: ["*/api,one"], resource_types: ["Fetch", "XHR"], effect: { kind: "abort" } } }],
  ['network route "*/api" --body \'{"message":"한글"}\'', { kind: "enable", rule: { patterns: ["*/api"], resource_types: [], effect: { kind: "respond", body: '{"message":"한글"}', status: 200, headers: {} } } }],
  ['network route "*/literal" --body "--backend peer"', { kind: "enable", rule: { patterns: ["*/literal"], resource_types: [], effect: { kind: "respond", body: "--backend peer", status: 200, headers: {} } } }],
  ["network route '*/api'", { kind: "enable", rule: { patterns: ["*/api"], resource_types: [], effect: { kind: "continue" } } }],
  ["network unroute '*/api,one'", { kind: "remove", pattern: "*/api,one" }],
  ["network unroute", { kind: "disable" }],
])("native %s preserves literal data, one admitted operation and page authority", async (command, action) => {
  for (const fault of [null, "lease", "page", "generation"]) {
    const calls = [];
    const result = await collectBrowserCommand({ args: ["exec", "r", "--command", command, ...shared, "--idempotency-key", "route-once"], resolveBackend,
      requestBackend: async (_profile, { body, requiredCapabilities }) => {
        calls.push(body);
        assert.deepEqual(requiredCapabilities, ["browser.resource.v1", "browser.network.v1"]);
        const observed = fault === "generation" ? { ...page, resource: { ...page.resource, generation: "replaced" } } : fault === "page" ? { ...page, page_id: "other" } : page;
        return { result: { result: body.kind === "control_state" ? { resource: page.resource, controller: fault === "lease" ? { ...lease, epoch: "10" } : lease, next_command_sequence: "11" }
          : body.kind === "interception_state" ? { page: observed }
            : { response: { success: true } } } };
      } });
    assert.equal(result.ok, !fault, JSON.stringify({ command, fault, result }));
    const mutations = calls.filter((call) => call.kind === "action");
    assert.deepEqual(mutations, fault ? [] : [{ kind: "action", caller: "agent", authority: { lease, page, operation_id: "route-once", command_sequence: "11" }, action: { kind: "interception", action } }]);
  }
});

test("native route syntax rejects extra authority, unknown flags and ambiguous actions before contact", async () => {
  for (const command of ["network route", "network route * extra", "network route * --body", "network route * --abort --body x", "network route * --resource-type", "network route * --backend peer", "network route * --page peer", "network route * --body x --body y", "network route * --resource-type fetch --resource-types xhr", "network unroute * extra", "network unroute --backend peer"]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args: ["exec", "r", "--command", command, ...shared], resolveBackend: async () => { contacts++; throw new Error("unexpected backend"); } });
    assert.equal(result.ok, false, command);
    assert.equal(contacts, 0, command);
  }
  for (const values of [["remove"], ["remove", ""], ["remove", "*", "extra"], ["remove", "*", "--abort"], ["enable", "*", "--patterns", "other"]]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args: ["intercept", "r", ...values, ...shared], resolveBackend: async () => { contacts++; throw new Error("unexpected backend"); } });
    assert.equal(result.ok, false, JSON.stringify(values));
    assert.equal(contacts, 0);
  }
});
