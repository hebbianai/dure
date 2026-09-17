import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const localAttachCapability = "managed_interactive_attach_v1";
const remoteAttachCapability = "ssh_managed_interactive_attach_v1";
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "dure-attach-"));
  roots.push(root);
  return root;
}

function session() {
  return {
    schema_version: 1,
    session_id: "session-1",
    session_name: "agent-1",
    workspace_id: "workspace-1",
    session_class: "managed",
    lifecycle: "ready",
    provider_id: "codex",
    runtime_host: null,
    worktree_alias: null,
    branch: "agent/session-1",
    launch_program: "codex",
    runner_principal: "runner",
    runner_instance: "runner-1",
    channel_epoch: "7",
    host_instance_id: "host-1",
    terminal_epoch: "terminal-1",
    output_seq: "12",
    host_build_version: "0.1.0",
    supported_protocol: {
      minimum: { major: 1, minor: 0 },
      maximum: { major: 1, minor: 0 },
    },
    capabilities: [],
    retirement_policy: null,
    host_process: { process_id: 101, start_marker: "host-start-1" },
    provider_process: { process_id: 202, start_marker: "provider-start-1" },
    endpoint: { kind: "unix_socket", address: "/private/runtime.sock" },
    created_unix_ms: "1000",
    lifecycle_changed_unix_ms: "2000",
    exit: null,
    manifestLifecycle: "ready",
    effectiveLifecycle: "ready",
    health: "healthy",
    recoverability: "live_attach",
    workingDirectory: null,
    providerConversationIdentity: null,
    recoveredPresentation: null,
  };
}

