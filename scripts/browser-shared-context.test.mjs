import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";

function fixture(kind = "local") {
  const requests = [];
  const selections = [];
  return {
    requests, selections,
    run: (args, cwd = "/tasks/한글 project/nested") => collectBrowserCommand({
      args: [...args, "--idempotency-key", "context-once"], cwd,
      resolveBackend: async (selection) => {
        selections.push(selection);
        return { profile: { id: "context-backend", transport: { kind } } };
      },
      requestBackend: async (_profile, request) => {
        requests.push(request);
        return { result: { result: { workspace_id: "workspace:resolved", resources: [] } } };
      },
    }),
  };
}

test.each(["create", "list"])("%s uses the same shared collection from any directory and backend", async (command) => {
  for (const kind of ["local", "ssh"]) {
    for (const cwd of ["/tasks/one", "/tasks/two/nested", "/outside/a/project"]) {
      const client = fixture(kind);
      const report = await client.run([command], cwd);
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.deepEqual(client.requests.map((request) => request.body), [{
        kind: command, ...(command === "create" ? { operation_id: "context-once" } : {}),
      }]);
    }
  }
});

test("removed worktree selectors and discovery fail before backend contact", async () => {
  for (const args of [
    ["workspaces"], ["list", "--workspace", "workspace:one"],
    ["create", "--worktree", "current"], ["list", "--worktree", "active"],
    ["list", "--worktree", "id:workspace:one"], ["list", "--worktree", "path:/repo"],
    ["tab", "list", "--worktree", "all"], ["list", "--after", "workspace:one"],
  ]) {
    const client = fixture();
    const report = await client.run(args);
    assert.equal(report.error?.code, "browser_command_invalid", JSON.stringify(report));
    assert.deepEqual(client.requests, []);
    assert.deepEqual(client.selections, []);
  }
});

test("a backend failure cannot trigger a second selection or creation", async () => {
  let calls = 0;
  const report = await collectBrowserCommand({
    args: ["create", "--idempotency-key", "context-once"], cwd: "/tasks/current",
    resolveBackend: async () => ({ profile: { id: "local", transport: { kind: "local" } } }),
    requestBackend: async (_profile, request) => {
      calls++;
      assert.deepEqual(request.body, { kind: "create", operation_id: "context-once" });
      throw new Error("browser_workspace_ambiguous");
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "browser_workspace_ambiguous");
  assert.equal(calls, 1);
});

test("an older backend rejecting shared selection cannot trigger an ID or cwd fallback", async () => {
  const requests = [];
  const report = await collectBrowserCommand({
    args: ["create", "--idempotency-key", "old-backend"],
    resolveBackend: async () => ({ profile: { id: "remote", transport: { kind: "ssh" } } }),
    requestBackend: async (_profile, request) => {
      requests.push(request.body);
      throw new BackendTransportError("backend_transport_remote_error", { details: { code: "browser_request_invalid" } });
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "backend_transport_remote_error");
  assert.equal(report.error.remoteCode, "browser_request_invalid");
  assert.equal(report.operation_id, "old-backend");
  assert.deepEqual(requests, [{ kind: "create", operation_id: "old-backend" }]);
});
