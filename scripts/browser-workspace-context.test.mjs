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

test.each(["create", "list"])("%s defaults to the local invocation directory through the backend", async (command) => {
  for (const selector of [[], ["--worktree", "active"], ["--worktree", "current"]]) {
    const client = fixture();
    const report = await client.run([command, ...selector]);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(client.requests.map((request) => request.body), [{
      kind: command, workspace_path: "/tasks/한글 project/nested",
      ...(command === "create" ? { operation_id: "context-once" } : {}),
    }]);
    assert.deepEqual(client.requests[0].requiredCapabilities, ["browser.resource.v1"]);
    assert.equal(report.result.workspace_id, "workspace:resolved");
  }
});

test.each(["create", "list"])("%s preserves explicit workspace IDs on local and remote backends", async (command) => {
  for (const kind of ["local", "ssh"]) {
    for (const args of [["--workspace", "workspace:chosen"], ["--worktree", "id:workspace:chosen"]]) {
      const client = fixture(kind);
      const report = await client.run([command, ...args, "--backend", "selected"]);
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.deepEqual(client.requests.map((request) => request.body), [{
        kind: command, workspace_id: "workspace:chosen",
        ...(command === "create" ? { operation_id: "context-once" } : {}),
      }]);
      assert.deepEqual(client.requests[0].requiredCapabilities, ["browser.resource.v1"]);
      assert.deepEqual(client.selections, [{ backend: "selected", backendSpecified: true }]);
    }
  }
});

test.each(["create", "list"])("%s sends an explicit server path without client normalization", async (command) => {
  const client = fixture("ssh");
  const report = await client.run([command, "--worktree", "path:/srv/a/../한글 project", ...(command === "create" ? ["--profile", "default"] : [])]);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(client.requests.map((request) => request.body), [{
    kind: command, workspace_path: "/srv/a/../한글 project",
    ...(command === "create" ? { operation_id: "context-once", profile_id: "default" } : {}),
  }]);
  assert.deepEqual(client.requests[0].requiredCapabilities, ["browser.resource.v1"]);
});

test("remote or unknown backend transport cannot inherit local cwd", async () => {
  for (const kind of ["ssh", "unknown"]) {
    for (const command of ["create", "list"]) {
      for (const selector of [[], ["--worktree", "current"], ["--worktree", "active"]]) {
        const client = fixture(kind);
        const report = await client.run([command, ...selector]);
        assert.equal(report.ok, false);
        assert.equal(report.error.code, "browser_workspace_required", JSON.stringify(report));
        assert.deepEqual(client.requests, []);
      }
    }
  }
});

test("conflicting or malformed workspace selectors fail before backend resolution", async () => {
  for (const args of [
    ["list", "--workspace", "workspace:one", "--worktree", "current"],
    ["create", "--worktree", "id:"], ["list", "--worktree", "path:"],
    ["list", "--worktree", "branch:main"], ["list", "--worktree", ""],
    ["list", "--workspace", ""], ["list", "--workspace", "bad id"],
    ["list", "--worktree", "path:/srv/\u0000bad"],
    ["list", "--worktree", `path:/${"a".repeat(4096)}`],
    ["list", "--worktree", "current", "--worktree", "active"],
    ["show", "resource:one", "--worktree", "current"],
    ["show", "resource:one", "--workspace", "workspace:one"],
    ["workspaces", "--worktree", "current"],
  ]) {
    const client = fixture();
    const report = await client.run(args);
    assert.equal(report.ok, false, JSON.stringify(args));
    assert.equal(report.error.code, "browser_command_invalid");
    assert.deepEqual(client.selections, []);
    assert.deepEqual(client.requests, []);
  }
});

test("an ambiguous backend workspace result cannot trigger a second selection or creation", async () => {
  let calls = 0;
  const report = await collectBrowserCommand({
    args: ["create", "--idempotency-key", "context-once"], cwd: "/tasks/current",
    resolveBackend: async () => ({ profile: { id: "local", transport: { kind: "local" } } }),
    requestBackend: async (_profile, request) => {
      calls++;
      assert.deepEqual(request.body, { kind: "create", workspace_path: "/tasks/current", operation_id: "context-once" });
      throw new Error("browser_workspace_ambiguous");
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "browser_workspace_ambiguous");
  assert.equal(calls, 1);
});

test("an older backend rejecting path selection cannot trigger an ID or cwd fallback", async () => {
  const requests = [];
  const report = await collectBrowserCommand({
    args: ["create", "--worktree", "path:/srv/task", "--idempotency-key", "old-backend"],
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
  assert.deepEqual(requests, [{ kind: "create", workspace_path: "/srv/task", operation_id: "old-backend" }]);
});