function installHmux(
  root,
  {
    capabilities = [localAttachCapability, remoteAttachCapability],
    payload = session(),
  } = {},
) {
  const log = join(root, "hmux.log");
  const executable = join(root, "hmux-fixture.mjs");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.includes("remote-managed-attach")) {
  const material = {};
  for (const flag of ["--known-hosts-file", "--identity-file"]) {
    const index = args.indexOf(flag);
    if (index < 0) continue;
    const file = args[index + 1];
    material[flag] = {
      path: file,
      matched: readFileSync(file, "utf8") === (flag === "--identity-file"
        ? "fixture private key" : "remote.example.test fixture"),
    };
  }
  writeFileSync(${JSON.stringify(join(root, "attach-material.json"))}, JSON.stringify(material));
}
if (args.includes("capabilities")) {
  process.stdout.write(JSON.stringify({
    schemaVersion: 2,
    capabilities: ${JSON.stringify(capabilities)},
  }) + "\\n");
}
if (args.includes("session") && args.includes("show")) {
  process.stdout.write(${JSON.stringify(`${JSON.stringify(payload)}\n`)});
}
`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
  return { executable, log };
}

function run(root, hmux, args, environment = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      DURE_APP_CHANNEL: "stable",
      DURE_HOME: root,
      DURE_HMUX_BIN: hmux,
      ...environment,
    },
  });
}

function installRemoteBackend(root, { authKind = "identity_file" } = {}) {
  const identityFile = join(root, "remote-identity");
  const knownHostsFile = join(root, "remote-known-hosts");
  writeFileSync(identityFile, "fixture private key", { mode: 0o600 });
  writeFileSync(knownHostsFile, "remote.example.test fixture", { mode: 0o600 });
  writeFileSync(
    join(root, "backend-profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_profiles",
      profiles: [
        {
          id: "remote",
          default: true,
          transport: {
            kind: "ssh",
            host: "remote.example.test",
            port: 2222,
            user: "dure",
            endpoint: { kind: "tcp", host: "127.0.0.1", port: 6767 },
            batchMode: true,
            strictHostKeyChecking: "yes",
            connectTimeoutMs: 1_000,
          },
          auth:
            authKind === "identity_file"
              ? {
                  kind: "identity_file",
                  reference: "credential-profile:remote",
                }
              : { kind: "ssh_agent" },
          trust: {
            kind: "known_hosts",
            reference: "known-hosts-profile:remote",
          },
          expected: {
            backendId: "remote-backend",
            generation: "remote-generation-1",
            protocol: {
              minimum: { major: 1, minor: 0 },
              maximum: { major: 1, minor: 0 },
            },
            capabilities: ["sessions.show"],
          },
          deadlineMs: 2_500,
        },
      ],
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, "backend-ssh-references.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_ssh_references",
      references: [
        ...(authKind === "identity_file"
          ? [
              {
                reference: "credential-profile:remote",
                kind: "identity_file",
                path: identityFile,
              },
            ]
          : []),
        {
          reference: "known-hosts-profile:remote",
          kind: "known_hosts_file",
          path: knownHostsFile,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const bin = join(root, "bin");
  mkdirSync(bin);
  const ssh = join(bin, "ssh");
  writeFileSync(
    ssh,
    `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const request = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  apiVersion: "dure.backend-transport/v1",
  kind: "dure.backend.response",
  requestId: request.requestId,
  backend: {
    id: "remote-backend",
    generation: "remote-generation-1",
    protocol: { major: 1, minor: 0 },
    capabilities: ["sessions.show"],
    observedAtMs: Date.now(),
  },
  result: { schemaVersion: 1, session: ${JSON.stringify(session())} },
}));
`,
    { mode: 0o700 },
  );
  chmodSync(ssh, 0o700);
  return { bin, identityFile, knownHostsFile };
}

describe("dure attach", () => {
  it("attaches one exact local managed session without an app registry", () => {
    const root = fixtureRoot();
    const hmux = installHmux(root);

    const result = run(root, hmux.executable, [
      "attach",
      "session-1",
      "--workspace",
      "workspace-1",
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = readFileSync(hmux.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["capabilities", "--json"],
      ["--json", "session", "show", "session-1", "--workspace", "workspace-1"],
      ["managed-attach", "session-1", "--workspace", "workspace-1"],
    ]);
  });

  it("rejects a legacy standalone target before opening an interactive path", () => {
    const root = fixtureRoot();
    const payload = session();
    payload.session_class = "standalone";
    const hmux = installHmux(root, { payload });

    const result = run(root, hmux.executable, [
      "attach",
      "session-1",
      "--workspace",
      "workspace-1",
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("dure_attach_legacy_target_unsupported");
    expect(result.stderr).not.toContain("agents.json");
  });

  it("passes an SSH backend's exact fence and reference paths to the framed Hmux relay", () => {
    const root = fixtureRoot();
    const hmux = installHmux(root);
    const remote = installRemoteBackend(root);

    const result = run(
      root,
      hmux.executable,
      [
        "attach",
        "session-1",
        "--workspace",
        "workspace-1",
        "--backend",
        "remote",
      ],
      { PATH: `${remote.bin}:${process.env.PATH}` },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = readFileSync(hmux.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["capabilities", "--json"]);
    expect(calls[1]).toEqual([
      "remote-managed-attach",
      "session-1",
      "--workspace",
      "workspace-1",
      "--host",
      "remote.example.test",
      "--port",
      "2222",
      "--user",
      "dure",
      "--connect-timeout-ms",
      "1000",
      "--identity-file",
      expect.any(String),
      "--known-hosts-file",
      expect.any(String),
      "--expected-fence-json",
      JSON.stringify({
        workspace_id: "workspace-1",
        session_id: "session-1",
        runner_principal: "runner",
        runner_instance: "runner-1",
        channel_epoch: "7",
        host_instance_id: "host-1",
        terminal_epoch: "terminal-1",
      }),
    ]);
    const material = JSON.parse(readFileSync(join(root, "attach-material.json"), "utf8"));
    for (const [flag, original] of [
      ["--identity-file", remote.identityFile],
      ["--known-hosts-file", remote.knownHostsFile],
    ]) {
      expect(material[flag].matched).toBe(true);
      expect(material[flag].path).not.toBe(original);
      expect(existsSync(material[flag].path)).toBe(false);
      expect(existsSync(original)).toBe(true);
    }
    expect(JSON.stringify(calls)).not.toContain("fixture private key");
  });

  it("uses the same fenced SSH relay with an agent-backed profile", () => {
    const root = fixtureRoot();
    const hmux = installHmux(root);
    const remote = installRemoteBackend(root, { authKind: "ssh_agent" });

    const result = run(
      root,
      hmux.executable,
      [
        "attach",
        "session-1",
        "--workspace",
        "workspace-1",
        "--backend",
        "remote",
      ],
      { PATH: `${remote.bin}:${process.env.PATH}` },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = readFileSync(hmux.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls[1]).toContain("--ssh-agent");
    expect(calls[1]).not.toContain("--identity-file");
    const material = JSON.parse(readFileSync(join(root, "attach-material.json"), "utf8"));
    expect(material["--known-hosts-file"].matched).toBe(true);
    expect(material["--known-hosts-file"].path).not.toBe(remote.knownHostsFile);
    expect(existsSync(material["--known-hosts-file"].path)).toBe(false);
  });

  it("fails before session discovery when the selected Hmux lacks attach capability", () => {
    const root = fixtureRoot();
    const hmux = installHmux(root, { capabilities: [] });

    const result = run(root, hmux.executable, [
      "attach",
      "session-1",
      "--workspace",
      "workspace-1",
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("dure_attach_hmux_incompatible");
    expect(result.stderr).toContain(localAttachCapability);
    expect(readFileSync(hmux.log, "utf8").trim()).toBe(
      JSON.stringify(["capabilities", "--json"]),
    );
  });

  it("rejects a backend response for a different workspace before attachment", () => {
    const root = fixtureRoot();
    const payload = session();
    payload.workspace_id = "workspace-2";
    const hmux = installHmux(root, { payload });

    const result = run(root, hmux.executable, [
      "attach",
      "session-1",
      "--workspace",
      "workspace-1",
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("dure_attach_session_unavailable");
    expect(result.stderr).toContain("dure_session_query_identity_mismatch");
    const calls = readFileSync(hmux.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["capabilities", "--json"],
      ["--json", "session", "show", "session-1", "--workspace", "workspace-1"],
    ]);
  });

  it("rejects a stale exact generation before opening an interactive client", () => {
    const root = fixtureRoot();
    const payload = session();
    payload.effectiveLifecycle = "stale";
    payload.health = "stale_transport";
    payload.recoverability = "restore";
    const hmux = installHmux(root, { payload });

    const result = run(root, hmux.executable, [
      "attach",
      "session-1",
      "--workspace",
      "workspace-1",
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("dure_attach_session_not_live");
    expect(readFileSync(hmux.log, "utf8")).not.toContain("managed-attach");
  });
});
