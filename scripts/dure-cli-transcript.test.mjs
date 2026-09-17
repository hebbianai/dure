import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { handleMcpRequest } from "../cli/lib/orchestration-mcp-server.mjs";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const temporaryRoots = [];
const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise((resolve) => server.close(resolve)),
    ),
  );
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runCli(args, environment) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function nativeFixture() {
  const requests = [];
  const server = createServer((request, response) => {
    let source = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      source += chunk;
    });
    request.on("end", () => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(source),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          transcript: {
            schemaVersion: 1,
            provider: "codex",
            conversationId: "conversation-exact",
            historyComplete: true,
            entries: [
              { role: "user", text: "x".repeat(1024 * 1024 + 1) },
              { role: "user", text: "first" },
              { role: "agent", text: "second" },
              { role: "user", text: "third" },
            ],
          },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");

  const root = mkdtempSync(join(tmpdir(), "dure-native-transcript-"));
  temporaryRoots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "agents.json"),
    JSON.stringify({
      agents: [
        {
          id: "agent-native",
          name: "native",
          provider: "codex",
          project: "project",
          sessionId: "session-1",
          sessionKind: "pty",
          runtimeBinding: {
            runtime: "hmux_managed_v1",
            source: "local",
            conversationIdentity: {
              providerId: "codex",
              conversationId: "conversation-exact",
            },
          },
        },
      ],
    }),
  );
  writeFileSync(
    join(root, "server.json"),
    JSON.stringify({
      port: address.port,
      token: "control-token",
      capabilities: ["provider_transcript.read_v1"],
    }),
  );
  const environment = { ...process.env, DURE_HOME: root };
  delete environment.DURE_APP_CHANNEL;
  delete environment.HEBBIAN_APP_CHANNEL;
  return {
    requests,
    environment,
    server,
    port: address.port,
  };
}

describe("dure transcript", () => {
  it("identifies a refused local API connection through the CLI and MCP", async () => {
    const fixture = await nativeFixture();
    await new Promise((resolve) => fixture.server.close(resolve));

    const cli = await runCli(
      ["transcript", "agent-native", "-n", "1", "--json"],
      fixture.environment,
    );
    const mcp = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "app_observe", arguments: {} },
      },
      fixture.environment,
    );

    expect(cli.code).not.toBe(0);
    expect(cli.stdout).toBe("");
    expect(mcp.isError).toBe(true);
    expect(mcp.structuredContent.error.code).toBe("client_request_failed");
    for (const message of [cli.stderr, mcp.structuredContent.error.message]) {
      expect(message).toContain("ECONNREFUSED");
      expect(message).toContain(`127.0.0.1:${fixture.port}`);
      expect(message).toContain("Dure app is running");
      expect(message).not.toContain("control-token");
    }
    expect(fixture.requests).toEqual([]);
  });

  it("exports the exact native provider conversation with shared selection", async () => {
    const fixture = await nativeFixture();

    const result = await runCli(
      ["transcript", "agent-native", "-n", "2", "--json"],
      fixture.environment,
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    const transcript = JSON.parse(result.stdout);
    expect(transcript.entries.map((entry) => entry.text)).toEqual([
      "second",
      "third",
    ]);
    expect(transcript.binding.source).toEqual({
      kind: "provider_transcript",
      conversationId: "conversation-exact",
    });
    expect(fixture.requests).toEqual([
      {
        url: "/transcript",
        authorization: "Bearer control-token",
        body: {
          provider: "codex",
          conversationId: "conversation-exact",
        },
      },
    ]);
  });
});
