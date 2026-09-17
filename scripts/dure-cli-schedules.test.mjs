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

import { collectScheduleCommand, formatScheduleCommand } from "../cli/lib/schedule-client.mjs";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function installRemoteFixture() {
  const root = mkdtempSync(join(tmpdir(), "dure-schedules-"));
  roots.push(root);
  const bin = join(root, "bin");
  const requestLog = join(root, "requests.jsonl");
  mkdirSync(bin);
  const ssh = join(bin, "ssh");
  writeFileSync(
    ssh,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const request = JSON.parse(readFileSync(0, "utf8"));
appendFileSync(process.env.DURE_SCHEDULE_REQUEST_LOG, JSON.stringify(request) + "\\n");
const schedule = {
  schemaVersion: 1,
  scheduleId: request.body.scheduleId || "morning-triage",
  revision: request.operation === "schedule.delete" ? request.body.expectedRevision + 1 : 1,
  name: request.body.name || "Morning triage",
  enabled: request.body.enabled ?? true,
  expression: request.body.expression || "0 9 * * 1-5",
  timezone: request.body.timezone || "Asia/Seoul",
  runTemplate: request.body.runTemplate
    ? { ...request.body.runTemplate, projectId: request.body.runTemplate.projectId || "dure", projectPath: undefined }
    : { projectId: "dure", providerId: "codex", prompt: "triage ready work", permissionMode: "default" },
  createdAtMs: 1700000000000,
  updatedAtMs: 1700000000000,
};
if (request.operation === "schedule.delete") schedule.deletedAtMs = 1700000000000;
const occurrence = {
  schemaVersion: 2,
  scheduleId: request.body.scheduleId || "morning-triage",
  scheduleRevision: 1,
  trigger: request.operation === "schedule.run_once" ? { kind: "manual" } : { kind: "scheduled", scheduledForMs: 1700000040000 },
  idempotencyKey: request.body.idempotencyKey || "schedule-run-fixture",
  launchState: "started",
  operationId: "spawn-fixture",
  createdAtMs: 1700000040000,
  updatedAtMs: 1700000040001,
};
if (request.operation === "schedule.inspect") occurrence.run = {
  runId: "run-fixture", taskId: "task-fixture", dispatchId: "dispatch-fixture",
  generation: 1, workspaceId: "workspace-fixture", completed: true,
};
const result = request.operation === "schedule.list"
  ? { schemaVersion: 1, complete: true, schedules: [schedule] }
  : request.operation === "schedule.occurrences"
    ? { schemaVersion: 1, occurrences: [occurrence] }
    : request.operation === "schedule.run_once"
      ? { schemaVersion: 1, occurrence }
      : request.operation === "schedule.inspect"
        ? { schemaVersion: 1, occurrence, resultMarkdown: "Retained daily review report." }
        : { schemaVersion: 1, schedule };
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  apiVersion: "dure.backend-transport/v1",
  kind: "dure.backend.response",
  requestId: request.requestId,
  backend: {
    id: "remote-backend",
    generation: "remote-generation-1",
    protocol: { major: 1, minor: 0 },
    capabilities: ["schedule.delete", "schedule.list", "schedule.occurrences", "schedule.put", "schedule.show", "schedule.run_once", "schedule.inspect"],
    observedAtMs: Date.now(),
  },
  result,
}));
`,
  );
  chmodSync(ssh, 0o755);
  const knownHosts = join(root, "known-hosts");
  writeFileSync(knownHosts, "remote.example.test ssh-ed25519 fixture\n", {
    mode: 0o600,
  });
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
            port: 22,
            user: "dure",
            endpoint: { kind: "tcp", host: "127.0.0.1", port: 6767 },
            batchMode: true,
            strictHostKeyChecking: "yes",
            connectTimeoutMs: 1_000,
          },
          auth: { kind: "ssh_agent" },
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
            capabilities: [
              "schedule.delete",
              "schedule.list",
              "schedule.occurrences",
              "schedule.put",
              "schedule.show",
              "schedule.run_once",
              "schedule.inspect",
            ],
          },
          deadlineMs: 10_000,
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
        {
          reference: "known-hosts-profile:remote",
          kind: "known_hosts_file",
          path: knownHosts,
        },
      ],
    }),
    { mode: 0o600 },
  );
  return { bin, requestLog, root };
}

describe("dure schedule", () => {
  it("requires exactly one project selector at the client boundary", async () => {
    const report = await collectScheduleCommand({
      action: "put",
      scheduleId: "morning-triage",
      expectedRevision: 0,
      idempotencyKey: "schedule-put-fixture",
      name: "Morning triage",
      enabled: true,
      expression: "0 9 * * 1-5",
      timezone: "Asia/Seoul",
      projectId: "dure",
      projectPath: "/srv/dure",
      providerId: "codex",
      prompt: "triage ready work",
      permissionMode: "default",
      backend: {
        profile: { id: "remote", transport: { kind: "ssh" } },
        transportOptions: {},
      },
      requestBackend: async () => {
        throw new Error("invalid input reached the backend");
      },
    });

    expect(report).toMatchObject({
      kind: "dure.schedules.error",
      error: { code: "backend_schedule_request_invalid" },
    });
  });

  it("rejects occurrence outcomes that violate the control-plane contract", async () => {
    const report = await collectScheduleCommand({
      action: "occurrences",
      scheduleId: "morning-triage",
      backend: {
        profile: { id: "remote", transport: { kind: "ssh" } },
        transportOptions: {},
      },
      requestBackend: async () => ({
        backend: { id: "remote-backend" },
        result: {
          schemaVersion: 1,
          occurrences: [
            {
              schemaVersion: 2,
              scheduleId: "morning-triage",
              scheduleRevision: 1,
              trigger: { kind: "scheduled", scheduledForMs: 1_700_000_040_000 },
              idempotencyKey: "schedule-run-fixture",
              launchState: "failed",
              operationId: "spawn-fixture",
              createdAtMs: 1_700_000_040_000,
              updatedAtMs: 1_700_000_040_001,
            },
          ],
        },
      }),
    });

    expect(report).toMatchObject({
      kind: "dure.schedules.error",
      error: { code: "backend_schedule_payload_invalid" },
    });
  });

  it("creates a backend-owned schedule without writing the legacy automation registry", () => {
    const fixture = installRemoteFixture();
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "schedule",
        "create",
        "--id",
        "morning-triage",
        "--name",
        "Morning triage",
        "--project",
        "dure",
        "--provider",
        "codex",
        "--model",
        "gpt-6-astra",
        "--effort",
        "xhigh",
        "--cron",
        "0 9 * * 1-5",
        "--timezone",
        "Asia/Seoul",
        "--prompt",
        "triage ready work",
        "--backend",
        "remote",
        "--json",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DURE_APP_CHANNEL: "stable",
          DURE_HOME: fixture.root,
          DURE_SCHEDULE_REQUEST_LOG: fixture.requestLog,
          PATH: `${fixture.bin}:${process.env.PATH}`,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      apiVersion: "dure.schedules/v1",
      kind: "dure.schedules.put",
      schedule: {
        scheduleId: "morning-triage",
        revision: 1,
        expression: "0 9 * * 1-5",
        timezone: "Asia/Seoul",
        runTemplate: { model: "gpt-6-astra", effort: "xhigh" },
      },
    });
    const request = JSON.parse(readFileSync(fixture.requestLog, "utf8"));
    expect(request).toMatchObject({
      operation: "schedule.put",
      expected: { requiredCapabilities: ["schedule.put"] },
      body: {
        schemaVersion: 1,
        scheduleId: "morning-triage",
        expectedRevision: 0,
        name: "Morning triage",
        enabled: true,
        expression: "0 9 * * 1-5",
        timezone: "Asia/Seoul",
        runTemplate: {
          projectId: "dure",
          providerId: "codex",
          prompt: "triage ready work",
          model: "gpt-6-astra",
          effort: "xhigh",
        },
      },
    });
    expect(existsSync(join(fixture.root, "automations.json"))).toBe(false);
    expect(existsSync(join(fixture.root, "automation-runs.json"))).toBe(false);
  });

  it("uses cwd when the project selector is omitted and accepts a prompt after --", () => {
    const fixture = installRemoteFixture();
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "schedule",
        "create",
        "--id",
        "cwd-triage",
        "--cron",
        "*/5 * * * *",
        "--backend",
        "remote",
        "--json",
        "--",
        "triage from cwd",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...process.env,
          DURE_APP_CHANNEL: "stable",
          DURE_HOME: fixture.root,
          DURE_SCHEDULE_REQUEST_LOG: fixture.requestLog,
          PATH: `${fixture.bin}:${process.env.PATH}`,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).schedule.scheduleId).toBe("cwd-triage");
    const request = JSON.parse(readFileSync(fixture.requestLog, "utf8"));
    expect(request.body.runTemplate).toMatchObject({
      projectPath: realpathSync(fixture.root),
      providerId: "claude",
      prompt: "triage from cwd",
    });
    expect(request.body.runTemplate).not.toHaveProperty("permissionMode");
    expect(request.body).not.toHaveProperty("projectId");
    expect(request.body.runTemplate).not.toHaveProperty("model");
    expect(request.body.runTemplate).not.toHaveProperty("effort");
  });

  it.each([
    ["list", ["schedule", "list", "--backend", "remote", "--json"], "schedule.list"],
    ["show", ["schedule", "show", "morning-triage", "--backend", "remote", "--json"], "schedule.show"],
    [
      "delete",
      [
        "schedule",
        "delete",
        "morning-triage",
        "--expected-revision",
        "1",
        "--idempotency-key",
        "delete-fixture",
        "--backend",
        "remote",
        "--json",
      ],
      "schedule.delete",
    ],
    ["runs", ["schedule", "runs", "morning-triage", "--backend", "remote", "--json"], "schedule.occurrences"],
    ["run-once", ["schedule", "run-once", "morning-triage", "--expected-revision", "1", "--idempotency-key", "manual-review", "--backend", "remote", "--json"], "schedule.run_once"],
    ["inspect", ["schedule", "inspect", "schedule-run-fixture", "--backend", "remote", "--json"], "schedule.inspect"],
  ])("routes %s through the selected backend capability", (_label, argv, operation) => {
    const fixture = installRemoteFixture();
    const result = spawnSync(process.execPath, [cliPath, ...argv], {
      encoding: "utf8",
      env: {
        ...process.env,
        DURE_APP_CHANNEL: "stable",
        DURE_HOME: fixture.root,
        DURE_SCHEDULE_REQUEST_LOG: fixture.requestLog,
        PATH: `${fixture.bin}:${process.env.PATH}`,
      },
    });

    expect(result.status).toBe(0);
    const request = JSON.parse(readFileSync(fixture.requestLog, "utf8"));
    expect(request.operation).toBe(operation);
    expect(request.expected.requiredCapabilities).toEqual([operation]);
  });

  it("displays launch acceptance separately from a retained completion report", () => {
    const occurrence = {
      idempotencyKey: "daily-review", launchState: "started", trigger: { kind: "manual" },
    };
    expect(formatScheduleCommand({ kind: "dure.schedules.inspect", occurrence, resultMarkdown: null }))
      .toBe("daily-review — Started; awaiting report");
    expect(formatScheduleCommand({ kind: "dure.schedules.inspect", occurrence: {
      ...occurrence, run: { completed: true },
    }, resultMarkdown: "Two findings." })).toBe("daily-review — Report received\n\nTwo findings.");
  });

  it("retires the file-backed auto command before loading the app registry", () => {
    const fixture = installRemoteFixture();
    const result = spawnSync(process.execPath, [cliPath, "auto", "list"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DURE_APP_CHANNEL: "stable",
        DURE_HOME: fixture.root,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("retired");
    expect(result.stderr).toContain("dure schedule");
    expect(existsSync(join(fixture.root, "automations.json"))).toBe(false);
    expect(existsSync(join(fixture.root, "automation-runs.json"))).toBe(false);
  });
});
