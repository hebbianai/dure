import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import {
  collectProjectCommand,
  formatProjectCommand,
  projectCommandExitCode,
} from "../cli/lib/project-client.mjs";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const temporaryRoots = [];
const rootId = "root_0123456789abcdef0123456789abcdef";
const repositoryId = "repo_fedcba9876543210fedcba9876543210";

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "dure-projects-"));
  temporaryRoots.push(root);
  return root;
}

function profile(id = "remote-b") {
  return {
    id,
    transport: { kind: "ssh" },
    expected: {
      capabilities: ["projects.list", "projects.register", "projects.show"],
    },
    deadlineMs: 2_500,
  };
}

function projection(overrides = {}) {
  return {
    id: "dure",
    displayName: "Dure",
    rootId,
    repositoryId,
    ...overrides,
  };
}

function backendResult(result) {
  return {
    backend: {
      id: "remote-b-backend",
      generation: "remote-b-generation-1",
      protocol: { major: 1, minor: 0 },
      capabilities: ["projects.list", "projects.register", "projects.show"],
      observedAtMs: Date.now(),
    },
    result,
  };
}

describe("project client contract", () => {
  it("registers one backend-owned project without returning its root path", async () => {
    const requests = [];
    const report = await collectProjectCommand({
      action: "register",
      projectId: "dure",
      displayName: "Dure",
      projectPath: "/srv/dure",
      backend: { profile: profile() },
      requestBackend: async (_profile, request) => {
        requests.push(request);
        return backendResult({ schemaVersion: 1, project: projection() });
      },
    });

    expect(report).toMatchObject({
      kind: "dure.projects.register",
      project: projection(),
    });
    expect(requests).toEqual([
      {
        operation: "projects.register",
        requiredCapabilities: ["projects.register"],
        body: {
          schemaVersion: 1,
          projectId: "dure",
          displayName: "Dure",
          root: "/srv/dure",
        },
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("/srv/dure");
  });

  it("lists and shows strict backend-owned identities with bounded requests", async () => {
    const requests = [];
    const requestBackend = async (_profile, request, options) => {
      requests.push({ request, options });
      return backendResult(
        request.operation === "projects.list"
          ? {
              schemaVersion: 1,
              complete: true,
              projects: [projection()],
            }
          : { schemaVersion: 1, project: projection() },
      );
    };
    const backend = { profile: profile(), transportOptions: { marker: true } };

    const listed = await collectProjectCommand({
      action: "list",
      backend,
      deadlineMs: 1_250,
      requestBackend,
    });
    const shown = await collectProjectCommand({
      action: "show",
      projectId: "dure",
      backend,
      requestBackend,
    });

    expect(listed).toMatchObject({
      schemaVersion: 1,
      apiVersion: "dure.projects/v1",
      kind: "dure.projects.list",
      complete: true,
      source: {
        kind: "backend_profile",
        appDaemonRequired: false,
        profileId: "remote-b",
        transport: "ssh",
      },
      projects: [projection()],
    });
    expect(shown).toMatchObject({
      kind: "dure.projects.show",
      project: projection(),
    });
    expect(requests[0]).toMatchObject({
      request: {
        operation: "projects.list",
        requiredCapabilities: ["projects.list"],
        body: { schemaVersion: 1, maxItems: 128 },
      },
      options: { deadlineMs: 1_250, maxResponseBytes: 262_144, marker: true },
    });
    expect(requests[1].request).toMatchObject({
      operation: "projects.show",
      requiredCapabilities: ["projects.show"],
      body: { schemaVersion: 1, projectId: "dure" },
    });
    expect(projectCommandExitCode(listed)).toBe(0);
    expect(formatProjectCommand(shown)).toContain(
      `dure\tDure\t${rootId}\t${repositoryId}`,
    );
    expect(JSON.stringify(listed)).not.toMatch(/(?:cwd|path|pane|layout|focus)/i);
  });

  it.each([
    ["swapped root identity", projection({ rootId: repositoryId })],
    ["swapped repository identity", projection({ repositoryId: rootId })],
    ["absolute root leak", { ...projection(), root: "/private/repo" }],
    ["control character", projection({ displayName: "Dure\nsecret" })],
  ])("rejects a %s projection", async (_case, invalid) => {
    const report = await collectProjectCommand({
      action: "list",
      backend: { profile: profile() },
      requestBackend: async () =>
        backendResult({ schemaVersion: 1, complete: true, projects: [invalid] }),
    });
    expect(report).toMatchObject({
      kind: "dure.projects.error",
      complete: false,
      error: { code: "backend_projects_payload_invalid" },
    });
    expect(projectCommandExitCode(report)).toBe(2);
  });

  it("rejects unsorted, duplicate, oversized, and mismatched project sets", async () => {
    const cases = [
      {
        action: "list",
        result: {
          schemaVersion: 1,
          complete: true,
          projects: [projection({ id: "z" }), projection({ id: "a" })],
        },
        code: "backend_projects_payload_invalid",
      },
      {
        action: "list",
        result: {
          schemaVersion: 1,
          complete: true,
          projects: Array.from({ length: 129 }, (_, index) =>
            projection({ id: `p${String(index).padStart(3, "0")}` }),
          ),
        },
        code: "backend_projects_payload_invalid",
      },
      {
        action: "show",
        projectId: "other",
        result: { schemaVersion: 1, project: projection() },
        code: "backend_project_identity_mismatch",
      },
    ];
    for (const testCase of cases) {
      const report = await collectProjectCommand({
        action: testCase.action,
        projectId: testCase.projectId,
        backend: { profile: profile() },
        requestBackend: async () => backendResult(testCase.result),
      });
      expect(report.error.code).toBe(testCase.code);
    }
  });

  it.each([
    "backend_transport_reference_unavailable",
    "backend_transport_timeout",
    "backend_transport_generation_mismatch",
    "backend_transport_protocol_incompatible",
    "backend_transport_capability_missing",
  ])("preserves typed transport failure %s", async (code) => {
    const report = await collectProjectCommand({
      action: "list",
      backend: { profile: profile() },
      requestBackend: async () => {
        throw new BackendTransportError(code);
      },
    });
    expect(report).toMatchObject({
      kind: "dure.projects.error",
      source: { kind: "backend_profile", appDaemonRequired: false },
      error: { code, profileId: "remote-b" },
    });
  });

  it("preserves the typed backend rejection without raw detail", async () => {
    const report = await collectProjectCommand({
      action: "show",
      projectId: "missing",
      backend: { profile: profile() },
      requestBackend: async () => {
        throw new BackendTransportError("backend_transport_remote_error", {
          details: {
            code: "backend_project_not_found",
            message: "/private/repo secret",
          },
        });
      },
    });
    expect(report.error).toEqual({
      code: "backend_transport_remote_error",
      message: "the backend rejected the request",
      profileId: "remote-b",
      remoteCode: "backend_project_not_found",
    });
    expect(formatProjectCommand(report)).toContain("backend_project_not_found");
    expect(JSON.stringify(report)).not.toContain("/private/repo secret");
  });
});

function remoteProfile(id, defaultProfile) {
  return {
    id,
    default: defaultProfile,
    transport: {
      kind: "ssh",
      host: `${id}.example.test`,
      port: 22,
      user: "dure",
      endpoint: { kind: "tcp", host: "127.0.0.1", port: 6767 },
      batchMode: true,
      strictHostKeyChecking: "yes",
      connectTimeoutMs: 1_000,
    },
    auth: { kind: "identity_file", reference: `credential-profile:${id}` },
    trust: { kind: "known_hosts", reference: `known-hosts-profile:${id}` },
    expected: {
      backendId: `${id}-backend`,
      generation: `${id}-generation-1`,
      protocol: {
        minimum: { major: 1, minor: 0 },
        maximum: { major: 1, minor: 0 },
      },
      capabilities: [
        "agent_spawn.apply",
        "agent_spawn.preview.v2",
        "projects.list",
        "projects.register",
        "projects.show",
      ],
    },
    deadlineMs: 2_500,
  };
}

function installRemoteFixture(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "backend-profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_profiles",
      profiles: [remoteProfile("remote-a", true), remoteProfile("remote-b", false)],
    }),
    { mode: 0o600 },
  );
  const references = [];
  const paths = {};
  for (const id of ["remote-a", "remote-b"]) {
    paths[id] = {
      identity: join(root, `${id}-identity`),
      knownHosts: join(root, `${id}-known-hosts`),
    };
    writeFileSync(paths[id].identity, `${id}-private-material`, { mode: 0o600 });
    writeFileSync(paths[id].knownHosts, `${id}.example.test fixture`, {
      mode: 0o600,
    });
    references.push(
      {
        reference: `credential-profile:${id}`,
        kind: "identity_file",
        path: paths[id].identity,
      },
      {
        reference: `known-hosts-profile:${id}`,
        kind: "known_hosts_file",
        path: paths[id].knownHosts,
      },
    );
  }
  writeFileSync(
    join(root, "backend-ssh-references.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_ssh_references",
      references,
    }),
    { mode: 0o600 },
  );

  const bin = join(root, "bin");
  const log = join(root, "ssh-observation.json");
  const runState = join(root, "ssh-agent-run.json");
  const state = join(root, "ssh-projects.json");
  mkdirSync(bin);
  const ssh = join(bin, "ssh");
  writeFileSync(
    ssh,
    `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const request = JSON.parse(readFileSync(0, "utf8"));
const argv = process.argv.slice(2);
const materials = Object.fromEntries([
  ["identity", "IdentityFile="],
  ["knownHosts", "UserKnownHostsFile="],
].map(([name, prefix]) => {
  const path = argv.find(value => value.startsWith(prefix)).slice(prefix.length);
  return [name, { path, contents: readFileSync(path, "utf8") }];
}));
const observations = existsSync(process.env.DURE_PROJECT_COMMAND_LOG)
  ? JSON.parse(readFileSync(process.env.DURE_PROJECT_COMMAND_LOG, "utf8"))
  : [];
observations.push({ argv, request, materials });
writeFileSync(process.env.DURE_PROJECT_COMMAND_LOG, JSON.stringify(observations));
const project = {
  id: "dure",
  displayName: "Dure",
  rootId: ${JSON.stringify(rootId)},
  repositoryId: ${JSON.stringify(repositoryId)},
};
const projects = existsSync(process.env.DURE_PROJECT_CATALOG_STATE)
  ? JSON.parse(readFileSync(process.env.DURE_PROJECT_CATALOG_STATE, "utf8"))
  : [];
if (request.operation === "projects.register" && projects.length === 0) {
  projects.push(project);
  writeFileSync(process.env.DURE_PROJECT_CATALOG_STATE, JSON.stringify(projects));
}
const capabilities = [
  "agent_spawn.apply",
  "agent_spawn.preview.v2",
  "projects.list",
  "projects.register",
  "projects.show",
];
const operationId = "spawn-0123456789abcdef0123456789abcdef";
const agentId = "agent-0123456789abcdef0123456789abcdef";
const workspaceId = "workspace-0123456789abcdef0123456789abcdef";
const sessionId = "session-0123456789abcdef0123456789abcdef";
const planToken = "sha256:${"a".repeat(64)}";
const recordedAtMs = 1_700_000_000_000;
let result;
if (request.operation === "projects.list") {
  result = { schemaVersion: 1, complete: true, projects };
} else if (request.operation === "projects.register" || request.operation === "projects.show") {
  result = { schemaVersion: 1, project: projects[0] };
} else if (request.operation === "agent_spawn.preview") {
  const permissionOverride = request.body.permissionOverride ?? null;
  const normalizedRequest = {
    ...request.body,
    projectId: project.id,
    providerConversationRef: request.body.providerConversationRef ?? null,
    permissionMode: permissionOverride === "auto_edit"
      ? "auto_edit"
      : permissionOverride === "bypass_approvals"
        ? "skip_permissions"
        : "default",
  };
  delete normalizedRequest.projectPath;
  delete normalizedRequest.permissionOverride;
  const plan = {
    schemaVersion: 1,
    operationId,
    authority: {
      backendId: request.expected.backendId,
      backendGeneration: request.expected.generation,
      projectId: project.id,
      rootId: project.rootId,
      repositoryId: project.repositoryId,
    },
    request: normalizedRequest,
    agentId,
    workspaceId,
    sessionId,
    runtime: {
      runtimeKindId: "runtime.hmux",
      requiredCapabilities: ["provider-launch", "session-create"],
    },
    providerLaunchDefaults: {
      schemaVersion: 1,
      revision: 0,
      fingerprint: "sha256:${"c".repeat(64)}",
      permissionOverride,
    },
    planToken,
  };
  writeFileSync(process.env.DURE_AGENT_RUN_STATE, JSON.stringify(plan));
  result = {
    schemaVersion: 1,
    receipt: {
      schemaVersion: 1,
      operationId,
      plan,
      state: "applying",
      lastSequence: 1,
      completed: [],
      recovery: { kind: "continue", stage: "worktree", next_attempt: 1 },
      terminalCode: null,
      createdAtMs: recordedAtMs,
      updatedAtMs: recordedAtMs,
    },
  };
} else {
  const plan = JSON.parse(readFileSync(process.env.DURE_AGENT_RUN_STATE, "utf8"));
  const runtimeSession = {
    sessionId,
    workspaceId,
    providerId: plan.request.providerId,
    runnerPrincipal: "runner-principal",
    runnerInstance: "runner-instance",
    channelEpoch: "channel-epoch",
    hostInstanceId: "host-instance",
    terminalEpoch: "terminal-epoch",
  };
  result = {
    schemaVersion: 1,
    receipt: {
      schemaVersion: 1,
      operationId,
      plan,
      state: "succeeded",
      lastSequence: 4,
      completed: [{
        stage: "worktree",
        attempt: 1,
        inputs: {
          stage: "worktree",
          workspace_id: workspaceId,
          project_root_id: project.rootId,
          repository_id: project.repositoryId,
          policy: { kind: "project_root" },
        },
        evidence: {
          stage: "worktree",
          workspace_id: workspaceId,
          disposition: "adopted_existing",
        },
      }, {
        stage: "runtime_launch",
        attempt: 1,
        inputs: {
          stage: "runtime_launch",
          agent_id: agentId,
          workspace_id: workspaceId,
          session_id: sessionId,
          runtime_kind_id: "runtime.hmux",
          provider_id: plan.request.providerId,
          provider_conversation_ref: plan.request.providerConversationRef,
          permission_mode: plan.request.permissionMode,
        },
        evidence: { stage: "runtime_launch", session: runtimeSession },
      }, {
        stage: "prompt_delivery",
        attempt: 1,
        inputs: {
          stage: "prompt_delivery",
          session_id: sessionId,
          prompt_digest: plan.request.promptDigest,
        },
        evidence: {
          stage: "prompt_delivery",
          session_id: sessionId,
          delivery_id: "delivery-1",
        },
      }],
      recovery: { kind: "none" },
      terminalCode: null,
      createdAtMs: recordedAtMs,
      updatedAtMs: recordedAtMs + 3,
    },
  };
}
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  apiVersion: "dure.backend-transport/v1",
  kind: "dure.backend.response",
  requestId: request.requestId,
  backend: {
    id: request.expected.backendId,
    generation: request.expected.generation,
    protocol: { major: 1, minor: 0 },
    capabilities,
    observedAtMs: Date.now(),
  },
  result,
}));
`,
  );
  chmodSync(ssh, 0o755);
  return { bin, log, paths, runState, state };
}

