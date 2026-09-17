import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-whoami-"));
  temporaryRoots.push(root);
  const appRoot = path.join(root, "app-home");
  fs.mkdirSync(appRoot, { recursive: true });
  const agentsPath = path.join(appRoot, "agents.json");
  fs.writeFileSync(
    agentsPath,
    JSON.stringify({
      agents: [
        {
          id: "agent-1",
          name: "codex-1",
          displayName: "Release QA",
          project: "Dure",
          provider: "codex",
          sessionId: "session-1",
          worktree: "/worktrees/codex-1",
          branch: "agent/codex-1",
          kind: "pty",
        },
      ],
    }),
  );
  const [agent] = JSON.parse(fs.readFileSync(agentsPath, "utf8")).agents;
  return {
    agent,
    agentsPath,
    root,
    environment: sessionScrubbedEnvironment({
      HOME: root,
      DURE_HOME: appRoot,
      DURE_APP_CHANNEL: "stable",
      HMUX_SESSION_ID: "session-1",
    }),
  };
}

/** Remove inherited session markers so the fixture owns its identity. */
function sessionScrubbedEnvironment(overrides) {
  const environment = { ...process.env, ...overrides };
  for (const marker of ["HEBBIAN_SESSION", "HEBBIAN_AGENT"]) {
    delete environment[marker];
  }
  return environment;
}

function run(args, environment) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: environment,
  });
}

function strictFailure(result) {
  expect(result.status).toBe(1);
  return JSON.parse(result.stderr);
}

describe("dure whoami", () => {
  it("reads the latest display name by stable session identity", () => {
    const { environment } = fixture();
    const result = run(["whoami"], environment);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("Release QA\n");
  });

  it("keeps canonical resource coordinates in JSON output", () => {
    const { environment } = fixture();
    const result = run(["whoami", "--json"], environment);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      id: "agent-1",
      displayName: "Release QA",
      name: "codex-1",
      project: "Dure",
      provider: "codex",
      sessionId: "session-1",
      worktree: "/worktrees/codex-1",
      branch: "agent/codex-1",
    });
  });

  it("returns one exact local identity in strict session mode", () => {
    const { environment } = fixture();
    const result = run(
      ["whoami", "--json", "--strict-session", "session-1"],
      environment,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: "agent-1",
      kind: "pty",
      name: "codex-1",
      sessionId: "session-1",
    });
  });

  it("does not fall back to an agent hint when the strict session is missing", () => {
    const { environment } = fixture();
    environment.HEBBIAN_AGENT = "codex-1";
    const result = run(
      ["whoami", "--json", "--strict-session", "session-missing"],
      environment,
    );

    expect(strictFailure(result)).toMatchObject({
      schemaVersion: 1,
      code: "dure_whoami_strict_session_unregistered",
      message: expect.stringContaining("no registry agent owns this session"),
    });
  });

  it("rejects duplicate strict sessions", () => {
    const { agent, agentsPath, environment } = fixture();
    fs.writeFileSync(
      agentsPath,
      JSON.stringify({
        agents: [agent, { ...agent, id: "agent-2", name: "codex-2" }],
      }),
    );

    const result = run(
      ["whoami", "--json", "--strict-session", "session-1"],
      environment,
    );

    expect(strictFailure(result)).toMatchObject({
      schemaVersion: 1,
      code: "dure_whoami_strict_session_ambiguous",
    });
  });

  it("rejects duplicate stable IDs across sessions", () => {
    const { agent, agentsPath, environment } = fixture();
    fs.writeFileSync(
      agentsPath,
      JSON.stringify({
        agents: [
          agent,
          { ...agent, name: "codex-2", sessionId: "session-2" },
        ],
      }),
    );

    const result = run(
      ["whoami", "--json", "--strict-session", "session-1"],
      environment,
    );

    expect(strictFailure(result)).toMatchObject({
      schemaVersion: 1,
      code: "dure_whoami_strict_agent_id_invalid",
      message: expect.stringContaining("unique canonical stable agent ID"),
    });
  });

  it.each(["agent@1", "agent-a.b", "stable-1", "agent-"])(
    "rejects a noncanonical stable ID %s",
    (id) => {
      const { agent, agentsPath, environment } = fixture();
      fs.writeFileSync(
        agentsPath,
        JSON.stringify({ agents: [{ ...agent, id }] }),
      );

      const result = run(
        ["whoami", "--json", "--strict-session", "session-1"],
        environment,
      );

      expect(strictFailure(result)).toMatchObject({
        schemaVersion: 1,
        code: "dure_whoami_strict_agent_id_invalid",
      });
    },
  );

  it("rejects remote SSH identities in strict session mode", () => {
    const { agent, agentsPath, environment } = fixture();
    fs.writeFileSync(
      agentsPath,
      JSON.stringify({ agents: [{ ...agent, kind: "ssh" }] }),
    );

    const result = run(
      ["whoami", "--json", "--strict-session", "session-1"],
      environment,
    );

    expect(strictFailure(result)).toMatchObject({
      schemaVersion: 1,
      code: "dure_whoami_strict_transport_unsupported",
      message: expect.stringContaining("local pty agent identity"),
    });
  });

  it("provides English help that explains rename semantics", () => {
    const result = run(["whoami", "--help"], { ...process.env });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("latest IDE identity");
    expect(result.stdout).toContain("does not move the worktree");
    expect(result.stdout).toContain("HMUX_SESSION_NAME remains the launch-time");
    expect(result.stdout).toContain("--strict-session ID");
  });
});
