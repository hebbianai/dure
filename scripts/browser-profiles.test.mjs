import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

test("profile catalog commands preserve Orca options and durable operation identity", async () => {
  for (const [args, body] of [
    [["list"], { kind: "profile_list" }],
    [["delete", "--profile", "browser-profile:한글"], { kind: "profile_delete", profile_id: "browser-profile:한글", operation_id: "profile-once" }],
    [["create", "--label", "한글 작업"], { kind: "profile_create", label: "한글 작업", scope: "isolated", user_agent_mode: "clean", operation_id: "profile-once" }],
    [["create", "--label", "Imported", "--scope", "imported", "--no-ua-spoof"], { kind: "profile_create", label: "Imported", scope: "imported", user_agent_mode: "native", operation_id: "profile-once" }],
  ]) {
    const requests = [];
    const result = await collectBrowserCommand({
      args: ["tab", "profile", ...args, "--idempotency-key", "profile-once"],
      resolveBackend: async () => ({ profile: { id: "profile-test" } }),
      requestBackend: async (_profile, request) => {
        requests.push(request);
        return { result: { result: { preserved: true } } };
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(requests.map((request) => request.body), [body]);
    assert.deepEqual(requests[0].requiredCapabilities, ["browser.resource.v1"]);
    assert.deepEqual(result.result, { preserved: true });
  }
});

test("invalid profile catalog arguments and misplaced options fail before backend contact", async () => {
  for (const args of [
    ["tab", "profile"], ["tab", "profile", "create"],
    ["tab", "profile", "create", "--label", ""],
    ["tab", "profile", "create", "--label", "one", "--scope", "default"],
    ["tab", "profile", "create", "--label", "one", "--scope", "unknown"],
    ["tab", "profile", "create", "--label", "one", "extra"],
    ["tab", "profile", "list", "--label", "one"],
    ["tab", "profile", "list", "--scope", "isolated"],
    ["tab", "profile", "list", "--no-ua-spoof"],
    ["tab", "profile", "delete"],
    ["tab", "profile", "delete", "--profile", ""],
    ["tab", "profile", "delete", "--profile", " "],
    ["tab", "profile", "delete", "--profile", "one", "extra"],
    ["tab", "profile", "delete", "--profile", "one", "--page", "page"],
    ["tab", "profile", "delete", "--profile", "one", "--label", "label"],
    ["tab", "profile", "delete", "--profile", "one", "--profile", "two"],
    ["tab", "profile", "create", "--label", "one", "--no-ua-spoof", "--no-ua-spoof"],
    ["list", "--label", "one"],
    ["create", "--scope", "imported"],
    ["show", "r", "--no-ua-spoof"],
  ]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args, resolveBackend: async () => { contacts++; throw new Error("unexpected contact"); } });
    assert.equal(contacts, 0, JSON.stringify(args));
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.error.code, "browser_command_invalid");
  }
});


test("browser creation preserves explicit profile selection and default request identity", async () => {
  for (const profile of [undefined, "default", "browser-profile:한글"]) {
    const requests = [];
    const result = await collectBrowserCommand({
      args: ["create", "--idempotency-key", "create-once", ...(profile === undefined ? [] : ["--profile", profile])],
      resolveBackend: async () => ({ profile: { id: "profile-test" } }),
      requestBackend: async (_profile, request) => {
        requests.push(request.body);
        return { result: { result: { preserved: true } } };
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(requests, [{ kind: "create", operation_id: "create-once", ...(profile === undefined ? {} : { profile_id: profile }) }]);
    assert.deepEqual(result.result, { preserved: true });
  }
});

test("empty, duplicate and misplaced profile selection fails before backend contact", async () => {
  for (const args of [
    ["create", "--profile"],
    ["create", "--profile", ""],
    ["create", "--profile", " "],
    ["create", "--profile", "one", "--profile", "two"],
    ["list", "--profile", "one"],
    ["show", "r", "--profile", "one"],
    ["tab", "profile", "create", "--label", "one", "--profile", "one"],
  ]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args, resolveBackend: async () => { contacts++; throw new Error("unexpected contact"); } });
    assert.equal(contacts, 0, JSON.stringify(args));
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.error.code, "browser_command_invalid");
  }
});

