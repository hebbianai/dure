import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "r", generation: "g", workspace_id: "w" };
const page = { resource, page_id: "p", document_revision: "7" };
const lease = { resource, controller_id: "agent", epoch: "4" };
const control = { resource, controller: lease, current_page: page, next_command_sequence: "12" };
const authority = { lease, page, operation_id: "create-once", command_sequence: "12" };
const flags = ["--controller", "agent", "--epoch", "4", "--idempotency-key", "create-once"];

async function run(args, view = { control, pages: [{ page }] }, mutate = () => ({ response: { success: true } })) {
  const requests = [];
  const result = await collectBrowserCommand({
    args, sourceEnvironment: {},
    resolveBackend: async () => ({ profile: { id: "profile-test", transport: { kind: "local" } } }),
    requestBackend: async (_profile, request) => {
      requests.push(request.body);
      const body = request.body;
      const result = body.kind === "list" ? { workspace_id: "w", resources: [{ resource }] }
        : body.kind === "observe" ? view : mutate(body);
      return { result: { result } };
    },
  });
  return { result, requests };
}

test("tab create binds an explicit profile and URL to one existing action authority", async () => {
  for (const [args, url] of [
    [["tab", "create", "r", "https://example.com/target"], "https://example.com/target"],
    [["tab", "create", "--resource", "r", "--url", "https://example.com/한글"], "https://example.com/한글"],
    [["tab", "create", "r"], "about:blank"],
    [["tab-new", "r", "https://example.com/target"], "https://example.com/target"],
  ]) {
    const { result, requests } = await run([...args, "--profile", "profile:한글", ...flags]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(requests, [
      { kind: "observe", resource_id: "r" },
      { kind: "profile_new_page", caller: "agent", authority, profile_id: "profile:한글", url },
    ]);
  }
});

test("profile tab creation uses the same selected workspace resource and current page", async () => {
  const { result, requests } = await run(["tab", "create", "--current", "--profile", "default", ...flags]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(requests, [
    { kind: "list" }, { kind: "observe", resource_id: "r" },
    { kind: "profile_new_page", caller: "agent", authority, profile_id: "default", url: "about:blank" },
  ]);
});

test("omitting a profile keeps ordinary new-page dispatch unchanged", async () => {
  const { result, requests } = await run(["tab", "create", "r", ...flags]);
  assert.equal(result.ok, true);
  assert.deepEqual(requests.at(-1), { kind: "action", caller: "agent", authority, action: { kind: "new_page", url: "about:blank" } });
});

test("stale leases, missing pages and mismatched resources cannot create a profile tab", async () => {
  for (const [view, args] of [
    [{ control: { ...control, controller: { ...lease, epoch: "5" } }, pages: [{ page }] }, []],
    [{ control: { ...control, controller: { ...lease, controller_id: "person" } }, pages: [{ page }] }, []],
    [{ control, pages: [] }, []],
    [{ control: { ...control, resource: { ...resource, generation: "other" } }, pages: [{ page }] }, []],
    [{ control, pages: [{ page }] }, ["--page", "missing"]],
  ]) {
    const { result, requests } = await run(["tab", "create", "r", "--profile", "profile:target", ...flags, ...args], view);
    assert.equal(result.ok, false, JSON.stringify({ view, result }));
    assert.deepEqual(requests, [{ kind: "observe", resource_id: "r" }]);
  }
});

test("profile selection errors propagate without a second mutation or fallback", async () => {
  const { result, requests } = await run(["tab", "create", "r", "--profile", "profile:missing", ...flags], undefined, () => { throw new Error("browser_profile_missing"); });
  assert.equal(result.error.code, "browser_profile_missing");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].kind, "profile_new_page");
});

test("duplicate, empty and misplaced creation options refuse before backend contact", async () => {
  for (const args of [
    ["tab", "create", "r", "--profile", ""],
    ["tab", "create", "r", "--profile", " "],
    ["tab", "create", "r", "--profile", "one", "--profile", "two"],
    ["tab", "create", "r", "about:blank", "--url", "https://example.com", "--profile", "one"],
    ["tab", "create", "r", "--all", "--profile", "one"],
    ["tab", "switch", "r", "--page", "p", "--profile", "one"],
  ]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args, sourceEnvironment: {}, resolveBackend: async () => { contacts++; } });
    assert.equal(result.ok, false);
    assert.equal(contacts, 0, JSON.stringify(args));
  }
});