function runCli(root, args, environment = {}, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env: {
      ...process.env,
      DURE_APP_CHANNEL: "stable",
      DURE_HOME: root,
      ...environment,
    },
  });
}

describe("dure projects CLI", () => {
  it("registers and queries only the selected SSH backend without app state", () => {
    const root = temporaryRoot();
    const remote = installRemoteFixture(root);
    const environment = {
      DURE_PROJECT_COMMAND_LOG: remote.log,
      DURE_PROJECT_CATALOG_STATE: remote.state,
      DURE_AGENT_RUN_STATE: remote.runState,
      PATH: `${remote.bin}:${process.env.PATH}`,
    };
    const remoteProject = join(root, "remote-project");
    const remoteChild = join(remoteProject, "child");
    mkdirSync(remoteChild, { recursive: true });
    expect(existsSync(remote.state)).toBe(false);
    const registered = runCli(
      root,
      [
        "projects",
        "register",
        "dure",
        "--name",
        "Dure",
        "--backend",
        "remote-b",
        "--json",
      ],
      environment,
      { cwd: remoteProject },
    );
    expect(registered.status, `${registered.stdout}\n${registered.stderr}`).toBe(0);
    expect(JSON.parse(registered.stdout)).toMatchObject({
      kind: "dure.projects.register",
      project: projection(),
    });
    expect(registered.stdout).not.toContain(remoteProject);
    const registration = JSON.parse(readFileSync(remote.log, "utf8")).at(-1);
    expect(registration.request).toMatchObject({
      operation: "projects.register",
      body: {
        schemaVersion: 1,
        projectId: "dure",
        displayName: "Dure",
        root: realpathSync(remoteProject),
      },
      expected: { backendId: "remote-b-backend" },
    });

    const listed = runCli(
      root,
      ["projects", "list", "--backend", "remote-b", "--json"],
      { ...environment, DURE_CLIENT_ID: "desktop-a" },
    );
    expect(listed.status, `${listed.stdout}\n${listed.stderr}`).toBe(0);
    const report = JSON.parse(listed.stdout);
    expect(report).toMatchObject({
      kind: "dure.projects.list",
      source: {
        appDaemonRequired: false,
        profileId: "remote-b",
        transport: "ssh",
        backend: {
          id: "remote-b-backend",
          generation: "remote-b-generation-1",
        },
      },
      projects: [projection()],
    });
    const observation = JSON.parse(readFileSync(remote.log, "utf8")).at(-1);
    expect(observation.request).toMatchObject({
      operation: "projects.list",
      expected: { backendId: "remote-b-backend" },
    });
    expect(observation.argv).toContain("remote-b.example.test");
    for (const [name, contents] of Object.entries({
      identity: "remote-b-private-material",
      knownHosts: "remote-b.example.test fixture",
    })) {
      const material = observation.materials[name];
      expect(material.contents).toBe(contents);
      expect(material.contents).not.toBe(
        readFileSync(remote.paths["remote-a"][name], "utf8"),
      );
      expect(material.path).not.toBe(remote.paths["remote-b"][name]);
      expect(existsSync(material.path)).toBe(false);
      expect(readFileSync(remote.paths["remote-b"][name], "utf8")).toBe(contents);
      expect(listed.stdout).not.toContain(material.path);
      expect(listed.stdout).not.toContain(contents);
    }
    expect(observation.argv).not.toContain(
      `IdentityFile=${remote.paths["remote-a"].identity}`,
    );
    expect(existsSync(join(root, "server.json"))).toBe(false);
    expect(existsSync(join(root, "agents.json"))).toBe(false);
    expect(listed.stdout).not.toContain(remote.paths["remote-b"].identity);
    expect(listed.stdout).not.toMatch(/(?:client|pane|layout|focus)/i);

    const shown = runCli(
      root,
      ["projects", "show", "dure", "--backend", "remote-b", "--json"],
      { ...environment, DURE_CLIENT_ID: "desktop-b" },
    );
    expect(shown.status, `${shown.stdout}\n${shown.stderr}`).toBe(0);
    expect(JSON.parse(shown.stdout).project).toEqual(report.projects[0]);

    const prompt = "run from the registered remote child";
    const run = runCli(
      root,
      [
        "run",
        "--provider",
        "codex",
        "--name",
        "codex-remote",
        "--idempotency-key",
        "remote-run-1",
        "--backend",
        "remote-b",
        "--json",
        prompt,
      ],
      environment,
      { cwd: remoteChild },
    );
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    const runReport = JSON.parse(run.stdout);
    expect(runReport).toMatchObject({
      kind: "dure.agent_spawn.apply",
      receipt: {
        state: "succeeded",
        plan: {
          authority: {
            projectId: "dure",
            rootId,
            repositoryId,
          },
          request: { projectId: "dure" },
        },
      },
    });
    expect(runReport.receipt.plan.request).not.toHaveProperty("projectPath");
    expect(run.stdout).not.toContain(remoteProject);
    expect(run.stdout).not.toContain(prompt);
    const observations = JSON.parse(readFileSync(remote.log, "utf8"));
    const preview = observations.find(
      ({ request }) => request.operation === "agent_spawn.preview",
    );
    expect(preview.request.body.projectPath).toBe(realpathSync(remoteChild));
  });

  it("documents projects without bootstrapping app or profile state", () => {
    const root = temporaryRoot();
    const help = runCli(root, ["help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("dure projects list [--backend ID]");
    expect(help.stdout).toContain("dure projects show <id> [--backend ID]");
    expect(help.stdout).toContain("dure projects register <id>");
    expect(existsSync(join(root, "server.json"))).toBe(false);
    expect(existsSync(join(root, "backend-profiles.json"))).toBe(false);
  });
});