test("profile switching binds the selected page to the observed controller and command sequence", async () => {
  const resource = { resource_id: "r", generation: "g", workspace_id: "w" };
  const page = { resource, page_id: "p", document_revision: "7" };
  const lease = { resource, controller_id: "agent", epoch: "4" };
  const control = { resource, controller: lease, next_command_sequence: "12" };
  for (const [args, profile, requestKind] of [
    [["set", "r", "browser-profile:한글"], "browser-profile:한글"],
    [["set", "r", "--profile", "browser-profile:한글"], "browser-profile:한글"],
    [["use-default", "r"], "default"],
    [["clone", "r", "--profile", "browser-profile:한글"], "browser-profile:한글", "profile_clone"],
  ]) {
    const requests = [];
    const result = await collectBrowserCommand({
    args: ["tab", "profile", ...args, "--page", "p", "--controller", "agent", "--epoch", "4", "--idempotency-key", "switch-once"],
    resolveBackend: async () => ({ profile: { id: "profile-test" } }),
    requestBackend: async (_profile, request) => {
      requests.push(request.body);
      return { result: { result: request.body.kind === "observe" ? { control, pages: [{ page }] } : { response: { success: true } } } };
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(requests, [
    { kind: "observe", resource_id: "r" },
    { kind: requestKind ?? "profile_set", caller: "agent", authority: { lease, page, operation_id: "switch-once", command_sequence: "12" }, profile_id: profile },
  ]);
  }
});

test("incomplete or misplaced profile switch arguments cannot contact a backend", async () => {
  for (const args of [
    ["set"], ["set", "r"], ["set", "", "default"], ["set", "r", " "],
    ["set", "r", "default", "extra"], ["set", "r", "default", "--scope", "isolated"],
    ["set", "r", "default", "--label", "name"], ["set", "r", "default", "--no-ua-spoof"],
    ["set", "r", "default", "--workspace", "w"], ["set", "r", "default", "--profile", "other"],
    ["set", "r", "--profile", ""], ["set", "r", "--profile", " "], ["set", "r", "--profile", "one", "--profile", "two"],
    ["use-default"], ["use-default", "r", "extra"], ["use-default", "r", "--profile", "one"],
    ["show"], ["show", "r", "extra"], ["show", "r", "--controller", "agent"], ["show", "r", "--profile", "one"],
    ["clone"], ["clone", "r"], ["clone", "r", "--profile", " "], ["clone", "r", "--profile", "one", "extra"],
    ["clone", "r", "--profile", "one", "--scope", "isolated"], ["clone", "r", "--profile", "one", "--profile", "two"],
  ]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args: ["tab", "profile", ...args], resolveBackend: async () => { contacts++; throw new Error("unexpected contact"); } });
    assert.equal(contacts, 0, JSON.stringify(args));
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.error.code, "browser_command_invalid");
  }
});

test("profile show projects the requested page without requesting action authority", async () => {
  const resource = { resource_id: "r", generation: "g", workspace_id: "w" };
  const pages = ["one", "two"].map((id) => ({ page: { resource, page_id: id, document_revision: "2" }, profile_id: id }));
  const requests = [];
  const result = await collectBrowserCommand({
    args: ["tab", "profile", "show", "r", "--page", "two"],
    resolveBackend: async () => ({ profile: { id: "profile-test" } }),
    requestBackend: async (_profile, request) => {
      requests.push(request.body);
      return { result: { result: { control: { resource, controller: null }, pages } } };
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result, pages[1]);
  assert.deepEqual(requests, [{ kind: "observe", resource_id: "r" }]);
});
