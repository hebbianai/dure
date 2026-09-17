import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hmuxSession,
  installHmuxStub,
  installRemoteBackendFixture,
  runSessionCli,
} from "./lib/dure-session-test-fixture.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "dure-ls-"));
  temporaryRoots.push(root);
  return root;
}

describe("dure ls canonical session projection", () => {
  it("lists exact local Sessions without app state", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, [hmuxSession()]);

    const result = runSessionCli(root, hmux, ["ls", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(join(root, "agents.json"))).toBe(false);
    expect(existsSync(join(root, "server.json"))).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      apiVersion: "dure.sessions/v1",
      kind: "dure.sessions.list",
      complete: true,
      source: { kind: "local_hmux", appDaemonRequired: false },
      sessions: [
        {
          sessionId: "session-1",
          workspaceId: "workspace-1",
          liveness: { state: "alive", exactGeneration: true },
        },
      ],
    });
  });

  it("uses sessions.list through the selected backend profile", () => {
    const root = temporaryRoot();
    const hmux = installHmuxStub(root, { error: "must not execute" }, { status: 77 });
    const remote = installRemoteBackendFixture(root, [hmuxSession()]);

    const result = runSessionCli(
      root,
      hmux,
      ["ls", "--backend", "remote-build", "--json"],
      {
        PATH: `${remote.bin}:${process.env.PATH}`,
        DURE_BACKEND_KNOWN_HOSTS_FILE: remote.knownHostsFile,
        DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
        DURE_SESSION_REQUEST_LOG: remote.requestLog,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(join(root, "agents.json"))).toBe(false);
    expect(existsSync(join(root, "server.json"))).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "dure.sessions.list",
      source: {
        kind: "backend_profile",
        appDaemonRequired: false,
        profileId: "remote-build",
      },
      sessions: [{ sessionId: "session-1", workspaceId: "workspace-1" }],
    });
    const requests = readFileSync(remote.requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      operation: "sessions.list",
      expected: { requiredCapabilities: ["sessions.list"] },
    });
  });
});
