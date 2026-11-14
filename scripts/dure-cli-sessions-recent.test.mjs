import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const temporaryRoots = [];
const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
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

function isolatedEnvironment(home) {
  const environment = { ...process.env, HOME: home };
  for (const name of [
    "DURE_APP_CHANNEL",
    "DURE_HOME",
    "DURE_HMUX_BIN",
    "HEBBIAN_APP_CHANNEL",
    "HEBBIAN_HMUX_BIN",
  ]) {
    delete environment[name];
  }
  return environment;
}

/** A disposable HOME whose app descriptor points at a fixture app server. */
async function fixtureApp(respond) {
  const requests = [];
  const server = createServer((incoming, response) => {
    requests.push({ method: incoming.method, url: incoming.url });
    const { status, body } = respond();
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(join(tmpdir(), "dure-cli-sessions-recent-"));
  temporaryRoots.push(home);
  mkdirSync(join(home, ".dure"), { recursive: true });
  writeFileSync(
    join(home, ".dure", "server.json"),
    JSON.stringify({ port: server.address().port, token: "recent-token" }),
  );
  return { environment: isolatedEnvironment(home), requests };
}

// What the app answers when a window claimed the request but the provider
// history scan did not finish inside the claimed budget.
const CLAIMED_TIMEOUT = {
  status: 504,
  body: {
    ok: false,
    error: {
      code: "frontend_timeout",
      message: "Dure claimed but did not complete the pane request",
      deliveryState: "claimed",
      requestId: "sessions.recent-1",
    },
  },
};

describe("dure sessions recent", () => {
  it("prints the provider sessions as JSON", async () => {
    const session = { provider: "claude", id: "c-1", cwd: "/repo", title: "Task" };
    const fixture = await fixtureApp(() => ({
      status: 200,
      body: { ok: true, schemaVersion: 1, sessions: [session] },
    }));

    const result = await runCli(["sessions", "recent", "--json"], fixture.environment);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual([session]);
    expect(fixture.requests).toEqual([{ method: "POST", url: "/sessions/recent" }]);
  });

  it("reports an unfinished history read as one JSON error, not pane prose", async () => {
    const fixture = await fixtureApp(() => CLAIMED_TIMEOUT);

    const result = await runCli(["sessions", "recent", "--json"], fixture.environment);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const report = JSON.parse(result.stderr);
    expect(report).toEqual({
      schemaVersion: 1,
      kind: "dure.sessions.recent.error",
      error: {
        code: "frontend_timeout",
        deliveryState: "claimed",
        message: expect.stringContaining("did not finish reading provider history"),
        retryable: true,
        nextAction: expect.stringContaining("dure ls --alive --json"),
      },
    });
    expect(report.error.message).not.toContain("pane");
  });

  it("reports an unclaimed request as a typed JSON error", async () => {
    const fixture = await fixtureApp(() => ({
      status: 504,
      body: {
        ok: false,
        error: {
          code: "frontend_timeout",
          message: "Dure did not claim the pane request",
          deliveryState: "unclaimed",
        },
      },
    }));

    const result = await runCli(["sessions", "recent", "--json"], fixture.environment);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toEqual({
      code: "frontend_timeout",
      deliveryState: "unclaimed",
      message: expect.stringContaining("No Dure window picked up"),
      retryable: true,
      nextAction: expect.stringContaining("dure diagnostics --json"),
    });
  });

  it("reports a missing app as a typed JSON error", async () => {
    const home = mkdtempSync(join(tmpdir(), "dure-cli-sessions-recent-absent-"));
    temporaryRoots.push(home);

    const result = await runCli(["sessions", "recent", "--json"], isolatedEnvironment(home));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      kind: "dure.sessions.recent.error",
      error: { code: "client_unavailable" },
    });
  });

  it("explains an unfinished history read in human output", async () => {
    const fixture = await fixtureApp(() => CLAIMED_TIMEOUT);

    const result = await runCli(["sessions", "recent"], fixture.environment);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("did not finish reading provider history");
    expect(result.stderr).toContain("→ ");
    expect(result.stderr).toContain("dure ls --alive --json");
    expect(() => JSON.parse(result.stderr)).toThrow();
  });
});
