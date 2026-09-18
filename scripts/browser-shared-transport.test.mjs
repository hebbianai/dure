import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";
import { parseBackendProfiles } from "../cli/lib/backend-profiles.mjs";
import { BACKEND_TRANSPORT_API_VERSION } from "../cli/lib/backend-transport.mjs";

test("shared inventory uses the real local transport and rejects changed backend authority", async () => {
  const base = realpathSync(tmpdir());
  const root = mkdtempSync(join(base, "bw-"));
  assert.equal(dirname(root), base);
  const endpoint = process.platform === "win32"
    ? { kind: "windows_named_pipe", name: `\\\\.\\pipe\\dure-browser-workspaces-${randomUUID()}` }
    : { kind: "unix_socket", path: join(root, "backend.sock") };
  const profile = parseBackendProfiles(JSON.stringify({
    schemaVersion: 1,
    kind: "dure.backend_profiles",
    profiles: [{
      id: "workspace-fixture",
      transport: { kind: "local", endpoint },
      auth: { kind: "peer" },
      trust: { kind: "local_peer" },
      expected: {
        backendId: "workspace-backend", generation: "generation:one",
        protocol: { minimum: { major: 1, minor: 0 }, maximum: { major: 1, minor: 0 } },
        capabilities: ["browser.resource.v1"],
      },
    }],
  })).profiles[0];
  const sockets = new Set();
  const errors = [];
  const requests = [];
  let mode = "valid";
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error) => errors.push(error));
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.endsWith("\n")) return;
      try {
        const request = JSON.parse(input);
        requests.push(request);
        socket.end(`${JSON.stringify({
          schemaVersion: 1, apiVersion: BACKEND_TRANSPORT_API_VERSION,
          kind: "dure.backend.response", requestId: request.requestId,
          backend: {
            id: profile.expected.backendId,
            generation: mode === "generation" ? "generation:other" : profile.expected.generation,
            protocol: { major: 1, minor: 0 },
            capabilities: mode === "capability" ? [] : profile.expected.capabilities,
            observedAtMs: Date.now(),
          },
          result: { schemaVersion: 1, result: { workspace_id: "workspace:dure-browser", resources: [] } },
        })}\n`);
      } catch (error) {
        errors.push(error);
        socket.destroy();
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint.path ?? endpoint.name, resolve);
    });
    if (endpoint.path) chmodSync(endpoint.path, 0o600);
    for (const [nextMode, errorCode] of [
      ["valid", undefined],
      ["generation", "backend_transport_generation_mismatch"],
      ["capability", "backend_transport_capability_missing"],
    ]) {
      mode = nextMode;
      const report = await collectBrowserCommand({
        args: ["list", "--backend", profile.id],
        resolveBackend: async () => ({ profile }),
      });
      assert.equal(report.ok, errorCode === undefined, JSON.stringify(report));
      assert.equal(report.error?.code, errorCode);
      if (errorCode === undefined) assert.deepEqual(report.result, { workspace_id: "workspace:dure-browser", resources: [] });
      else assert.equal(report.result, undefined);
    }
    assert.deepEqual(requests.map((request) => request.body), Array.from({ length: 3 }, () => ({ kind: "list" })));
    assert.deepEqual(errors, []);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.equal(dirname(root), base);
    rmSync(root, { recursive: true });
  }
});
