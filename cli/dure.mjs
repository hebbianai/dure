#!/usr/bin/env node
// dure — Dure 에이전트를 외부(터미널/스크립트)에서 제어하는 CLI.
// Legacy agent control commands may read the app's ~/.dure/agents.json
// projection. Backend-native session and orchestration commands resolve their
// own exact identities and do not make the app registry an authority.
// 의존성 없음(Node 내장만 사용).

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { parseOpts } from "./lib/cli-options.mjs";
import { appControlDirectory, appRootDirectory, loadAppControlDescriptor } from "./lib/app-control-location.mjs";
import { agentDisplayName, matchingAgents } from "./lib/client-registry.mjs";
import {
  approvedOrchestrationIntegrationRefreshProviders,
  inspectOrchestrationIntegrations,
  runOrchestrationIntegrationAction,
} from "./lib/orchestration-integration.mjs";
import { runRemoteOrchestrationIntegration } from "./lib/orchestration-integration-remote.mjs";
import {
  createDiagnosticReport,
  evaluateDiagnosticCheck,
  formatDiagnosticReport,
  formatVersion,
  inspectAppRuntime,
  inspectCliIdentity,
  parseDiagnosticRequirements,
  supportsHmuxCapability,
} from "./lib/runtime-diagnostics.mjs";
import { parsePlainInteractiveSsh } from "./lib/ssh-command.mjs";
import { runBoundedCommand } from "./lib/bounded-command.mjs";
import { captureLocalScreen, SessionCaptureError } from "./lib/local-session-read.mjs";
import {
  backendHealthExitCode,
  collectBackendStatus,
  DEFAULT_BACKEND_DEADLINE_MS,
  formatBackendStatus,
  MAX_BACKEND_DEADLINE_MS,
} from "./lib/backend-status.mjs";
import {
  DEFAULT_ORCHESTRATION_STATUS_CACHE_MS,
  DEFAULT_ORCHESTRATION_STATUS_TIMEOUT_MS,
  MAX_ORCHESTRATION_STATUS_CACHE_MS,
  MAX_ORCHESTRATION_STATUS_TIMEOUT_MS,
  runOrchestrationStatusFromCli,
} from "./lib/orchestration-status-command.mjs";
import {
  CLIENT_PRESENTATION_HELP,
  clientPresentationErrorReport,
  clientPresentationExitCode,
  clientPresentationJsonRequested,
  clientPresentationRequestedCommand,
  clientSpaceIdentityPayload,
  formatClientPresentationReceipt,
  runClientPresentationCommand,
} from "./lib/client-presentation-command.mjs";
import {
  requestAppControl as requestAppControlRequest,
} from "./lib/app-control-client.mjs";
import { runPerformanceCommand } from "./lib/performance-report.mjs";
import { bindBundledDureRuntime } from "./lib/dure-cli-bundled-runtime.mjs";
import { controllableHmuxBinding, managedInputFenceJson } from "./lib/managed-input-binding.mjs";
import {
  installSkill,
  inspectSkills,
  providerTargets,
  removeSkill,
} from "./lib/skill-install.mjs";

const CLI_COMMAND = "dure";
const CLI_SCRIPT_PATH = fileURLToPath(import.meta.url);
bindBundledDureRuntime(CLI_SCRIPT_PATH);
const DEPRECATED_COMMANDS = new Set(["hebbian-ade", "hebbian-ide"]);
const invocationArguments = process.argv.slice(2);
const invocationOptions = parseOpts(invocationArguments.slice(1));
const checkpointHookInvocation =
  (invocationArguments[0] === "checkpoint" ||
    invocationArguments[0] === "comment") &&
  invocationOptions.hookJson === true;
const invokedCommand =
  process.env.DURE_INVOKED_AS?.trim() || basename(process.argv[1] || "");
if (DEPRECATED_COMMANDS.has(invokedCommand) && !checkpointHookInvocation) {
  process.stderr.write(
    `[deprecated] ${invokedCommand} is deprecated; use dure instead.\n`,
  );
}
const MINIMUM_MANAGED_READ_HMUX_VERSION = [0, 2, 2];
const MANAGED_READ_HMUX_CAPABILITY = "bounded_screen_read_v1";
const MANAGED_INPUT_HMUX_CAPABILITY = "semantic_command_input_v1";
const MANAGED_INPUT_CAPABILITY_TIMEOUT_MS = 2_500;
const MANAGED_INPUT_TIMEOUT_MS = 10_000;
const COMPATIBILITY_DIAGNOSTIC_TIMEOUT_MS = 750;
const PROVIDER_TRANSCRIPT_APP_CAPABILITY = "provider_transcript.read_v1";
const PROVIDER_TRANSCRIPT_RESPONSE_BYTES = 32 * 1024 * 1024;
// CLI and MCP share app-home and channel selection; legacy homes are import inputs only.
const DURE_ROOT = appRootDirectory();
const APP_CHANNEL =
  process.env.DURE_APP_CHANNEL ?? process.env.HEBBIAN_APP_CHANNEL ?? "stable";
const appChannelIsValid = /^[a-z0-9-]{1,64}$/.test(APP_CHANNEL);
if (
  !appChannelIsValid &&
  invocationArguments[0] !== "hooks" &&
  !checkpointHookInvocation
) {
  fail("DURE_APP_CHANNEL may contain only lowercase letters, digits, and hyphens.");
}
const APP_CONTROL_DIR =
  !appChannelIsValid ? DURE_ROOT : appControlDirectory();
const REG = join(APP_CONTROL_DIR, "agents.json");

function loadRegistry() {
  try {
    return JSON.parse(readFileSync(REG, "utf8"));
  } catch {
    fail(
      `Cannot read the agent registry: ${REG}\n` +
        `Launch the Dure app once to create it.`,
    );
  }
}

function loadRegistryOptional() {
  try {
    return JSON.parse(readFileSync(REG, "utf8"));
  } catch {
    return undefined;
  }
}

function fail(msg) {
  // Colour only an interactive terminal; the app and scripts read stderr verbatim.
  process.stderr.write(
    process.stderr.isTTY ? `\x1b[31m${msg}\x1b[0m\n` : `${msg}\n`,
  );
  process.exit(1);
}

/** 이름(또는 project/name)으로 에이전트 하나를 특정 */
function resolve(reg, query) {
  if (!query) fail("An agent name is required.");
  const matches = matchingAgents(reg, query);
  if (matches.length === 0)
    fail(
      `Agent '${query}' was not found. List agents with: ${CLI_COMMAND} ls`,
    );
  if (matches.length > 1)
    fail(
      `Multiple agents match '${query}'. Specify project/name or a session ID:\n` +
        matches
          .map((a) => `  ${a.project}/${agentDisplayName(a)} (${a.sessionId})`)
          .join("\n"),
    );
  return matches[0];
}

function resolveReadTarget(reg, query) {
  if (!query) fail("An Agent name or Hmux session identity is required.");
  const matches = matchingAgents(reg, query);
  if (matches.length > 1) {
    fail(
      `'${query}' matches multiple Agents; use project/name or a session ID:\n` +
        matches
          .map((agent) =>
            `  ${agent.project}/${agentDisplayName(agent)} (${agent.sessionId})`,
          )
          .join("\n"),
    );
  }
  return matches[0] ?? query;
}

function run(argv, { capture = false, timeoutMs } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: capture ? timeoutMs ?? 8000 : undefined,
  });
  return r;
}

async function runSystemSsh(argv) {
  const child = spawn("/usr/bin/ssh", argv, { stdio: "inherit" });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (status.signal) {
    process.kill(process.pid, status.signal);
    return;
  }
  process.exitCode = status.code ?? 1;
}

async function cmdInternalSsh(argv) {
  const parsed = parsePlainInteractiveSsh(argv);
  const sourceSessionId = process.env.HMUX_SESSION_ID?.trim();
  const sourceWorkspaceId = process.env.HMUX_WORKSPACE_ID?.trim();
  if (
    parsed.kind !== "handoff" ||
    !sourceSessionId ||
    !sourceWorkspaceId
  ) {
    return runSystemSsh(argv);
  }
  const server = loadServer();
  if (!server) return runSystemSsh(argv);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${server.port}/hmux/remote-shell`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${server.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sourceSessionId,
        sourceWorkspaceId,
        argv,
        destination: parsed.destination,
        initialColumns: process.stdout.columns,
        initialRows: process.stdout.rows,
      }),
    });
  } catch (error) {
    fail(
      `Could not confirm whether the remote Dure Hmux request was applied: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = await response.json().catch(() => ({}));
  if (response.ok && body?.ok === true) return;
  if (body?.fallback === true) return runSystemSsh(argv);
  fail(
    body?.error?.message ||
      body?.error ||
      `Remote Dure Hmux connection failed (${response.status})`,
  );
}

let hmuxCompatibilityInspection;
let hmuxManagedInputInspection;

function hmuxCommand() {
  const configured = process.env.DURE_HMUX_BIN?.trim();
  if (configured) return configured;
  if (APP_CHANNEL.startsWith("dev-")) {
    return join(
      homedir(),
      ".local",
      "share",
      "hmux",
      "channels",
      APP_CHANNEL,
      "bin",
      process.platform === "win32" ? "hmux.exe" : "hmux",
    );
  }
  return process.env.HEBBIAN_HMUX_BIN?.trim() || "hmux";
}

function commandSucceeded(result) {
  return result?.status === 0 || result?.kind === "success";
}

function commandDetail(result) {
  if (result?.kind === "timeout") return "capability probe timed out";
  if (result?.kind === "aborted") return "capability probe interrupted";
  if (result?.kind === "output_limit") return "capability probe output limit exceeded";
  return (
    result?.message ||
    result?.error?.message ||
    result?.stderr?.trim() ||
    result?.stdout?.trim() ||
    `capability probe exited ${result?.status ?? result?.code ?? "unknown"}`
  );
}

function createHmuxCompatibilityInspection(
  command,
  capabilityResult,
  versionResult,
) {
  let capabilityPayload;
  try {
    capabilityPayload = JSON.parse(capabilityResult.stdout || "");
  } catch {}
  const versionOutput =
    `${versionResult.stdout || ""}\n${versionResult.stderr || ""}`.trim();
  const version = versionOutput.match(/\bhmux\s+(\d+\.\d+\.\d+)\b/i)?.[1];
  return {
    command,
    compatible:
      commandSucceeded(capabilityResult) &&
      supportsHmuxCapability(capabilityPayload, MANAGED_READ_HMUX_CAPABILITY),
    managedInputCompatible:
      commandSucceeded(capabilityResult) &&
      supportsHmuxCapability(capabilityPayload, MANAGED_INPUT_HMUX_CAPABILITY),
    version,
    detail: commandDetail(capabilityResult),
  };
}

function parseBackendMilliseconds(value, { name, fallback, minimum }) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    fail(`${name} must be an integer in the range ${minimum}..${MAX_BACKEND_DEADLINE_MS}.`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > MAX_BACKEND_DEADLINE_MS
  ) {
    fail(`${name} must be an integer in the range ${minimum}..${MAX_BACKEND_DEADLINE_MS}.`);
  }
  return parsed;
}

function parseOrchestrationMilliseconds(
  value,
  { fallback, maximum, minimum, name },
) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    fail(`${name} must be an integer in the range ${minimum}..${maximum}.`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    fail(`${name} must be an integer in the range ${minimum}..${maximum}.`);
  }
  return parsed;
}

function cmdOrchestrationStatus(subcommand, opts) {
  if (
    (subcommand !== "status" && subcommand !== "health") ||
    opts.rest.length !== 1
  ) {
    fail(
      "Usage: dure orch <status|health> [--json] [--repo PATH] [--backend ID] [--timeout-ms N] [--cache-ms N]",
    );
  }
  const timeoutMs = parseOrchestrationMilliseconds(opts.timeoutMs, {
    fallback: DEFAULT_ORCHESTRATION_STATUS_TIMEOUT_MS,
    maximum: MAX_ORCHESTRATION_STATUS_TIMEOUT_MS,
    minimum: 1,
    name: "--timeout-ms",
  });
  const cacheMs = parseOrchestrationMilliseconds(opts.cacheMs, {
    fallback: DEFAULT_ORCHESTRATION_STATUS_CACHE_MS,
    maximum: MAX_ORCHESTRATION_STATUS_CACHE_MS,
    minimum: 0,
    name: "--cache-ms",
  });
  process.exitCode = runOrchestrationStatusFromCli({
    backend: opts.backendSpecified ? opts.backend : undefined,
    cacheMs,
    json: Boolean(opts.json),
    mode: subcommand,
    repository: opts.repo,
    timeoutMs,
  });
}

async function cmdOrchestrationInvoke(opts) {
  try {
    const { runOrchestrationInvokeFromCli } = await import(
      "./lib/orchestration-command.mjs"
    );
    const { selectBackendProfileForRequest } = await import(
      "./lib/local-backend.mjs"
    );
    await runOrchestrationInvokeFromCli({
      arguments_: opts.rest.slice(1),
      backend: opts.backend,
      backendSpecified: opts.backendSpecified,
      json: Boolean(opts.json),
      prepareBackendProfile: (explicitId) =>
        selectBackendProfileForRequest({
          cliScriptPath: CLI_SCRIPT_PATH,
          environment: process.env,
          explicitId,
        }),
    });
  } catch (error) {
    const { BackendTransportError, backendTransportErrorReport } = await import(
      "./lib/backend-transport.mjs"
    );
    const code =
      typeof error?.code === "string"
        ? error.code
        : "orchestration_request_failed";
    const message = error instanceof Error ? error.message : String(error);
    const detail =
      error instanceof BackendTransportError
        ? backendTransportErrorReport(error).error
        : { code, message };
    if (opts.json) {
      process.stderr.write(
        `${JSON.stringify({
          apiVersion: "dure.orchestration/v1",
          error: detail,
        })}\n`,
      );
    } else {
      const reason = [
        detail.remoteCode ?? detail.code,
        detail.reasonCode,
        detail.disposition,
      ].filter(Boolean).join(": ");
      process.stderr.write(`\x1b[31m${reason}: ${detail.message}\x1b[0m\n`);
    }
    process.exitCode = 2;
  }
}

async function cmdBackend(subcommand, opts) {
  if (subcommand === "reconcile" || subcommand === "activate") {
    if (
      opts.rest.length !== 1 ||
      (opts.backendSpecified && !opts.backend) ||
      opts.timeoutMs !== undefined ||
      opts.probeBudgetMs !== undefined
    ) {
      fail("Usage: dure backend <reconcile|activate> [--backend ID] [--json]");
    }
    const { runBackendReconcileFromCli } = await import(
      "./lib/backend-reconcile.mjs"
    );
    const { selectBackendProfileForRequest } = await import(
      "./lib/local-backend.mjs"
    );
    process.exitCode = await runBackendReconcileFromCli({
      explicitId: opts.backendSpecified ? opts.backend : undefined,
      json: Boolean(opts.json),
      prepareBackendProfile: (explicitId) =>
        selectBackendProfileForRequest({
          cliScriptPath: CLI_SCRIPT_PATH,
          environment: process.env,
          explicitId,
          activateCurrentBundle: subcommand === "activate",
        }),
    });
    return;
  }
  if (
    (subcommand !== "status" && subcommand !== "health") ||
    opts.rest.length !== 1
  ) {
    fail(
      "Usage: dure backend <status|health> [--json] [--timeout-ms N] [--probe-budget-ms N]",
    );
  }
  const deadlineMs = parseBackendMilliseconds(opts.timeoutMs, {
    name: "--timeout-ms",
    fallback: DEFAULT_BACKEND_DEADLINE_MS,
    minimum: 1,
  });
  const probeBudgetMs =
    opts.probeBudgetMs === undefined
      ? undefined
      : parseBackendMilliseconds(opts.probeBudgetMs, {
          name: "--probe-budget-ms",
          fallback: undefined,
          minimum: 0,
        });
  const report = await collectBackendStatus({
    environment: process.env,
    hmuxCommand: hmuxCommand(),
    deadlineMs,
    probeBudgetMs:
      probeBudgetMs === undefined
        ? undefined
        : Math.min(probeBudgetMs, deadlineMs),
    view: subcommand,
  });
  process.stdout.write(
    opts.json ? `${JSON.stringify(report)}\n` : `${formatBackendStatus(report)}\n`,
  );
  if (subcommand === "health") {
    process.exitCode = backendHealthExitCode(report);
  }
}

function inspectHmuxCompatibility() {
  if (hmuxCompatibilityInspection) return hmuxCompatibilityInspection;
  const command = hmuxCommand();
  const capabilityResult = run([command, "capabilities", "--json"], {
    capture: true,
  });
  const versionResult = run([command, "--version"], { capture: true });
  hmuxCompatibilityInspection = createHmuxCompatibilityInspection(
    command,
    capabilityResult,
    versionResult,
  );
  return hmuxCompatibilityInspection;
}

function inspectManagedInputCompatibility() {
  if (hmuxManagedInputInspection) return hmuxManagedInputInspection;
  const command = hmuxCommand();
  const result = run([command, "capabilities", "--json"], {
    capture: true,
    timeoutMs: MANAGED_INPUT_CAPABILITY_TIMEOUT_MS,
  });
  let payload;
  try {
    payload = JSON.parse(result.stdout || "");
  } catch {}
  hmuxManagedInputInspection = {
    managedInputCompatible:
      commandSucceeded(result) &&
      supportsHmuxCapability(payload, MANAGED_INPUT_HMUX_CAPABILITY),
    detail: commandDetail(result),
  };
  return hmuxManagedInputInspection;
}

async function inspectHmuxCompatibilityBounded(signal) {
  const command = hmuxCommand();
  const [capabilityResult, versionResult] = await Promise.all([
    runBoundedCommand([command, "capabilities", "--json"], {
      signal,
      timeoutMs: COMPATIBILITY_DIAGNOSTIC_TIMEOUT_MS,
    }),
    runBoundedCommand([command, "--version"], {
      signal,
      timeoutMs: COMPATIBILITY_DIAGNOSTIC_TIMEOUT_MS,
    }),
  ]);
  return createHmuxCompatibilityInspection(
    command,
    capabilityResult,
    versionResult,
  );
}

function managedReadCompatibilityMessage(inspection) {
  const installed = inspection.version
    ? `installed version ${inspection.version}`
    : `inspection failed: ${inspection.detail}`;
  return (
    `Managed Hmux reads require the ${MANAGED_READ_HMUX_CAPABILITY} capability` +
    ` (hmux >= ${MINIMUM_MANAGED_READ_HMUX_VERSION.join(".")})` +
    ` (${installed}, command: ${inspection.command}).\n` +
    `Update stable Hmux from the Dure root with \`pnpm hmux:install\`, or set ` +
    `DURE_HMUX_BIN to a compatible binary` +
    ` (HEBBIAN_HMUX_BIN remains a compatibility alias).`
  );
}

function currentCliIdentity() {
  return inspectCliIdentity({
    scriptPath: CLI_SCRIPT_PATH,
    invocationPath: process.argv[1],
    invokedAs: invokedCommand || CLI_COMMAND,
  });
}

function cmdVersion(opts) {
  const identity = currentCliIdentity();
  process.stdout.write(
    (opts.json
      ? JSON.stringify({
          schemaVersion: 1,
          command: identity.command,
          packageVersion: identity.packageVersion,
          buildId: identity.buildId,
          installation: identity.installation,
          binary: identity.resolvedPath,
        })
      : formatVersion(identity)) + "\n",
  );
}

async function cmdDiagnostics(opts) {
  if (opts.require !== undefined && !opts.check) {
    fail("--require must be used with diagnostics --check.");
  }
  let required = null;
  if (opts.check) {
    try {
      required = parseDiagnosticRequirements(opts.require);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  const identity = currentCliIdentity();
  const app = await inspectAppRuntime({
    descriptorPath: join(APP_CONTROL_DIR, "server.json"),
  });
  const hmuxInspection = inspectHmuxCompatibility();
  const diagnosticReport = createDiagnosticReport({
    cli: identity,
    app,
    hmux: {
      command: hmuxInspection.command,
      version: hmuxInspection.version ?? null,
      compatible: hmuxInspection.compatible,
      requiredCapability: MANAGED_READ_HMUX_CAPABILITY,
      minimumVersion: MINIMUM_MANAGED_READ_HMUX_VERSION.join("."),
    },
  });
  const report = required
    ? {
        ...diagnosticReport,
        check: evaluateDiagnosticCheck(diagnosticReport, required),
      }
    : diagnosticReport;
  process.stdout.write(
    (opts.json ? JSON.stringify(report) : formatDiagnosticReport(report)) + "\n",
  );
  if (report.check && !report.check.passed) process.exitCode = 1;
}

function targetName(agent) {
  return agent.kind === "ssh" ? agent.remoteTmux : agent.sessionId;
}

function localHmuxBinding(agent) {
  const binding = agent.runtimeBinding;
  return (binding?.runtime === "hmux_managed_v1" ||
    binding?.runtime === "hmux_standalone_v1") &&
    binding.source === "local" &&
    binding.hostId === "local" &&
    binding.sessionId === agent.sessionId
    ? binding
    : null;
}

function sendManagedInputDirect(binding, text, enter) {
  const expectedFenceJson = managedInputFenceJson(binding);
  if (!expectedFenceJson) {
    return {
      kind: "unavailable",
      detail:
        "The complete generation fence required for managed Hmux input is missing. Reopen the pane or migrate the session.",
    };
  }
  const result = run(
    [
      hmuxCommand(),
      "--json",
      "command-input",
      "--target",
      binding.sessionId,
      "--workspace",
      binding.workspaceId,
      "--expected-fence-json",
      expectedFenceJson,
      "--text",
      text,
      ...(enter === false ? [] : ["--submit"]),
    ],
    { capture: true, timeoutMs: MANAGED_INPUT_TIMEOUT_MS },
  );
  if (result.status !== 0) {
    let failure;
    try {
      failure = JSON.parse(result.stdout || "");
    } catch {}
    const code =
      typeof failure?.error?.code === "string" ? failure.error.code : null;
    const detail = code
      ? `${code}: ${failure.error.message || "Managed Hmux input was rejected"}`
      : result.stderr?.trim() ||
        result.error?.message ||
        `Managed Hmux input command exited with status ${result.status ?? "unknown"}`;
    return { kind: "failed", detail };
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout || "");
  } catch {
    return {
      kind: "failed",
      detail: "The managed Hmux input command did not return a valid JSON receipt.",
    };
  }
  if (
    payload?.ok !== true ||
    !validSemanticCommandInputReceipt(
      payload.receipt,
      text,
      enter !== false,
      binding.stopFence.terminalEpoch,
    )
  ) {
    return {
      kind: "failed",
      detail: "Managed Hmux input did not return a final written_to_pty receipt.",
    };
  }
  return {
    kind: "success",
    input: {
      sessionId: binding.sessionId,
      workspaceId: binding.workspaceId,
      receipt: payload.receipt,
    },
  };
}

function validSemanticCommandInputReceipt(
  receipt,
  text,
  submit,
  expectedTerminalEpoch,
) {
  const writtenRecordId = (value) =>
    value?.state === "written_to_pty" &&
    typeof value.recordId === "string" &&
    /^[1-9][0-9]*$/.test(value.recordId)
      ? BigInt(value.recordId)
      : null;
  const textRecordId = writtenRecordId(receipt?.text);
  const submitRecordId = writtenRecordId(receipt?.submit);
  return (
    typeof receipt?.terminalEpoch === "string" &&
    receipt.terminalEpoch.length > 0 &&
    (expectedTerminalEpoch === undefined ||
      receipt.terminalEpoch === expectedTerminalEpoch) &&
    (text.length > 0 ? textRecordId !== null : receipt.text == null) &&
    (submit ? submitRecordId !== null : receipt.submit == null) &&
    (textRecordId === null ||
      submitRecordId === null ||
      submitRecordId === textRecordId + 1n)
  );
}

async function capture(reg, target, lines, signal, opts = {}) {
  const binding = typeof target === "string" ? null : localHmuxBinding(target);
  if (typeof target !== "string" && !binding) {
    // The legacy session daemon is retired (2026-08-16). Remote managed reads
    // need an hmux-native path and are a tracked follow-up.
    throw new SessionCaptureError(
      "unsupported_runtime",
      "This agent session does not use a local Hmux runtime and cannot be read through the CLI. The legacy session daemon has been retired.",
    );
  }
  if (binding && opts.workspace && opts.workspace !== binding.workspaceId) {
    throw new SessionCaptureError("invalid", "--workspace does not match the selected Agent session");
  }
  return captureLocalScreen({
    command: hmuxCommand(),
    sessionId: binding?.sessionId ?? target,
    workspaceId: binding?.workspaceId ?? opts.workspace,
    lines,
    deadlineMs: opts.deadlineMs === undefined ? undefined : Number(opts.deadlineMs),
    signal,
    inspectCompatibility: inspectHmuxCompatibilityBounded,
    compatibilityMessage: managedReadCompatibilityMessage,
  });
}

function captureInterruption() {
  const controller = new AbortController();
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    controller.abort();
  };
  process.once("SIGINT", onInterrupt);
  return {
    dispose: () => process.removeListener("SIGINT", onInterrupt),
    interrupted: () => interrupted,
    signal: controller.signal,
  };
}

function delay(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function sendText(
  reg,
  agent,
  text,
  enter,
  windowLabel,
  requestedIdempotencyKey,
) {
	if (agent.interactionProfile != null) {
		const { sendStructuredAgentInput } = await import("./lib/structured-agent-input.mjs");
		try {
			return await sendStructuredAgentInput({
				agent, text, enter, windowLabel,
				idempotencyKey: requestedIdempotencyKey, descriptor: loadServer(),
			});
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
		}
	}
  const binding = controllableHmuxBinding(agent);
  if (binding) {
    if (
      requestedIdempotencyKey !== undefined &&
      !/^[A-Za-z0-9_.-]{1,128}$/.test(requestedIdempotencyKey)
    ) {
      fail(
        "--idempotency-key must contain 1–128 ASCII letters, digits, hyphens, underscores, or periods.",
      );
    }
    if (
      binding.source === "local" &&
      binding.runtime === "hmux_managed_v1" &&
      managedInputFenceJson(binding) &&
      requestedIdempotencyKey === undefined
    ) {
      const compatibility = inspectManagedInputCompatibility();
      if (compatibility.managedInputCompatible) {
        const direct = sendManagedInputDirect(binding, text, enter);
        if (direct.kind === "success") return direct.input;
        fail(direct.detail);
      }
    }
    const srv = loadServer();
    if (!srv) {
      if (requestedIdempotencyKey !== undefined) {
        fail(
          "Input with --idempotency-key requires the current app broker. Direct input without the app does not automatically retry indeterminate outcomes.",
        );
      }
      if (binding.source === "ssh") {
        fail("Remote Hmux input requires a Dure app server to verify the exact fence.");
      }
      if (binding.runtime === "hmux_managed_v1") {
        const compatibility = inspectManagedInputCompatibility();
        if (!compatibility.managedInputCompatible) {
          fail(
            `Managed input without the app requires the ${MANAGED_INPUT_HMUX_CAPABILITY} capability. ` +
              `Update Hmux with \`pnpm hmux:install\` from the Dure repository root.`,
          );
        }
      }
      fail("The app server was not found. Reopen or migrate this legacy Hmux binding.");
    }
    const idempotencyKey = requestedIdempotencyKey ?? randomUUID();
    const body = {
      target: {
        schemaVersion: 1,
        targetPanelId: `agent:${agent.id}`,
        hostId: binding.hostId,
        sessionId: binding.sessionId,
        workspaceId: binding.workspaceId,
      },
      text,
      enter: enter !== false,
      idempotencyKey,
    };
    if (windowLabel) body.windowLabel = windowLabel;
    const request = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/hmux/input`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${srv.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        return {
          res,
          response: await res.json().catch(() => null),
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    };
    const attempt = await request();
    if (attempt.error) {
      fail(
        `App server request failed: ${attempt.error.message} (idempotency key: ${idempotencyKey})`,
      );
    }
    const { res, response } = attempt;
    if (!res.ok || !response?.ok) {
      fail(
        `${response?.error?.message || `Managed Hmux input was rejected (HTTP ${res.status})`} (idempotency key: ${idempotencyKey})`,
      );
    }
    if (
      !validSemanticCommandInputReceipt(
        response.input?.receipt,
        text,
        enter !== false,
      )
    ) {
      fail(
        `The app server did not return a semantic written_to_pty receipt. The outcome is indeterminate and was not automatically retried. (idempotency key: ${idempotencyKey})`,
      );
    }
    return response.input;
  }

  // The legacy daemon send path is retired (2026-08-16): every deliverable
  // agent is hmux-bound and handled above — anything else fails visibly.
  fail(
    "This agent session does not use an Hmux runtime and cannot receive input. The legacy session daemon has been retired.",
  );
  return null;
}

// ---------- 명령 ----------

/** 세션 안에서 자기 세션 id: legacy 호스트는 HEBBIAN_SESSION을, 관리형 hmux
 *  runtime은 중립 이름 HMUX_SESSION_ID(=같은 sessionId)를 심는다. hmux는
 *  provider/앱 중립이라 HEBBIAN_SESSION을 안 심으므로 여기서 폴백한다 (UC-16). */
function selfSessionId() {
  return process.env.HEBBIAN_SESSION || process.env.HMUX_SESSION_ID || undefined;
}

/** 자기 에이전트 해석: HEBBIAN_SESSION/HEBBIAN_AGENT(세션 안) →
 *  --agent <이름> → cwd가 속한 워크트리(최장 접두사). */
function resolveSelf(reg, opts) {
  const sess = selfSessionId();
  if (sess) {
    const a = reg.agents.find((x) => x.sessionId === sess || x.remoteTmux === sess);
    if (a) return a;
  }
  if (process.env.HEBBIAN_AGENT) {
    const a = reg.agents.find(
      (x) =>
        x.name === process.env.HEBBIAN_AGENT ||
        agentDisplayName(x) === process.env.HEBBIAN_AGENT,
    );
    if (a) return a;
  }
  if (opts.agent) return resolve(reg, opts.agent);
  const cwd = process.cwd();
  const byCwd = reg.agents
    .filter((a) => cwd === a.worktree || cwd.startsWith(a.worktree + "/"))
    .sort((a, b) => b.worktree.length - a.worktree.length)[0];
  if (byCwd) return byCwd;
  fail(
    "Could not identify the target agent. Run inside an agent session or worktree, or specify --agent <name>.",
  );
}

function failStrictWhoami(code, message, json) {
  if (json) {
    process.stderr.write(
      `${JSON.stringify({ schemaVersion: 1, code, message })}\n`,
    );
    process.exit(1);
  }
  fail(`${code}: ${message}`);
}

function resolveStrictSessionIdentity(reg, sessionId, json) {
  if (
    typeof sessionId !== "string" ||
    sessionId !== sessionId.trim() ||
    !sessionId ||
    Buffer.byteLength(sessionId, "utf8") > 512 ||
    /[\u0000-\u001f\u007f]/.test(sessionId) ||
    !Array.isArray(reg?.agents)
  ) {
    failStrictWhoami(
      "dure_whoami_strict_session_invalid",
      "strict whoami requires one canonical session ID and a valid registry",
      json,
    );
  }
  const matches = reg.agents.filter((agent) => agent?.sessionId === sessionId);
  // No match means this session is not an agent at all — a plain shell pane,
  // or a terminal the user opened. That is a different answer from "more than
  // one agent claims this session", and only the latter is unsafe to resolve.
  if (matches.length === 0) {
    failStrictWhoami(
      "dure_whoami_strict_session_unregistered",
      `no registry agent owns this session: ${sessionId}`,
      json,
    );
  }
  if (matches.length !== 1) {
    failStrictWhoami(
      "dure_whoami_strict_session_ambiguous",
      `strict whoami requires exactly one registry session: ${sessionId}`,
      json,
    );
  }
  const agent = matches[0];
  if (agent.kind !== "pty") {
    failStrictWhoami(
      "dure_whoami_strict_transport_unsupported",
      "strict whoami only accepts a local pty agent identity",
      json,
    );
  }
  if (
    typeof agent.id !== "string" ||
    !/^agent-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(agent.id) ||
    reg.agents.filter((candidate) => candidate?.id === agent.id).length !== 1
  ) {
    failStrictWhoami(
      "dure_whoami_strict_agent_id_invalid",
      "strict whoami requires one unique canonical stable agent ID",
      json,
    );
  }
  return agent;
}

function cmdWhoami(reg, opts) {
  const strict = opts.strictSession !== undefined;
  const agent = strict
    ? resolveStrictSessionIdentity(reg, opts.strictSession, opts.json)
    : resolveSelf(reg, opts);
  const displayName = agentDisplayName(agent);
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          id: agent.id ?? null,
          displayName,
          name: agent.name,
          project: agent.project,
          provider: agent.provider,
          sessionId: agent.sessionId,
          worktree: agent.worktree,
          branch: agent.branch,
          ...(strict ? { kind: agent.kind } : {}),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  process.stdout.write(displayName + "\n");
}

function pad(s, n) {
  s = s ?? "";
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

async function cmdRead(query, opts) {
  const backendRequested =
    opts.backendSpecified || Boolean(process.env.DURE_BACKEND_PROFILE?.trim());
  let readScreen;
  let readLabel;
  if (backendRequested) {
    const sessionId = query;
    if (!sessionId || !opts.workspace) {
      fail(
        "Usage: dure read <session-id> --workspace <workspace-id> --backend <id> [-f] [-n N]",
      );
    }
    const { collectSessionRead, formatSessionRead, sessionReadExitCode } =
      await import("./lib/session-read.mjs");
    const backend = await backendProfileQueryContext(opts);
    readLabel = sessionId;
    readScreen = async (signal) => {
      const report = await collectSessionRead({
        backend,
        deadlineMs:
          opts.deadlineMs === undefined ? undefined : Number(opts.deadlineMs),
        lines: Math.min(512, Math.max(1, opts.lines || 20)),
        sessionId,
        signal,
        workspaceId: opts.workspace,
      });
      if (sessionReadExitCode(report) !== 0) {
        throw new SessionCaptureError("failed", formatSessionRead(report));
      }
      return formatSessionRead(report);
    };
  } else {
    const reg = loadRegistryOptional() ?? { agents: [] };
    const target = resolveReadTarget(reg, query);
    readLabel = target;
    readScreen = (signal) => capture(reg, target, opts.lines, signal, opts);
  }
  const interruption = captureInterruption();
  if (!opts.follow) {
    try {
      const out = await readScreen(interruption.signal);
      process.stdout.write(out);
      if (!out.endsWith("\n")) process.stdout.write("\n");
    } catch (error) {
      if (error?.kind === "aborted") {
        process.exitCode = 130;
        return;
      }
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      interruption.dispose();
    }
    return;
  }
  // --follow: 주기적으로 캡처해 화면이 바뀌면 다시 그림
  let prev = "";
  let reportedDelay = false;
  try {
    while (!interruption.interrupted()) {
      let out;
      try {
        out = await readScreen(interruption.signal);
        reportedDelay = false;
      } catch (error) {
        if (error?.kind === "aborted") break;
        if (error?.kind === "timeout") {
          if (!reportedDelay) {
            process.stderr.write(
              `\x1b[90m[${error.message}; retrying]\x1b[0m\n`,
            );
            reportedDelay = true;
          }
          await delay(700, interruption.signal);
          continue;
        }
        process.stdout.write("\n\x1b[90m[session ended]\x1b[0m\n");
        return;
      }
      if (out !== prev) {
        prev = out;
        process.stdout.write("\x1b[2J\x1b[H"); // clear
        const label =
          typeof readLabel === "string"
            ? readLabel
            : `${readLabel.name} · ${readLabel.project}`;
        process.stdout.write(
          `\x1b[90m─ ${label} (follow, Ctrl-C to stop) ─\x1b[0m\n`,
        );
        process.stdout.write(out);
      }
      await delay(700, interruption.signal);
    }
  } finally {
    interruption.dispose();
  }
  if (interruption.interrupted()) process.stdout.write("\n");
}

function matchingTranscriptAgents(reg, query) {
  const matches = matchingAgents(reg, query);
  for (const agent of Array.isArray(reg?.agents) ? reg.agents : []) {
    if (agent?.id === query && !matches.includes(agent)) matches.push(agent);
  }
  return matches;
}

async function writeNativeTranscript(agent, opts) {
  if (opts.backendSpecified) {
    fail("--backend does not apply to a local native CLI transcript.");
  }
  const {
    agentTranscriptFromProvider,
    formatAgentTranscript,
    nativeAgentTranscriptSource,
  } = await import("./lib/agent-transcript.mjs");
  const source = nativeAgentTranscriptSource(agent);
  if (source.kind === "unsupported") {
    fail(
      `Native transcript export is not supported for provider '${agent.provider}'.`,
    );
  }
  if (source.kind === "remote") {
    fail("Native transcript export is not yet available for remote SSH Agents.");
  }
  if (source.kind === "identity_unavailable") {
    fail(
      "The Agent has no exact provider conversation ID yet. Wait for the conversation identity to be observed and try again.",
    );
  }
  const descriptor = loadServer();
  if (
    !Array.isArray(descriptor?.capabilities) ||
    !descriptor.capabilities.includes(PROVIDER_TRANSCRIPT_APP_CAPABILITY)
  ) {
    fail(
      "The running Dure app cannot export native transcripts. Restart it on a build that supports provider_transcript.read_v1.",
    );
  }
  try {
    const response = await requestAppControlRequest({
      descriptor,
      path: "/transcript",
      body: {
        provider: source.provider,
        conversationId: source.conversationId,
      },
      maxResponseBytes: PROVIDER_TRANSCRIPT_RESPONSE_BYTES,
    });
    const transcript = agentTranscriptFromProvider({
      source,
      entryLimit: opts.all ? null : opts.lines || 20,
      transcript: response.transcript,
    });
    process.stdout.write(formatAgentTranscript(transcript, { json: opts.json }));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function cmdTranscript(query, opts) {
  if (
    !query ||
    opts.rest.length !== 1 ||
    opts.follow ||
    (opts.all && opts.linesSpecified) ||
    (opts.linesSpecified && (!Number.isSafeInteger(opts.lines) || opts.lines < 1))
  ) {
    fail(
      "Usage: dure transcript <agent-or-id> [-n N | --all] [--backend ID] [--json]",
    );
  }
  const registry = loadRegistryOptional() ?? { agents: [] };
  const matches = matchingTranscriptAgents(registry, query);
  if (matches.length > 1) {
    fail(
      `'${query}' matches multiple Agents; use project/name or an Agent ID:\n` +
        matches
          .map(
            (agent) =>
              `  ${agent.project}/${agentDisplayName(agent)} (${agent.id})`,
          )
          .join("\n"),
    );
  }
  const agent = matches[0];
  const profile =
    agent?.interactionProfile?.kind === "structured_protocol"
      ? agent.interactionProfile
      : undefined;
  if (agent && !profile) {
    await writeNativeTranscript(agent, opts);
    return;
  }
  if (
    profile &&
    opts.backendSpecified &&
    opts.backend !== profile.backendProfileId
  ) {
    fail(
      `This Agent belongs to backend profile '${profile.backendProfileId}', not '${opts.backend}'.`,
    );
  }
  const backend = await backendProfileQueryContext(
    profile
      ? {
          ...opts,
          backendSpecified: true,
          backend: profile.backendProfileId,
        }
      : opts,
  );
  const interruption = captureInterruption();
  try {
    const {
      collectBackendAgentTranscript,
      formatBackendAgentTranscript,
    } = await import("./lib/agent-transcript-command.mjs");
    const transcript = await collectBackendAgentTranscript({
      agentId: agent?.id ?? query,
      backend,
      deadlineMs:
        opts.deadlineMs === undefined ? undefined : Number(opts.deadlineMs),
      entryLimit: opts.all ? null : opts.lines || 20,
      expectedInteractionSessionId: profile?.interactionSessionId,
      signal: interruption.signal,
    });
    process.stdout.write(
      formatBackendAgentTranscript(transcript, { json: opts.json }),
    );
  } catch (error) {
    if (interruption.interrupted()) {
      process.exitCode = 130;
      return;
    }
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    interruption.dispose();
  }
}

async function cmdLogs(reg, agent, lines) {
  const interruption = captureInterruption();
  try {
    const out = await capture(reg, agent, lines, interruption.signal);
    process.stdout.write(out);
  } catch (error) {
    if (error?.kind === "aborted") {
      process.exitCode = 130;
      return;
    }
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    interruption.dispose();
  }
}

function loadServer() {
  return loadAppControlDescriptor(APP_CONTROL_DIR);
}

async function requestAppControl(path, body = {}) {
  try {
    return await requestAppControlRequest({
      descriptor: loadServer(),
      path,
      body,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function cmdClient(args) {
  const request = clientPresentationRequestedCommand(args);
  const json = clientPresentationJsonRequested(args);
  try {
    const report = await runClientPresentationCommand(args, {
      descriptor: loadServer(),
      directory: APP_CONTROL_DIR,
    });
    if (report.help) {
      process.stdout.write(`${CLIENT_PRESENTATION_HELP}\n`);
      return;
    }
    process.stdout.write(
      json
        ? `${JSON.stringify(report)}\n`
        : `${formatClientPresentationReceipt(report)}\n`,
    );
    process.exitCode = clientPresentationExitCode(report);
  } catch (error) {
    const report = clientPresentationErrorReport(error, request);
    if (json) process.stderr.write(`${JSON.stringify(report)}\n`);
    else {
      process.stderr.write(
        `\x1b[31m${report.error.code}: ${report.error.message}\x1b[0m\n`,
      );
      if (report.error.nextAction) {
        process.stderr.write(`  → ${report.error.nextAction}\n`);
      }
    }
    process.exitCode = 2;
  }
}

function sessionQueryClientId() {
  const configured = process.env.DURE_CLIENT_ID?.trim();
  if (
    configured &&
    !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/.test(configured)
  ) {
    fail("DURE_CLIENT_ID has an invalid format.");
  }
  return configured ? `client:${configured}` : `app-channel:${APP_CHANNEL}`;
}

async function backendProfileQueryContext(opts) {
  try {
    const { selectBackendProfileForRequest } = await import(
      "./lib/local-backend.mjs"
    );
    const { resolveBackendSshReferencesFromEnvironment } = await import(
      "./lib/backend-ssh-references.mjs"
    );
    const selection = await selectBackendProfileForRequest({
      cliScriptPath: CLI_SCRIPT_PATH,
      explicitId: opts.backendSpecified ? opts.backend : undefined,
    });
    return {
      profile: selection.profile,
      transportOptions: {
        resolveSshReferences: (references) =>
          resolveBackendSshReferencesFromEnvironment(references),
      },
    };
  } catch (error) {
    return { error };
  }
}

async function sessionQueryContext(opts, loadSessionClientProjection) {
  const registry = loadSessionClientProjection({
    registryPath: REG,
    clientId: sessionQueryClientId(),
  });
  const backendRequested =
    opts.backendSpecified || Boolean(process.env.DURE_BACKEND_PROFILE?.trim());
  return {
    registry,
    backend: backendRequested ? await backendProfileQueryContext(opts) : null,
  };
}

async function emitSessionQuery(action, sessionId, opts) {
  const {
    collectSessionQuery,
    formatSessionQuery,
    loadSessionClientProjection,
    sessionQueryExitCode,
  } = await import("./lib/session-query.mjs");
  const { registry, backend } = await sessionQueryContext(
    opts,
    loadSessionClientProjection,
  );
  const report = await collectSessionQuery({
    action,
    hmuxCommand: hmuxCommand(),
    sessionId,
    workspaceId: opts.workspace,
    registry,
    deadlineMs:
      opts.deadlineMs === undefined ? undefined : Number(opts.deadlineMs),
    probeBudgetMs:
      opts.probeBudgetMs === undefined ? undefined : Number(opts.probeBudgetMs),
    backend,
  });
  process.stdout.write(
    (opts.json ? JSON.stringify(report) : formatSessionQuery(report)) + "\n",
  );
  process.exitCode = sessionQueryExitCode(report);
}

async function cmdLs(opts) {
  if (opts.rest.length !== 0 || opts.workspace !== undefined) {
    fail(
      "Usage: dure ls [--backend ID] [--json] [--deadline-ms N] [--probe-budget-ms N]",
    );
  }
  return emitSessionQuery("list", undefined, opts);
}

async function cmdSessions(sub, opts) {
  if (sub === undefined || sub === "recent") {
    if (opts.rest.length !== (sub === undefined ? 0 : 1)) {
      fail("Usage: dure sessions recent [--json]");
    }
    const payload = await requestAppControl("/sessions/recent");
    const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(sessions)}\n`);
      return;
    }
    for (const session of sessions) {
      process.stdout.write(
        `${session.provider}\t${session.id}\t${session.cwd}\t${session.title}\n`,
      );
    }
    return;
  }
  const action = sub;
  const sessionId = opts.rest[1];
  if (
    !["list", "show"].includes(action) ||
    (action === "list" && (opts.rest.length !== 1 || opts.workspace !== undefined)) ||
    (action === "show" && (opts.rest.length !== 2 || !sessionId))
  ) {
    fail(
      "Usage: dure sessions list [--backend ID] [--json] [--deadline-ms N] [--probe-budget-ms N]\n" +
        "        dure sessions show <session-id> [--backend ID] [--workspace ID] [--json]",
    );
  }
  return emitSessionQuery(action, sessionId, opts);
}

async function cmdProjects(sub, opts) {
  const action = sub;
  const projectId = opts.rest[1];
  const registering = action === "register";
  if (
    !["list", "register", "show"].includes(action) ||
    (action === "list" && opts.rest.length !== 1) ||
    (["register", "show"].includes(action) &&
      (opts.rest.length !== 2 || !projectId)) ||
    (registering &&
      ((opts.pathSpecified && !opts.path) ||
        (opts.nameSpecified && !opts.name))) ||
    (!registering && (opts.pathSpecified || opts.nameSpecified))
  ) {
    fail(
      "Usage: dure projects list [--backend ID] [--json] [--deadline-ms N]\n" +
        "        dure projects show <project-id> [--backend ID] [--json]\n" +
        "        dure projects register <project-id> [--path PATH] [--name NAME] [--backend ID] [--json]",
    );
  }
  const {
    collectProjectCommand,
    formatProjectCommand,
    projectCommandExitCode,
  } = await import("./lib/project-client.mjs");
  const backend = await backendProfileQueryContext(opts);
  const report = await collectProjectCommand({
    action,
    projectId,
    projectPath: registering
      ? backendProjectPathSelector(opts, backend, true)
      : undefined,
    displayName: registering ? opts.name || projectId : undefined,
    backend,
    deadlineMs:
      opts.deadlineMs === undefined ? undefined : Number(opts.deadlineMs),
  });
  process.stdout.write(
    (opts.json ? JSON.stringify(report) : formatProjectCommand(report)) + "\n",
  );
  process.exitCode = projectCommandExitCode(report);
}

async function cmdProviderLaunchDefaults(sub, opts) {
  const action = sub;
  const providerId = opts.rest[1];
  const permissionMode = opts.rest[2];
  if (
    !["get", "set"].includes(action) ||
    (action === "get" && opts.rest.length !== 1) ||
    (action === "set" &&
      (opts.rest.length !== 3 ||
        !providerId ||
        !["require_approvals", "bypass_approvals"].includes(
          permissionMode,
        )))
  ) {
    fail(
      "Usage: dure provider-defaults get [--backend ID] [--json]\n" +
        "        dure provider-defaults set <provider-id> require_approvals|bypass_approvals [--idempotency-key KEY] [--backend ID] [--json]",
    );
  }
  const {
    collectProviderLaunchDefaults,
    formatProviderLaunchDefaults,
    providerLaunchDefaultsExitCode,
  } = await import("./lib/provider-launch-defaults.mjs");
  const backend = await backendProfileQueryContext(opts);
  const report = await collectProviderLaunchDefaults({
    action,
    providerId,
    permissionMode,
    idempotencyKey:
      action === "set"
        ? opts.idempotencyKey ||
          `provider-defaults:${randomUUID().replaceAll("-", "")}`
        : undefined,
    backend,
  });
  process.stdout.write(
    `${opts.json ? JSON.stringify(report) : formatProviderLaunchDefaults(report)}\n`,
  );
  process.exitCode = providerLaunchDefaultsExitCode(report);
}

async function cmdAgentSpawn(sub, opts) {
  const action = sub;
  const operationId = opts.operationId;
  const idempotencyKey = opts.idempotencyKey;
  const dedicatedWorktree =
    !opts.worktreeSpecified && opts.baseCommit && opts.branch
      ? {
          kind: "dedicated",
          base_commit_sha: opts.baseCommit,
          branch: opts.branch,
        }
      : opts.worktree === false
        ? { kind: "project_root" }
        : null;
  const invalidPreview =
    action === "preview" &&
    ((Boolean(opts.project) ? 1 : 0) + (opts.pathSpecified ? 1 : 0) !== 1 ||
      (opts.pathSpecified && !opts.path) ||
      !opts.provider ||
      !opts.name ||
      !idempotencyKey ||
      !dedicatedWorktree ||
      (opts.setupCommand !== undefined &&
        (!opts.setupCommand || dedicatedWorktree?.kind !== "dedicated")) ||
      (opts.skipPermissions === true && opts.permissionOverride !== undefined) ||
      (opts.permissionOverride !== undefined &&
        !["require_approvals", "auto_edit", "bypass_approvals"].includes(
          opts.permissionOverride,
        )) ||
      operationId !== undefined ||
      (opts.worktree === false &&
        (opts.baseCommit !== undefined || opts.branch !== undefined)));
  const invalidStatus =
    action === "status" &&
    (((operationId === undefined) === (idempotencyKey === undefined)) ||
      opts.project !== "" ||
      opts.pathSpecified === true ||
      opts.provider !== undefined ||
      opts.name !== "" ||
      opts.prompt !== "" ||
      opts.worktreeSpecified === true ||
      opts.baseCommit !== undefined ||
      opts.branch !== undefined ||
      opts.setupCommand !== undefined ||
      opts.skipPermissions === true ||
      opts.permissionOverride !== undefined);
  const invalidApply =
    action === "apply" &&
    (!operationId ||
      !opts.planToken ||
      !opts.expectedSequence ||
      idempotencyKey !== undefined ||
      opts.project !== "" ||
      opts.pathSpecified === true ||
      opts.provider !== undefined ||
      opts.name !== "" ||
      opts.worktreeSpecified === true ||
      opts.baseCommit !== undefined ||
      opts.branch !== undefined ||
      opts.setupCommand !== undefined ||
      opts.skipPermissions === true ||
      opts.permissionOverride !== undefined);
  if (
    !["preview", "apply", "status"].includes(action) ||
    opts.rest.length !== 1 ||
    invalidPreview ||
    invalidApply ||
    invalidStatus
  ) {
    fail(
      "Usage: dure spawn preview (--project ID | --path PATH) --provider ID --name NAME --idempotency-key KEY " +
        "(--no-worktree | --base-commit SHA --branch REF) [--setup-command COMMAND] [--prompt TEXT] [--permission-override require_approvals|auto_edit|bypass_approvals] [--skip-permissions] [--backend ID] [--json]\n" +
        "        dure spawn apply --operation-id ID --plan-token TOKEN --expected-sequence N [--prompt TEXT] [--backend ID] [--json]\n" +
        "        dure spawn status (--operation-id ID | --idempotency-key KEY) [--backend ID] [--json]",
    );
  }
  const {
    agentSpawnQueryExitCode,
    collectAgentSpawnQuery,
    formatAgentSpawnQuery,
  } = await import("./lib/agent-spawn-query.mjs");
  const backend = await backendProfileQueryContext(opts);
  const report = await collectAgentSpawnQuery({
    action,
    projectId: opts.project || undefined,
    projectPath: backendProjectPathSelector(opts, backend),
    providerId: opts.provider,
    agentName: opts.name,
    worktree: dedicatedWorktree,
    permissionOverride: opts.skipPermissions
      ? "bypass_approvals"
      : opts.permissionOverride,
    setupCommand: opts.setupCommand,
    prompt: opts.prompt || undefined,
    operationId,
    planToken: opts.planToken,
    expectedLastSequence:
      opts.expectedSequence === undefined
        ? undefined
        : Number(opts.expectedSequence),
    idempotencyKey,
    backend,
    deadlineMs:
      opts.deadlineMs === undefined ? undefined : Number(opts.deadlineMs),
  });
  writeAgentSpawnReport(report, opts, {
    agentSpawnQueryExitCode,
    formatAgentSpawnQuery,
  });
}

function backendProjectPathSelector(opts, backend, defaultToCwd = false) {
  if (!opts.pathSpecified && !defaultToCwd) return undefined;
  const path = opts.pathSpecified ? opts.path : process.cwd();
  return backend.profile?.transport.kind === "ssh" ? path : resolvePath(path);
}

function writeAgentSpawnReport(report, opts, formatters) {
  process.stdout.write(
    (opts.json
      ? JSON.stringify(report)
      : formatters.formatAgentSpawnQuery(report)) + "\n",
  );
  process.exitCode = formatters.agentSpawnQueryExitCode(report);
}

const RUN_HELP = `dure run — backend-owned Run + optional connected-client pane

Usage:
  dure run [--project ID | --path PATH] [--provider ID] [--name NAME]
           [--worktree NAME [--base-commit SHA] [--branch REF]]
           [--setup-command COMMAND]
           [--permission-override require_approvals|auto_edit|bypass_approvals]
           [--skip-permissions]
           [--space ID|NAME] [--idempotency-key KEY] [--backend ID] [--json] <prompt>
  dure spawn [run options] [prompt]
  dure spawn --reuse --project ID|NAME --name AGENT
             [--agent PROVIDER | --provider PROVIDER]
             [--prompt TEXT] [--window-label LABEL]
             [--idempotency-key KEY] [--json]

When --space is omitted inside an exact Hmux pane, the new pane opens in the same Space.
In a terminal or CI environment without a verified calling pane, the Run executes headlessly.
spawn --reuse reuses an existing Agent without creating a new provider.`;

function writeCliActionError(
  error,
  opts,
  apiVersion,
  kind,
  fallbackCode = "client_action_failed",
) {
  const code = typeof error?.code === "string" ? error.code : fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  if (opts.json) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        apiVersion,
        kind,
        error: { code, message },
      })}\n`,
    );
  } else {
    process.stderr.write(`\x1b[31m${code}: ${message}\x1b[0m\n`);
  }
  process.exitCode = 2;
}

async function cmdLegacySpawnReuse(opts, prompt, positionalPrompt, providerId) {
  if (
    !opts.project ||
    !opts.name ||
    (Boolean(opts.prompt) && Boolean(positionalPrompt)) ||
    (Boolean(opts.agent) && Boolean(opts.provider) && opts.agent !== opts.provider) ||
    opts.pathSpecified === true ||
    opts.worktreeSpecified === true ||
    opts.spaceSpecified === true ||
    opts.spaceId !== undefined ||
    opts.desktopId !== undefined ||
    opts.baseCommit !== undefined ||
    opts.branch !== undefined ||
    opts.operationId !== undefined ||
    opts.planToken !== undefined ||
    opts.expectedSequence !== undefined ||
    opts.skipPermissions === true ||
    opts.permissionOverride !== undefined ||
    opts.setupCommand !== undefined ||
    opts.backendSpecified === true
  ) {
    fail(RUN_HELP);
  }
  const idempotencyKey =
    opts.idempotencyKey ||
    `reuse-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!opts.idempotencyKey) {
    process.stderr.write(`Retry key: ${idempotencyKey}\n`);
  }
  const { formatAgentReuse, reuseExistingAgent } = await import(
    "./lib/agent-reuse.mjs"
  );
  let report;
  try {
    report = await reuseExistingAgent({
      descriptor: loadServer(),
      project: opts.project,
      provider: providerId,
      name: opts.name,
      prompt,
      idempotencyKey,
      windowLabel: opts.windowLabel,
    });
  } catch (error) {
    writeCliActionError(
      error,
      opts,
      "dure.agent-reuse/v1",
      "dure.agent.reuse.error",
      "agent_reuse_failed",
    );
    return;
  }
  process.stdout.write(
    `${opts.json ? JSON.stringify(report) : formatAgentReuse(report)}\n`,
  );
  process.exitCode = 0;
}

async function cmdRun(opts, { legacySpawn = false } = {}) {
  const positionalPrompt = opts.rest.join(" ");
  const prompt = legacySpawn ? opts.prompt || positionalPrompt : positionalPrompt;
  const runPrompt = prompt || undefined;
  const legacyOptionStyle =
    legacySpawn && (Boolean(opts.agent) || Boolean(opts.prompt));
  const requestedProviderId = legacySpawn
    ? opts.provider || opts.agent || undefined
    : opts.provider || undefined;
  if (legacySpawn && opts.reuse) {
    return cmdLegacySpawnReuse(
      opts,
      prompt,
      positionalPrompt,
      requestedProviderId,
    );
  }
  const providerId = requestedProviderId || "claude";
  if (
    (!legacySpawn && !prompt) ||
    (!legacySpawn && opts.reuse === true) ||
    (legacySpawn && Boolean(opts.prompt) && Boolean(positionalPrompt)) ||
    (legacySpawn &&
      Boolean(opts.agent) &&
      Boolean(opts.provider) &&
      opts.agent !== opts.provider) ||
    (!legacySpawn && (Boolean(opts.prompt) || Boolean(opts.agent))) ||
    (opts.projectSpecified && !opts.project) ||
    (opts.pathSpecified && !opts.path) ||
    (opts.projectSpecified && opts.pathSpecified) ||
    (opts.spaceSpecified && !opts.space) ||
    (opts.worktreeSpecified && opts.worktree !== false && !opts.worktree) ||
    (typeof opts.worktree === "string" &&
      !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(opts.worktree)) ||
    ((opts.baseCommit !== undefined || opts.branch !== undefined) &&
      typeof opts.worktree !== "string") ||
    (opts.setupCommand !== undefined &&
      (!opts.setupCommand || typeof opts.worktree !== "string")) ||
    (opts.baseCommit !== undefined && !opts.baseCommit) ||
    (opts.branch !== undefined && !opts.branch) ||
    opts.spaceId !== undefined ||
    opts.desktopId !== undefined ||
    opts.windowLabel !== undefined ||
    opts.operationId !== undefined ||
    opts.planToken !== undefined ||
    opts.expectedSequence !== undefined ||
    (opts.skipPermissions === true && opts.permissionOverride !== undefined) ||
    (opts.permissionOverride !== undefined &&
      !["require_approvals", "auto_edit", "bypass_approvals"].includes(
        opts.permissionOverride,
      ))
  ) {
    fail(RUN_HELP);
  }
  const {
    failedRunPresentation,
    formatRunPresentation,
    hasPresentableAgentRuntime,
    presentAgentRunRuntime,
    resolveRunPresentationTarget,
  } = await import("./lib/run-presentation.mjs");
  const { loadSessionClientProjection } = await import(
    "./lib/session-query.mjs"
  );
  let presentationTarget;
  try {
    presentationTarget = resolveRunPresentationTarget({
      spaceSelector: opts.spaceSpecified ? opts.space : undefined,
      environment: process.env,
      registry: loadSessionClientProjection({
        registryPath: REG,
        clientId: sessionQueryClientId(),
      }),
    });
  } catch (error) {
    writeCliActionError(
      error,
      opts,
      "dure.run-presentation/v1",
      "dure.run.error",
      "client_presentation_failed",
    );
    return;
  }
  const idempotencyKey =
    opts.idempotencyKey ||
    `run-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!opts.idempotencyKey) {
    process.stderr.write(`Retry key: ${idempotencyKey}\n`);
  }
  const {
    agentRunExitCode,
    collectAgentRun,
    defaultAgentRunName,
    formatAgentRun,
    resolveAgentRunInteractionPreference,
  } = await import("./lib/agent-run.mjs");
  const backend = await backendProfileQueryContext(opts);
  const explicitWorktreeName =
    typeof opts.worktree === "string" ? opts.worktree : undefined;
  const agentName =
    opts.name ||
    explicitWorktreeName ||
    defaultAgentRunName(providerId, idempotencyKey);
  const worktreeName =
    explicitWorktreeName
      ? explicitWorktreeName
      : legacyOptionStyle && opts.worktree !== false
        ? agentName
        : undefined;
  const worktree = worktreeName
    ? {
        kind: "dedicated",
        ...(opts.baseCommit !== undefined
          ? { base_commit_sha: opts.baseCommit }
          : {}),
        branch: opts.branch ?? `agent/${worktreeName}`,
      }
    : { kind: "project_root" };
  const projectPath = opts.projectSpecified
    ? undefined
    : backendProjectPathSelector(opts, backend, true);
  const deadlineMs =
    opts.deadlineMs === undefined ? undefined : Number(opts.deadlineMs);
  let interactionPreference;
  try {
    interactionPreference = await resolveAgentRunInteractionPreference(
      presentationTarget.state === "requested" ? loadServer() : undefined,
    );
  } catch (error) {
    writeCliActionError(
      error,
      opts,
      "dure.run-presentation/v1",
      "dure.run.error",
      "client_preference_failed",
    );
    return;
  }
  const { report, presentationProject } = await collectAgentRun({
    projectId: opts.project || undefined,
    projectPath,
    providerId,
    agentName,
    prompt: runPrompt,
    idempotencyKey,
    worktree,
    permissionOverride: opts.skipPermissions
      ? "bypass_approvals"
      : opts.permissionOverride,
    setupCommand: opts.setupCommand,
    includePresentationProject: presentationTarget.state === "requested",
    interactionPreference,
    backend,
    deadlineMs,
  });
  const runExitCode = agentRunExitCode(report);
  if (runExitCode !== 0 && !hasPresentableAgentRuntime(report)) {
    writeAgentSpawnReport(report, opts, {
      agentSpawnQueryExitCode: agentRunExitCode,
      formatAgentSpawnQuery: formatAgentRun,
    });
    return;
  }
  let presentation;
  try {
    presentation = await presentAgentRunRuntime({
      report,
      target: presentationTarget,
      profile: backend.profile,
      projectPath: presentationProject?.root ?? projectPath,
      descriptor: loadServer(),
    });
  } catch (error) {
    presentation = failedRunPresentation(
      error,
      presentationTarget.state === "requested",
    );
  }
  const output = { ...report, presentation };
  process.stdout.write(
    opts.json
      ? `${JSON.stringify(output)}\n`
      : `${formatAgentRun(report)}\n${formatRunPresentation(presentation)}\n`,
  );
  process.exitCode = presentation.state === "failed" ? 2 : runExitCode;
}

async function cmdWorkflow(sub, opts) {
  if (
    !["done", "show"].includes(sub) ||
    opts.rest.length !== 1 ||
    !opts.task ||
    !opts.dispatch ||
    !opts.generation ||
    (sub === "done" && opts.backendSpecified) ||
    (sub === "show" && opts.result !== undefined)
  ) {
    fail(WORKFLOW_HELP);
  }
  let profile;
  try {
    const { selectBackendProfileForRequest } = await import(
      "./lib/local-backend.mjs"
    );
    const { resolveBackendSshReferencesFromEnvironment } = await import(
      "./lib/backend-ssh-references.mjs"
    );
    const {
      completeDelegatedWorkflow,
      currentHmuxSessionGeneration,
      formatWorkflowCompletion,
      formatWorkflowReceipt,
      readDelegatedWorkflow,
    } = await import("./lib/workflow-completion.mjs");
    if (sub === "done") currentHmuxSessionGeneration(process.env);
    const selection = await selectBackendProfileForRequest({
      cliScriptPath: CLI_SCRIPT_PATH,
      environment: process.env,
      explicitId: opts.backendSpecified ? opts.backend : undefined,
    });
    profile = selection.profile;
    const report =
      sub === "done"
        ? await completeDelegatedWorkflow({
            taskId: opts.task,
            dispatchId: opts.dispatch,
            generation: opts.generation,
            result: opts.result,
            environment: process.env,
            backend: selection,
          })
        : await readDelegatedWorkflow({
            taskId: opts.task,
            dispatchId: opts.dispatch,
            generation: opts.generation,
            backend: {
              profile: selection.profile,
              transportOptions: {
                resolveSshReferences: (references) =>
                  resolveBackendSshReferencesFromEnvironment(references),
              },
            },
          });
    process.stdout.write(
      `${
        opts.json
          ? JSON.stringify(report)
          : sub === "done"
            ? formatWorkflowCompletion(report)
            : formatWorkflowReceipt(report)
      }\n`,
    );
  } catch (error) {
    const { LocalBackendError, localBackendErrorReport } = await import(
      "./lib/local-backend.mjs"
    );
    const { workflowCompletionErrorReport } = await import(
      "./lib/workflow-completion.mjs"
    );
    const report =
      error instanceof LocalBackendError
        ? localBackendErrorReport(error)
        : workflowCompletionErrorReport(error, profile);
    process.stderr.write(
      opts.json
        ? `${JSON.stringify(report)}\n`
        : `\x1b[31m${report.error.code}: ${report.error.message}\x1b[0m\n`,
    );
    process.exitCode = 2;
  }
}

async function cmdSpaces(sub, opts) {
  const action = sub;
  const spaceId = opts.rest[1];
  if (
    !["list", "show"].includes(action) ||
    (action === "list" && opts.rest.length !== 1) ||
    (action === "show" && (opts.rest.length !== 2 || !spaceId))
  ) {
    fail(
      "Usage: dure spaces list [--backend ID] [--json] [--deadline-ms N] [--probe-budget-ms N]\n" +
        "        dure spaces show <id-or-name> [--backend ID] [--json]",
    );
  }
  const { loadSessionClientProjection } = await import(
    "./lib/session-query.mjs"
  );
  const {
    collectSpaceQuery,
    formatSpaceQuery,
    spaceQueryExitCode,
  } = await import("./lib/space-query.mjs");
  const { registry, backend } = await sessionQueryContext(
    opts,
    loadSessionClientProjection,
  );
  const report = await collectSpaceQuery({
    action,
    spaceId,
    registry,
    sessionQuery: {
      hmuxCommand: hmuxCommand(),
      deadlineMs:
        opts.deadlineMs === undefined ? undefined : Number(opts.deadlineMs),
      probeBudgetMs:
        opts.probeBudgetMs === undefined
          ? undefined
          : Number(opts.probeBudgetMs),
      backend,
    },
  });
  process.stdout.write(
    (opts.json ? JSON.stringify(report) : formatSpaceQuery(report)) + "\n",
  );
  process.exitCode = spaceQueryExitCode(report);
}

async function confirmWorkspaceImport(opts) {
  if (opts.yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("workspace import apply requires --yes.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Create desktops and panes using the reviewed configuration? [y/N] ");
  rl.close();
  if (!/^y(es)?$/i.test(String(answer).trim())) fail("Workspace import was cancelled.");
}

async function cmdWorkspace(opts) {
  const [section, action] = opts.rest;
  if (section !== "import" || !["preview", "status", "apply"].includes(action)) {
    process.stdout.write(
      "dure workspace import preview [--json]\n" +
        "dure workspace import status [--json]\n" +
        "dure workspace import apply --plan-token TOKEN --yes [--json]\n",
    );
    return;
  }
  if (action === "preview") {
    const payload = await requestAppControl("/workspace/import/preview");
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(payload.preview)}\n`);
      return;
    }
    const preview = payload.preview;
    process.stdout.write(
      `${preview.desktopCount} desktop · ${preview.paneCount} pane\n` +
        `plan token: ${preview.planToken}\n` +
        `Apply: dure workspace import apply --plan-token ${preview.planToken} --yes\n`,
    );
    return;
  }
  if (action === "status") {
    const payload = await requestAppControl("/workspace/import/status");
    process.stdout.write(
      `${JSON.stringify(payload.status, null, opts.json ? 0 : 2)}\n`,
    );
    return;
  }
  const token = String(opts.planToken || "").trim();
  if (!token) fail("workspace import apply requires --plan-token.");
  await confirmWorkspaceImport(opts);
  const payload = await requestAppControl("/workspace/import/apply", {
    planToken: token,
    confirm: true,
  });
  process.stdout.write(
    `${JSON.stringify(payload.receipt, null, opts.json ? 0 : 2)}\n`,
  );
}

async function cmdHmux(sub, opts) {
  const action = sub === "migrate" ? "adopt" : sub;
  if (action === "rehost" && opts.rest[1] === "publish") {
    const { runManagedRehostPublication } = await import("./lib/managed-rehost-publication.mjs");
    return runManagedRehostPublication(opts, () => backendProfileQueryContext(opts));
  }
  if (action === "rehost" && opts.rest[1] === "status") {
    const { runManagedRehostStatus } = await import("./lib/managed-rehost-status.mjs");
    return runManagedRehostStatus(opts, hmuxCommand());
  }
  if (action === "rehost" && (opts.rest[1] === "start" || opts.rest[1] === "retry")) {
    const { runManagedRehostCommand } = await import("./lib/managed-rehost-command.mjs");
    return runManagedRehostCommand(opts, hmuxCommand());
  }
  if (action === "rehost") {
    const { isManagedRehostNameRequest, runManagedRehostPreview } = await import("./lib/managed-rehost-preview.mjs");
    if (isManagedRehostNameRequest(opts)) {
      if (opts.confirmRestart) {
        const { runManagedRehostNamed } = await import("./lib/managed-rehost-named.mjs");
        return runManagedRehostNamed(opts, REG, () => backendProfileQueryContext(opts), hmuxCommand());
      }
      return runManagedRehostPreview(opts, REG, () => backendProfileQueryContext(opts));
    }
    if (opts.backendSpecified || process.env.DURE_BACKEND_PROFILE?.trim()) {
      fail("rehost_backend_execution_unavailable: legacy named execution cannot use a selected backend. Use the saved exact start/status/publish commands; this request was not sent to the app.");
    }
  }
  if (
    action !== "attach" &&
    action !== "upgrade" &&
    action !== "adopt" &&
    action !== "rehost" &&
    action !== "convert" &&
    action !== "stop"
  ) {
    process.stdout.write(
      "dure hmux attach --name <exact-name> [--space-id ID] [--desktop-id ID (deprecated)] [--target-panel-id ID]\n" +
        "dure hmux upgrade --name <exact-name> --target-panel-id ID --confirm-restart\n" +
        "dure hmux adopt --name <project/agent> [--target-panel-id ID] --confirm-restart\n" +
        "dure hmux adopt --from-session <legacy-session> --target-panel-id ID --provider <claude|codex> --agent-name NAME --confirm-restart\n" +
        "dure hmux rehost --name <project/agent> [--backend ID] [--confirm-restart] [--json]  # local preview; confirmation starts native rehost and publishes its binding\n" +
        "dure hmux rehost --name <project/agent> [--target-panel-id ID] [--conversation-id ID | --fresh] [--permission-mode <default|skip_permissions>] [--existing-session ID | --operation-id ID] [--confirm-restart] [--json]  # legacy app-owned execution/recovery\n" +
        "dure hmux rehost status [<original-session-id> --workspace ID] --operation-id ID [--json]  # local, read-only; no app required\n" +
        "dure hmux rehost start <original-session-id> --workspace ID --operation-id ID --confirm-restart [--json]  # local, same conversation and settings\n" +
        "dure hmux rehost retry [<original-session-id> --workspace ID] --operation-id ID --confirm-restart [--json]  # resume an existing local operation\n" +
        "dure hmux rehost publish <agent-id> --from-session <original-session-id> --workspace ID --operation-id ID [--backend ID] [--json]  # publish completion; never restarts a provider\n" +
        "dure hmux convert --name <session> --target-panel-id ID --to <managed|standalone> [--agent-name NAME] [--confirm-restart]\n" +
        "dure hmux stop --name <project/agent> [--target-panel-id ID] [--yes]\n" +
        "dure hmux migrate ...  # adopt alias\n",
    );
    return;
  }
  const name = (opts.name || opts.rest[1] || "").trim();
  const sourceSessionId = (opts.fromSession || "").trim();
  if (!name && !(action === "adopt" && sourceSessionId)) {
    fail(`hmux ${action} requires --name <exact-name>.`);
  }
  if (
    action === "adopt" &&
    sourceSessionId &&
    (!opts.targetPanelId || !opts.provider)
  ) {
    fail(
      "Legacy terminal adoption requires --target-panel-id and --provider <claude|codex>.",
    );
  }
  if (action === "upgrade" && !opts.targetPanelId) {
    fail("hmux upgrade requires --target-panel-id <existing-pane-id>.");
  }
  if (action === "convert") {
    if (!opts.targetPanelId) {
      fail("hmux convert requires --target-panel-id <existing-pane-id>.");
    }
    if (opts.to !== "managed" && opts.to !== "standalone") {
      fail("hmux convert requires --to <managed|standalone>.");
    }
  }
  if (
    opts.permissionMode !== undefined &&
    opts.permissionMode !== "default" &&
    opts.permissionMode !== "skip_permissions"
  ) {
    fail("--permission-mode must be default or skip_permissions.");
  }
  const srv = loadServer();
  if (!srv) {
    fail(`The app server was not found. Hmux pane ${action} requires the Dure app to be running.`);
  }
  const body = { name };
  try {
    Object.assign(body, clientSpaceIdentityPayload(opts));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (opts.targetPanelId) body.targetPanelId = opts.targetPanelId;
  if (opts.conversationId) body.conversationId = opts.conversationId;
  if (opts.fresh) body.freshStart = true;
  if (opts.operationId) body.operationId = opts.operationId;
  if (opts.existingSessionId) body.existingSessionId = opts.existingSessionId;
  if (opts.permissionMode) body.permissionMode = opts.permissionMode;
  if (opts.windowLabel) body.windowLabel = opts.windowLabel;
  if (opts.cwd) body.cwd = opts.cwd;
  if (opts.to) body.to = opts.to;
  if (opts.agentName) body.agentName = opts.agentName;
  if (sourceSessionId) body.sourceSessionId = sourceSessionId;
  if (opts.provider) body.providerId = opts.provider;
  if (opts.confirmRestart) body.confirmRestart = true;

  // A3: stop은 파괴적 라우트 — 서버가 confirm 없이는 428로 거절한다.
  // 대화형이면 확인을 받고, 스크립트에서는 --yes 를 명시하게 한다.
  if (action === "stop") {
    if (!opts.yes) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        // Ctrl-D(close)는 question promise가 영원히 안 풀리고, Ctrl-C(SIGINT)는
        // 리스너가 없으면 readline이 삼킨다 — 둘 다 빈 답(=취소)으로 수렴시킨다.
        const answer = await new Promise((resolve) => {
          rl.on("close", () => resolve(""));
          rl.on("SIGINT", () => {
            rl.close();
            resolve("");
          });
          void rl
            .question(`Stop the provider for session '${name}'? [y/N] `)
            .then(resolve);
        });
        rl.close();
        if (!/^y(es)?$/i.test(String(answer).trim())) fail("Stopping was cancelled.");
      } else {
        fail("hmux stop is destructive. Non-interactive execution requires --yes.");
      }
    }
    body.confirm = true;
  }

  const res = await fetch(`http://127.0.0.1:${srv.port}/hmux/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${srv.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).catch((error) => fail(`App server request failed: ${error.message}`));
  const receipt = await res.json().catch(() => null);
  const permissionRelaunch = receipt?.permissionModeRelaunch;
  if (permissionRelaunch?.outcome === "preview") {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(permissionRelaunch)}\n`);
    } else {
      process.stdout.write(
        `preview: ${name} permission ${permissionRelaunch.currentMode} → ${permissionRelaunch.targetMode}` +
          ` · provider process restart\n` +
          "The exact conversation, worktree, Agent pane, and active Dispatch stay attached.\n" +
          "Add --confirm-restart to the same command to confirm.\n",
      );
    }
    return;
  }
  if (!res.ok || !receipt?.ok) {
    const conversationId =
      receipt?.adoption?.conversationId ??
      receipt?.rehost?.conversationId ??
      receipt?.conversion?.conversationId;
    const exactConversation = conversationId
      ? `\n  exact conversation: ${conversationId}`
      : "";
    fail(
      `${receipt?.error?.message || `Hmux ${action} was rejected (HTTP ${res.status})`}` +
        exactConversation,
    );
  }
  if (permissionRelaunch?.outcome === "relaunched") {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(permissionRelaunch)}\n`);
    } else {
      process.stdout.write(
        `\x1b[32m✓\x1b[0m ${name} permission ${permissionRelaunch.currentMode} → ${permissionRelaunch.targetMode}` +
          ` · provider restarted (${permissionRelaunch.sourceSessionId} → ${permissionRelaunch.targetSessionId})\n`,
      );
    }
    return;
  }
  if (action === "stop") {
    const agent = receipt.agent;
    if (receipt.cleanup) {
      process.stdout.write(
        `\x1b[32m✓\x1b[0m ${agent?.name || name} exited registration cleaned` +
          ` (${receipt.cleanup.sourceState || receipt.cleanup.reason}, ${receipt.cleanup.sessionId}, ${receipt.cleanup.workspaceId})\n`,
      );
      return;
    }
    const stop = receipt.stop;
    process.stdout.write(
      `\x1b[32m✓\x1b[0m ${agent?.name || name} provider stopped` +
        ` (${stop.outcome}, ${stop.sessionId}, ${stop.workspaceId})\n`,
    );
    return;
  }
  if (action === "convert" && receipt.preview === true) {
    const conversion = receipt.conversion;
    process.stdout.write(
      `preview: ${name} → ${conversion.targetClass}` +
        ` · conversation ${conversion.conversationId}` +
        `\nAdd --confirm-restart to the same command to confirm the restart transition.\n`,
    );
    return;
  }
  const pane = receipt.pane;
  const operation =
    receipt.upgrade ?? receipt.adoption ?? receipt.rehost ?? receipt.conversion;
  const outcome = operation ? ` · ${operation.outcome}` : "";
  const conversationId =
    receipt.adoption?.conversationId ??
    receipt.rehost?.conversationId ??
    receipt.conversion?.conversationId;
  const conversation = conversationId
    ? ` · conversation ${conversationId}`
    : "";
  if (!pane && operation?.presentation === "pending") {
    const replacement = operation.replacementSession;
    const replacementIdentity = replacement?.sessionId
      ? ` (${replacement.sessionId}${replacement.workspaceId ? `, ${replacement.workspaceId}` : ""})`
      : "";
    process.stdout.write(
      `\x1b[32m✓\x1b[0m ${name || sourceSessionId} runtime rehost committed${replacementIdentity}` +
        ` · pane projection pending${outcome}${conversation}\n`,
    );
    return;
  }
  if (!pane) fail(`The Hmux ${action} response is missing its pane projection.`);
  process.stdout.write(
    `\x1b[32m✓\x1b[0m ${name || sourceSessionId} → ${pane.spaceId || pane.desktopId}/${pane.panelId}` +
      ` (${pane.sessionId}, ${pane.workspaceId})${outcome}${conversation}\n`,
  );
}

async function cmdPerf(sub, opts) {
  try {
    const output = await runPerformanceCommand(sub, opts, loadServer());
    process.stdout.write(`${output}\n`);
  } catch (error) {
    fail(error.message);
  }
}

async function cmdAttach(opts) {
  if (opts.rest.length !== 1 || !opts.rest[0] || !opts.workspace) {
    process.stderr.write(
      "\x1b[31mdure_attach_argument_invalid: usage: dure attach <session-id> --workspace <workspace-id> [--backend ID]\x1b[0m\n",
    );
    process.exitCode = 2;
    return;
  }
  const { attachManagedSession, formatSessionAttachError } = await import(
    "./lib/session-attach.mjs"
  );
  const backendRequested =
    opts.backendSpecified || Boolean(process.env.DURE_BACKEND_PROFILE?.trim());
  const backend = backendRequested
    ? await backendProfileQueryContext(opts)
    : null;
  try {
    await attachManagedSession({
      backend,
      hmuxCommand: hmuxCommand(),
      sessionId: opts.rest[0],
      workspaceId: opts.workspace,
    });
  } catch (error) {
    process.stderr.write(`\x1b[31m${formatSessionAttachError(error)}\x1b[0m\n`);
    process.exitCode = 2;
  }
}

// ---------- durable orchestration client ----------

function nowMs() {
  return Date.now();
}

const ORCH_HELP = `dure orchestration — durable interaction service client

  orchestration events-canary --session-file PATH [--backend ID] [--json]
      Observe existing event delivery state without enrolling or acknowledging.
  orchestration invoke <method> <body-json> [--backend ID] [--json]
      Call the versioned orchestration API through the selected local/SSH backend.
      DURE_ORCHESTRATION_ENDPOINT selects a hosted HTTPS authority instead.
  orchestration status [--json] [--repo PATH] [--backend ID]
  orchestration health [--json] [--repo PATH] [--backend ID]

Legacy file-mailbox commands (send/inbox/check/ask/task/gate/reset/dispatch)
are retired. They never read or write ~/.dure/orchestration.json.`;

function cmdOrch(sub) {
  if (sub === undefined || sub === "help" || sub === "-h" || sub === "--help") {
    process.stdout.write(`${ORCH_HELP}\n`);
    return;
  }
  fail(
    `orchestration subcommand '${sub}' was retired with the file mailbox.\n` +
      "Use 'dure orchestration invoke' or the shared MCP client; terminal input is not an orchestration transport.",
  );
}

async function cmdSchedule(sub, opts) {
  const { runScheduleCli } = await import("./lib/schedule-cli.mjs");
  await runScheduleCli(sub, opts, { backendProfileQueryContext, backendProjectPathSelector, fail });
}

// ---------- hooks (Claude Code SessionStart 훅 등록/해제) ----------
// beads(bd prime)와 같은 메커니즘: settings.json의 SessionStart에
// `dure checkpoint --hook-json`을 등록해, Dure pane 안에서 뜨는 에이전트가
// 체크포인트 규율(현재 값 + 갱신 방법)을 세션 시작에 주입받게 한다.
// 훅 커맨드 자체가 pane 밖에서는 침묵하므로 전역 등록이 안전하다.
// 편집은 additive: 다른 훅(bd prime 등)은 절대 건드리지 않고, 제거는
// 정확히 이 커맨드 항목만 걷어낸다(설치/삭제 대칭).

const DURE_HOOK_COMMAND = "dure checkpoint --hook-json";

/** provider별 훅 파일 어댑터 — 실물로 검증된 형식만 담는다:
 *  claude(~/.claude/settings.json)와 codex 0.129+(~/.codex/hooks.json,
 *  matcher "startup|resume|clear", 출력 계약은 Claude와 동일 JSON — bd
 *  codex-hook 실물로 확인). gemini 등은 컨텍스트 주입 계약이 검증되는
 *  대로 항목 추가로 끝난다. 편집은 additive — 타 도구 훅 불가침. */
const HOOK_PROVIDERS = [
  {
    id: "claude",
    label: "Claude Code",
    directory: ".claude",
    file: "settings.json",
    entry: {
      matcher: "",
      hooks: [{ type: "command", command: DURE_HOOK_COMMAND }],
    },
  },
  {
    id: "codex",
    label: "Codex",
    directory: ".codex",
    file: "hooks.json",
    entry: {
      matcher: "startup|resume|clear",
      hooks: [{ type: "command", command: DURE_HOOK_COMMAND }],
    },
  },
  {
    // Gemini CLI: 같은 중첩 스키마의 hooks.SessionStart. additionalContext
    // 주입은 공식 훅 레퍼런스 + gemini-cli#15413(PR #15746로 수정)으로
    // 확인. 파일이 훅 전용이 아니라 일반 settings.json이므로 additive
    // 편집이 특히 중요하다(theme·계정 설정과 동거).
    id: "gemini",
    label: "Gemini",
    directory: ".gemini",
    file: "settings.json",
    entry: {
      hooks: [{ type: "command", command: DURE_HOOK_COMMAND }],
    },
  },
];

/** claude는 이 앱의 1차 provider라 항상 대상. 그 외는 해당 CLI의 설정
 *  디렉터리가 있을 때만 — 없는 도구의 설정 트리를 만들어주지 않는다. */
function providerPresent(provider, opts) {
  if (provider.id === "claude") return true;
  const base = opts.global ? homedir() : process.cwd();
  return existsSync(join(base, provider.directory));
}

function providerHookPath(provider, opts) {
  const base = opts.global ? homedir() : process.cwd();
  return join(base, provider.directory, provider.file);
}

function readHookSettings(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${path} is not valid JSON and will not be modified.`);
  }
}

function dureHookRegistered(settings) {
  const groups = settings?.hooks?.SessionStart;
  if (!Array.isArray(groups)) return false;
  return groups.some((group) =>
    (group?.hooks ?? []).some((hook) => hook?.command === DURE_HOOK_COMMAND),
  );
}

function installProviderHook(provider, opts) {
  const target = providerHookPath(provider, opts);
  const settings = readHookSettings(target);
  if (dureHookRegistered(settings)) return { changed: false, target };
  settings.hooks = settings.hooks ?? {};
  settings.hooks.SessionStart = settings.hooks.SessionStart ?? [];
  settings.hooks.SessionStart.push(provider.entry);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);
  return { changed: true, target };
}

function uninstallProviderHook(provider, opts) {
  const target = providerHookPath(provider, opts);
  const settings = readHookSettings(target);
  if (!dureHookRegistered(settings)) return { changed: false, target };
  settings.hooks.SessionStart = settings.hooks.SessionStart.map((group) => ({
    ...group,
    hooks: (group.hooks ?? []).filter(
      (hook) => hook?.command !== DURE_HOOK_COMMAND,
    ),
  })).filter((group) => (group.hooks ?? []).length > 0);
  if (settings.hooks.SessionStart.length === 0) {
    delete settings.hooks.SessionStart;
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);
  return { changed: true, target };
}

function cmdHooks(sub, opts) {
  if (sub === "status" || !sub) {
    for (const provider of HOOK_PROVIDERS) {
      if (!providerPresent(provider, opts)) {
        process.stdout.write(`Skipped (not installed) ${provider.label}\n`);
        continue;
      }
      const target = providerHookPath(provider, opts);
      const registered = dureHookRegistered(readHookSettings(target));
      process.stdout.write(
        `${registered ? "\x1b[32m✓ Registered\x1b[0m" : "Not registered"} ${provider.label} — ${target}\n`,
      );
    }
    return;
  }
  if (sub === "install") {
    for (const provider of HOOK_PROVIDERS) {
      if (!providerPresent(provider, opts)) {
        process.stdout.write(`Skipped (not installed): ${provider.label}\n`);
        continue;
      }
      const { changed, target } = installProviderHook(provider, opts);
      process.stdout.write(
        changed
          ? `\x1b[32m✓\x1b[0m Registered ${provider.label} SessionStart hook: ${target}\n`
          : `Already registered (${provider.label}): ${target}\n`,
      );
    }
    process.stdout.write(
      "  Sessions started inside Dure panes receive the SessionStart hook context.\n",
    );
    return;
  }
  if (sub === "uninstall") {
    for (const provider of HOOK_PROVIDERS) {
      if (!providerPresent(provider, opts)) continue;
      const { changed, target } = uninstallProviderHook(provider, opts);
      process.stdout.write(
        changed
          ? `\x1b[32m✓\x1b[0m Removed ${provider.label} SessionStart hook: ${target}\n`
          : `Not registered (${provider.label}): ${target}\n`,
      );
    }
    return;
  }
  process.stdout.write("dure hooks <install|uninstall|status> [--global]\n");
}

// ---------- doctor (에이전트 환경 의존성 상태) ----------
// 설정 UI가 이 JSON을 읽어 설치 체크리스트를 그린다. 각 항목은 fix 명령을
// 함께 실어 UI 버튼이 그대로 실행할 수 있게 한다(단일 출처: CLI).

function cmdEnvironmentDoctor(opts) {
  // Checkpoint discipline hooks retired 2026-08-27 — the SessionStart hook
  // now emits a no-op; doctor no longer nags anyone to install it.
  const hookDependencies = [];
  // Every shipped skill (cli/skills/<name>) on every present provider, via
  // the same inspectSkills() cmdSkills' `status` uses. dure-orchestration is
  // deliberately excluded: inspectSkills reports it in `external`, but this
  // report already carries it under the orchestration-integration dependency
  // above, with richer per-provider evidence — reporting it twice here would
  // give one fact two owners that can disagree.
  const skillsInspection = inspectSkills({ home: homedir() });
  const skillDetails = skillsInspection.skills.map((skill) => ({
    provider: skill.provider,
    name: skill.name,
    state: skill.state,
    target: skill.target,
    // Task 5's settings-page parser (src/lib/agents/agentEnvironment.ts)
    // compares these verbatim — `--global --provider <p>` in that exact
    // order — and silently drops the whole dependency if a single detail's
    // command does not match. Never reorder or reword these.
    fixCommand: `dure skills install ${skill.name} --global --provider ${skill.provider}`,
    updateCommand: `dure skills update ${skill.name} --global --provider ${skill.provider}`,
  }));
  const orchestrationIntegrations = inspectOrchestrationIntegrations({
    cliScriptPath: CLI_SCRIPT_PATH,
    channel: APP_CHANNEL,
    homeDirectory: homedir(),
    global: true,
  });
  const approvedRefreshProviders = new Set(
    approvedOrchestrationIntegrationRefreshProviders({
      cliScriptPath: CLI_SCRIPT_PATH,
      channel: APP_CHANNEL,
      homeDirectory: homedir(),
      global: true,
    }),
  );
  const report = {
    schemaVersion: 1,
    cli: { path: process.argv[1] ?? null },
    dependencies: [
      {
        id: "orchestration-integration",
        label: "durable orchestration integration",
        ok: orchestrationIntegrations.every(
          (integration) => integration.status === "current",
        ),
        fixCommand:
          "dure integration install --global --approve-global-config",
        updateCommand:
          "dure integration update --global --approve-global-config",
        uninstallCommand:
          "dure integration uninstall --global --approve-global-config",
        details: orchestrationIntegrations.map((integration) => ({
          provider: integration.provider,
          status: integration.status,
          installRoot: integration.installRoot,
          installRootRef: integration.installRootRef,
          version: integration.version,
          digest: integration.digest,
          channel: integration.channel,
          transportRef: integration.transportRef,
          capabilities: integration.capabilities,
          fixCommand:
            `dure integration install --global --provider ${integration.provider} --approve-global-config`,
          updateCommand:
            `dure integration update --global --provider ${integration.provider} --approve-global-config`,
          uninstallCommand:
            `dure integration uninstall --global --provider ${integration.provider} --approve-global-config`,
          refreshCommand:
            integration.status === "outdated" &&
            approvedRefreshProviders.has(integration.provider)
              ? `dure integration refresh --global --provider ${integration.provider}`
              : null,
        })),
      },
      ...hookDependencies,
      {
        id: "dure-skills",
        label: "Dure skills",
        ok: skillDetails.every((detail) => detail.state === "current"),
        fixCommand: "dure skills install --global",
        updateCommand: "dure skills update --all --global",
        details: skillDetails,
      },
    ],
  };
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const dep of report.dependencies) {
    process.stdout.write(
      `${dep.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${dep.label}` +
        (dep.ok ? "\n" : ` — ${dep.fixCommand}\n`),
    );
    if (!dep.ok && dep.id === "dure-skills") {
      for (const detail of dep.details) {
        if (detail.state !== "current") {
          process.stdout.write(`    ${detail.provider}/${detail.name} — ${detail.state}\n`);
        }
      }
    }
  }
}

async function cmdIntegration(sub, opts) {
  const action = sub || "status";
  if (!new Set(["install", "update", "refresh", "uninstall", "status"]).has(action)) {
    fail(
      "Usage: dure integration <install|update|refresh|uninstall|status> [--global --approve-global-config] [--provider codex|claude] [--remote --backend ID] [--json]",
    );
  }
  if (opts.rest.length > 1) {
    fail("Too many integration arguments.");
  }
  try {
    if (opts.backendSpecified && !opts.remote) {
      fail("Integration --backend requires --remote.");
    }
    if (action === "refresh" && opts.remote) {
      fail("Approved integration refresh is local-only.");
    }
    if (
      opts.remote &&
      (opts.installRoot !== undefined || opts.transportRef !== undefined)
    ) {
      fail("Remote integration derives its install and transport references.");
    }
    const common = {
      cliScriptPath: CLI_SCRIPT_PATH,
      channel: APP_CHANNEL,
      homeDirectory: homedir(),
      global: Boolean(opts.global),
      provider: opts.provider,
      installRoot: opts.installRoot,
      transportRef: opts.transportRef,
      approval: Boolean(opts.approveGlobalConfig),
    };
    const receipts = opts.remote
      ? await runRemoteOrchestrationIntegration({
          action,
          approval: common.approval,
          backend: opts.backend,
          channel: common.channel,
          cliScriptPath: common.cliScriptPath,
          global: common.global,
          provider: common.provider,
        })
      : runOrchestrationIntegrationAction(action, common);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, receipts }, null, 2)}\n`);
      return;
    }
    for (const receipt of receipts) {
      process.stdout.write(
        `${receipt.provider}: ${receipt.status}\n` +
          `  root: ${receipt.installRoot}\n` +
          `  version: ${receipt.version ?? "-"}\n` +
          `  digest: ${receipt.digest ?? "-"}\n` +
          `  channel: ${receipt.channel ?? "-"}\n` +
          `  transport: ${receipt.transportRef ?? "-"}\n` +
          `  capabilities: ${(receipt.capabilities ?? []).join(", ") || "-"}\n`,
      );
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

// ---------- skills (에이전트에 dure 사용법 스킬 설치) ----------
// 번들된 SKILL.md를 Claude Code 스킬 디렉터리에 설치해, 스폰된 에이전트가
// 오케스트레이션 CLI를 쓸 줄 알게 한다.

function skillSrcDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "skills");
}

// Skills Dure ships from somewhere other than cli/skills. Listing only the
// bundle directory under-reports what an agent actually has installed, so
// name these and the command that owns each one instead of staying silent.
const EXTERNAL_SKILLS = [
  { name: "dure-orchestration", install: "dure integration install" },
];

// The providers the receipted install lifecycle (status/install --global/
// update/remove) knows about. Matches cli/lib/skill-install.mjs's own table;
// kept here too since this file decides *which* providers to touch for a
// given --provider flag, a policy skill-install.mjs deliberately does not
// infer for itself (see installSkill's createProviderHome doc comment there).
const SKILL_PROVIDERS = ["claude", "codex"];

/** Reports a usage problem on stderr and marks the process failed without a
 *  hard `process.exit` — the `process.exitCode = N; return;` convention this
 *  file already uses elsewhere (e.g. the feedback and orch-invoke commands),
 *  rather than the CLI-wide `fail()`, which always exits 1. Every call site
 *  must `return` immediately afterward; this function does not stop execution
 *  on its own. */
function skillUsageError(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function skillErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The bundled skill names under `src`: the same filter `dure skills list`
 *  already applies (a subdirectory containing a SKILL.md), sorted so install
 *  --all and update --all have a deterministic order. */
function shippedSkillNames(src) {
  let names = [];
  try {
    names = readdirSync(src).filter((n) => existsSync(join(src, n, "SKILL.md")));
  } catch {}
  return names.sort();
}

/**
 * Resolves `--provider` into the providers to touch and whether an absent
 * provider home should be created for a write. `all` (the default) is an
 * implicit selection: an absent provider is skipped rather than conjured for
 * a tool this machine may never run. Naming a provider explicitly is the
 * user asking for it in as many words, so its home is created if missing —
 * this is the policy decision cli/lib/skill-install.mjs's `createProviderHome`
 * leaves to its caller. Reports its own usage error (exit 2) and returns
 * `null` for an unrecognized value; every call site must `return` immediately
 * on `null`.
 */
function resolveSkillProviders(opts) {
  const requested = opts.provider ?? "all";
  if (requested === "all") return { providers: SKILL_PROVIDERS, explicit: false };
  if (SKILL_PROVIDERS.includes(requested)) return { providers: [requested], explicit: true };
  skillUsageError(`Unknown --provider '${requested}'. Use claude, codex, or all.`);
  return null;
}

function formatSkillsStatusLines(inspection) {
  const lines = [];
  for (const entry of inspection.skills) {
    lines.push(`  ${entry.name} (${entry.provider}): ${entry.state}`);
  }
  for (const entry of inspection.external) {
    lines.push(
      `  ${entry.name} (${entry.provider}): ${entry.present ? "present" : "absent"} — install: ${entry.installCommand}`,
    );
  }
  for (const entry of inspection.skipped) {
    lines.push(`  ${entry.provider}: skipped (${entry.reason})`);
  }
  return lines.length ? lines.join("\n") : "  (none)";
}

function cmdSkills(reg, sub, opts) {
  const src = skillSrcDir();
  if (sub === "get") {
    // Validate the raw request: the legacy option parser consumes unknown
    // flags, which must not turn a requested reference into a different guide.
    const args = invocationArguments.slice(1).filter((arg) => arg !== "--json");
    const name = args[1];
    if (args.length !== 2 || args[0] !== "get" || !/^[a-z][a-z0-9-]*$/.test(name ?? "")) {
      skillUsageError("Usage: dure skills get <name> [--json]");
      return;
    }
    if (!shippedSkillNames(src).includes(name)) {
      skillUsageError(`Bundled skill '${name}' was not found. List skills with: dure skills list`);
      return;
    }
    // These installed skills are discovery stubs. Their full guides must be
    // present in this same CLI bundle; never fall back to the stub on damage.
    const file = ["dure", "dure-browser"].includes(name) ? "GUIDE.md" : "SKILL.md";
    let markdown;
    try {
      markdown = readFileSync(join(src, name, file), "utf8");
    } catch {
      skillUsageError(`Bundled guide '${name}' is unreadable. Update this Dure CLI installation.`);
      return;
    }
    const { packageVersion, buildId } = currentCliIdentity();
    process.stdout.write(opts.json
      ? `${JSON.stringify({ schemaVersion: 1, name, cli: { packageVersion, buildId }, markdown })}\n`
      : markdown);
    return;
  }
  if (sub === "list" || !sub) {
    let names = [];
    try {
      names = readdirSync(src).filter((n) => existsSync(join(src, n, "SKILL.md")));
    } catch {}
    process.stdout.write(
      "Bundled skills:\n" +
        (names.length ? names.map((n) => "  " + n).join("\n") : "  (none)") +
        "\n\nRead this CLI's guide: dure skills get <name> [--json]\n" +
        "Install: dure skills install [name] [--global] (omit the name with --global to install every bundled skill)\n" +
        EXTERNAL_SKILLS.map(
          (skill) =>
            `\nShipped separately:\n  ${skill.name}\n\nInstall: ${skill.install}\n`,
        ).join(""),
    );
    return;
  }
  if (sub === "path") {
    process.stdout.write(src + "\n");
    return;
  }
  if (sub === "status") {
    // Always the real (home-based) provider lifecycle — there is no
    // project-scoped notion of "status" the way install has a legacy
    // per-cwd mode; see the module-level notes on cmdSkills' install branch.
    const inspection = inspectSkills({});
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
      return;
    }
    process.stdout.write(`Skills:\n${formatSkillsStatusLines(inspection)}\n`);
    return;
  }
  if (sub === "install") {
    const explicitName = opts.rest[1];
    if (!opts.global) {
      // Legacy project-scoped install, byte-for-byte unchanged from before
      // the receipt lifecycle existed: a single file under
      // <cwd>/.claude/skills, no provider fan-out and no receipt.
      // scripts/skills-commands.test.mjs pins this exact path without
      // setting HOME/DURE_HOME, so it must never route through
      // cli/lib/skill-install.mjs (which would write a receipt into the
      // real ~/.dure in that test). A nameless install here still means the
      // single skill "dure" — that meaning only changes under --global,
      // below.
      const name = explicitName || "dure";
      const sourceName = name === "hebbian" ? "dure" : name;
      const srcSkill = join(src, sourceName, "SKILL.md");
      if (!existsSync(srcSkill)) {
        skillUsageError(`Bundled skill '${name}' was not found. List skills with: dure skills list`);
        return;
      }
      const base = join(process.cwd(), ".claude", "skills");
      const dstDir = join(base, name);
      mkdirSync(dstDir, { recursive: true });
      writeFileSync(join(dstDir, "SKILL.md"), readFileSync(srcSkill, "utf8"));
      process.stdout.write(
        `\x1b[32m✓\x1b[0m Installed skill '${name}': ${join(dstDir, "SKILL.md")}\n` +
          `  Claude Code agents running in this folder can discover it immediately.\n`,
      );
      return;
    }
    // --global: the receipted, multi-provider lifecycle. `dure skills
    // install dure --global` keeps this exact spelling — settings-page
    // dependency parsing (src/lib/agents/agentEnvironment.ts) compares it
    // verbatim — but now widens to every present provider instead of only
    // ~/.claude. A nameless `dure skills install --global` installs every
    // bundled skill: that is the literal fixCommand cmdEnvironmentDoctor
    // publishes for the whole dure-skills dependency, and the settings page
    // is about to put a button on it, so it must actually repair every
    // skill, not just one. (`--all` reaches here too: parseOpts consumes it
    // into opts.all before it ever lands in opts.rest, so `--all --global`
    // already has an empty rest[1] and takes the same path.)
    // The legacy `hebbian` -> `dure` alias above is deliberately NOT honoured
    // here. It installs bundle content under a different directory name, and
    // every receipted operation — status, update, remove — looks skills up by
    // their bundled name, so an aliased install would be invisible to all of
    // them forever. Rejecting it with the usual not-found error is the loud
    // failure; the alias survives only on the legacy cwd path, which keeps no
    // receipts and therefore does not care.
    const names = explicitName ? [explicitName] : shippedSkillNames(src);
    for (const name of names) {
      if (!existsSync(join(src, name, "SKILL.md"))) {
        skillUsageError(`Bundled skill '${name}' was not found. List skills with: dure skills list`);
        return;
      }
    }
    const resolved = resolveSkillProviders(opts);
    if (!resolved) return;
    const targets = new Map(providerTargets({}).map((target) => [target.provider, target]));
    let failed = false;
    for (const provider of resolved.providers) {
      // Implicit provider set (--provider all, the default): skip a provider
      // whose home does not exist rather than conjure one for a tool this
      // machine may never run. Checked via providerTargets, not by catching
      // installSkill's throw — its message is documented as brittle to match
      // on. One provider's outcome never aborts the loop for the other, and
      // neither does one name's — every (provider, name) pair below is tried
      // independently.
      if (!resolved.explicit && !targets.get(provider)?.present) {
        process.stdout.write(`  ${provider}: skipped (provider not present)\n`);
        continue;
      }
      for (const name of names) {
        try {
          const { target } = installSkill({ name, provider, createProviderHome: resolved.explicit });
          process.stdout.write(`\x1b[32m✓\x1b[0m Installed '${name}' for ${provider}: ${target}\n`);
        } catch (error) {
          failed = true;
          process.stderr.write(`  ${provider}: install '${name}' failed — ${skillErrorMessage(error)}\n`);
        }
      }
    }
    if (failed) process.exitCode = 1;
    return;
  }
  if (sub === "update") {
    const explicitName = opts.rest[1];
    if (!opts.all && !explicitName) {
      skillUsageError("Usage: dure skills update <name> | --all --global [--provider claude|codex|all]");
      return;
    }
    if (!opts.global) {
      skillUsageError("dure skills update requires --global. Receipts are stored per user, not per project.");
      return;
    }
    const bundled = shippedSkillNames(src);
    let names;
    if (opts.all) {
      names = bundled;
    } else {
      if (!bundled.includes(explicitName)) {
        skillUsageError(`Bundled skill '${explicitName}' was not found. List skills with: dure skills list`);
        return;
      }
      names = [explicitName];
    }
    const resolved = resolveSkillProviders(opts);
    if (!resolved) return;
    // The receipt store is keyed to the user's real home (appRootDirectory in
    // cli/lib/skill-install.mjs) and never follows a `home` argument, so
    // unlike install, update has no legacy cwd-scoped mode: a cwd-scoped
    // update would read and write a project-local file while reading and
    // writing the receipt for an unrelated global install of the same skill
    // name. --global is rejected above, before any of this runs, for exactly
    // that reason.
    const home = homedir();
    const inspection = inspectSkills({ home });
    const skippedProviders = new Set(inspection.skipped.map((entry) => entry.provider));
    let failed = false;
    for (const provider of resolved.providers) {
      if (skippedProviders.has(provider)) {
        process.stdout.write(`${provider}: skipped (provider not present)\n`);
        continue;
      }
      for (const name of names) {
        const entry = inspection.skills.find((skill) => skill.name === name && skill.provider === provider);
        if (!entry) continue;
        // Re-installs only outdated, modified and unmanaged; leaves current
        // untouched but still says so, so a second run visibly does nothing.
        // "missing" is deliberately not re-installed here — update refreshes
        // an existing install, it does not perform a first install (that is
        // what `dure skills install` is for).
        if (entry.state === "current") {
          process.stdout.write(`${name} (${provider}): already current\n`);
          continue;
        }
        if (entry.state === "missing") {
          process.stdout.write(`${name} (${provider}): not installed, skipped (use install)\n`);
          continue;
        }
        try {
          // createProviderHome is a no-op on this path: the loop above
          // already `continue`d past any provider in skippedProviders, so
          // every provider reaching this line already has a home that
          // exists. Passed through only for call-site consistency with
          // install's own call.
          installSkill({ name, provider, home, createProviderHome: resolved.explicit });
          process.stdout.write(`\x1b[32m✓\x1b[0m ${name} (${provider}): reinstalled (was ${entry.state})\n`);
        } catch (error) {
          failed = true;
          process.stderr.write(`${name} (${provider}): update failed — ${skillErrorMessage(error)}\n`);
        }
      }
    }
    if (failed) process.exitCode = 1;
    return;
  }
  if (sub === "remove") {
    const name = opts.rest[1];
    if (!name) {
      skillUsageError("Usage: dure skills remove <name> [--provider claude|codex|all]");
      return;
    }
    // No bundle-membership check: a skill later dropped from the bundle must
    // still be removable, unlike install/update which only ever write
    // bundled content.
    const resolved = resolveSkillProviders(opts);
    if (!resolved) return;
    let failed = false;
    for (const provider of resolved.providers) {
      try {
        removeSkill({ name, provider });
        process.stdout.write(`\x1b[32m✓\x1b[0m Removed '${name}' for ${provider}\n`);
      } catch (error) {
        failed = true;
        process.stderr.write(`${provider}: remove failed — ${skillErrorMessage(error)}\n`);
      }
    }
    if (failed) process.exitCode = 1;
    return;
  }
  process.stdout.write(
    "dure skills <get <name> [--json]|status [--json]|list|path|" +
      "install [name|--all] [--global] [--provider claude|codex|all]|" +
      "update <name|--all> --global [--provider claude|codex|all]|" +
      "remove <name> [--provider claude|codex|all]>\n",
  );
}

// ---------- computer-use (macOS, osascript 기반 경량 데스크톱 제어) ----------
// 접근성(손쉬운 사용) 권한 필요. 스크린샷은 화면 기록 권한 필요.

function osa(script) {
  const r = spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: 15000 });
  if (r.status !== 0) fail((r.stderr || "osascript failed").trim() + "\n(Accessibility permission may be required: System Settings > Privacy & Security > Accessibility)");
  return r.stdout.trim();
}

function esc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function cmdComputer(reg, sub, opts) {
  const app = opts.app || opts.rest[1];
  switch (sub) {
    case "apps": {
      const out = osa(
        'tell application "System Events" to get name of (every process whose background only is false)',
      );
      process.stdout.write(out.split(", ").join("\n") + "\n");
      return;
    }
    case "state": {
      const front = osa('tell application "System Events" to get name of first process whose frontmost is true');
      let wins = "";
      try {
        wins = osa(
          `tell application "System Events" to tell process "${esc(app || front)}" to get name of every window`,
        );
      } catch {}
      process.stdout.write(`frontmost: ${front}\n` + (wins ? `windows(${app || front}): ${wins}\n` : ""));
      return;
    }
    case "activate": {
      if (!app) fail("--app <name> is required.");
      osa(`tell application "${esc(app)}" to activate`);
      process.stdout.write(`\x1b[32m✓\x1b[0m Activated ${app}\n`);
      return;
    }
    case "type": {
      if (!app) fail("--app <name> is required.");
      const text = opts.text || opts.rest.slice(2).join(" ");
      if (!text) fail("Text to type is required.");
      osa(`tell application "${esc(app)}" to activate\ndelay 0.2\ntell application "System Events" to keystroke "${esc(text)}"`);
      process.stdout.write(`\x1b[32m✓\x1b[0m Typed into ${app}\n`);
      return;
    }
    case "key": {
      if (!app) fail("--app <name> is required.");
      const key = opts.key || opts.rest[2];
      if (!key) fail("A key is required (for example: return, tab, cmd+s).");
      const MODS = { cmd: "command down", command: "command down", ctrl: "control down", control: "control down", alt: "option down", opt: "option down", option: "option down", shift: "shift down" };
      const CODES = { return: 36, enter: 36, tab: 48, space: 49, esc: 53, escape: 53, delete: 51, backspace: 51, up: 126, down: 125, left: 123, right: 124, home: 115, end: 119 };
      const parts = key.toLowerCase().split("+");
      const base = parts.pop();
      const mods = parts.map((m) => MODS[m]).filter(Boolean);
      const using = mods.length ? ` using {${mods.join(", ")}}` : "";
      const action =
        CODES[base] !== undefined
          ? `key code ${CODES[base]}${using}`
          : `keystroke "${esc(base)}"${using}`;
      osa(`tell application "${esc(app)}" to activate\ndelay 0.2\ntell application "System Events" to ${action}`);
      process.stdout.write(`\x1b[32m✓\x1b[0m ${app}: sent key ${key}\n`);
      return;
    }
    case "menu": {
      const menu = opts.rest[2];
      const item = opts.rest[3];
      if (!app || !menu || !item) fail("Usage: dure computer menu <app> <menu> <item>");
      osa(
        `tell application "System Events" to tell process "${esc(app)}" to click menu item "${esc(item)}" of menu "${esc(menu)}" of menu bar 1`,
      );
      process.stdout.write(`\x1b[32m✓\x1b[0m ${app}: ${menu} > ${item}\n`);
      return;
    }
    case "screenshot": {
      const path = opts.rest[1] || join(APP_CONTROL_DIR, `screenshot-${nowMs()}.png`);
      const r = spawnSync("screencapture", ["-x", path], { encoding: "utf8" });
      if (r.status !== 0) fail("screencapture failed (Screen Recording permission may be required).");
      process.stdout.write(path + "\n");
      return;
    }
    default:
      process.stdout.write(
        `dure computer <sub> — macOS desktop control (osascript)\n` +
          `  apps                          List running apps\n` +
          `  state [--app A]               Show the frontmost app and window titles\n` +
          `  activate --app A              Bring an app to the front\n` +
          `  type --app A "text"            Type into an app\n` +
          `  key --app A <return|cmd+s|…>  Send a key\n` +
          `  menu <app> <menu> <item>       Click a menu item\n` +
          `  screenshot [path]             Capture the screen and return its path\n` +
          `\nAccessibility and Screen Recording permissions are required.\n`,
      );
  }
}

// ---------- 진입점 ----------


async function cmdInstall(opts) {
  if (!opts.global || opts.rest.length !== 0) {
    fail("Usage: dure install --global [--json]");
  }
  try {
    const { promoteRunningDureCli } = await import(
      "./lib/dure-cli-promotion.mjs"
    );
    const receipt = promoteRunningDureCli(CLI_SCRIPT_PATH);
    process.stdout.write(
      opts.json
        ? `${JSON.stringify(receipt)}\n`
        : `Installed Dure CLI ${receipt.buildId}\n  command: ${receipt.command}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          error: { code: "dure_cli_install_failed", message },
        })}\n`,
      );
    } else {
      process.stderr.write(`Dure CLI install failed: ${message}\n`);
    }
    process.exitCode = 2;
  }
}

function parseWorkflowOpts(args) {
  const opts = { rest: [], json: false, backendSpecified: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--json") {
      opts.json = true;
      continue;
    }
    if (argument === "--backend") {
      const value = args[index + 1];
      if (opts.backendSpecified || value === undefined || value.startsWith("--")) {
        fail(WORKFLOW_HELP);
      }
      opts.backendSpecified = true;
      opts.backend = value;
      index += 1;
      continue;
    }
    const field =
      argument === "--task"
        ? "task"
        : argument === "--dispatch"
          ? "dispatch"
          : argument === "--generation"
            ? "generation"
            : argument === "--result"
              ? "result"
              : null;
    if (field) {
      const value = args[index + 1];
      if (opts[field] !== undefined || value === undefined || value.startsWith("--")) {
        fail(WORKFLOW_HELP);
      }
      opts[field] = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) fail(WORKFLOW_HELP);
    opts.rest.push(argument);
  }
  return opts;
}

const HELP = `dure — command-line control for Dure agents

Usage:
  dure ls                          List managed backend sessions and their liveness
  dure read <agent-or-session> [-f] [-n N]
                                       Read screen (-f follow, -n visible lines)
                                       --workspace ID --deadline-ms N (default 2500, max 10000)
                                       backend read: --workspace ID --backend ID
  dure transcript <agent-or-id> [-n N | --all] [--backend ID] [--json]
                                       Copy-ready canonical conversation transcript
  dure send <name> <text...>       Send text and Enter (omit Enter with --no-enter)
  dure send <name> (--file PATH | --stdin) [--no-enter] [--json]
                                      Send exact UTF-8 text; JSON describes delivery, not task completion
                                      --idempotency-key applies to the running app broker path
                                      Uncertain app-independent delivery is not retried automatically
  dure enter <name>                Send Enter to submit the current prompt
  dure send-keys <name> <key...> [--json]
                                      Semantic keys (C-c, Up, Enter); local managed terminals
  dure logs <name> [-n N]          Dump scrollback (default 2000 lines)
  dure attach <session-id> --workspace <workspace-id> [--backend ID]
                                      Attach to an exact managed Hmux session without the app
  dure spawn preview (--project <id> | --path <path>) --provider <id> --name <name> --idempotency-key <key>
                                      Create or reuse a durable spawn plan without the app daemon
                                      Requires --no-worktree or --base-commit SHA --branch REF
                                      Dedicated checkouts support --setup-command COMMAND
  dure spawn apply --operation-id <id> --plan-token <token> --expected-sequence <n>
                                      Apply or resume the reviewed plan without the app
  dure spawn status (--operation-id <id> | --idempotency-key <key>) [--backend ID] [--json]
                                      Read a durable spawn receipt without the app daemon
  dure run [--project <id> | --path <path>] [--provider <id>] [--backend ID] <prompt>
                                      Start a backend Run; path defaults to cwd, --space ID|NAME
                                      --worktree NAME selects a dedicated checkout; otherwise use the project root
                                      --setup-command runs in the same pane before the provider
                                      Uses the current Space when run inside a pane; headless otherwise
  dure spawn [run options] [prompt] Deprecated alias for the same Run path
  dure spawn --reuse --project <id|name> --name <name> [--agent <provider>]
                                      Reuse an existing Agent or successor without creating a provider
  dure schedule create --cron "M H D M W" [--timezone IANA] <prompt>
                                      Run durable schedules on the selected backend
                                      Project path defaults to cwd; same contract for local and SSH
  dure schedule <list|show|delete|runs> ...
                                      Inspect schedules, delete with a revision check, or read run history
  dure environment <recipes|create|list|suspend|resume|destroy> ...
                                      Manage per-worktree VM environments (Pro)
  dure wait <name> [--timeout S] [--json]   Observe the next Host-reported response end
  dure wait --operation-id ID [--json]    Wait for a run request, not its response
  dure wait --task ID --dispatch ID --generation N [--json]   Wait for delegated task completion
  dure hooks install [--global]    Install SessionStart hooks (also: uninstall/status)
  dure install --global            Install this app channel's immutable CLI for login shells
  dure doctor [--json]             Check agent dependencies, hooks and skills
  dure feedback [text...] [--kind bug|idea|other] [--contact <value>] [--json] [--yes]
                                      Send a report the same way the in-app dialog does
                                      Text from arguments, else stdin, else $EDITOR when interactive
                                      Confirms interactively unless --yes or the input is non-interactive
                                      Flags must come before the text; a later --word needs a literal -- first, or use stdin
  dure integration <install|status|update|uninstall> [--global --approve-global-config]
                                      Install, inspect, update or remove the shared orchestration client
                                      Identifies the current agent automatically; use --agent <name> outside a pane
  dure whoami [--json]              Print this agent's latest display name/identity
  dure hmux attach --name <name> [--space-id <id>]
                                      Find a named Hmux session and attach it to a pane in a Space
  dure hmux upgrade --name <name> --target-panel-id <pane> --confirm-restart
                                      Restart on the current Hmux build and update the existing pane
  dure hmux adopt --name <project/agent> [--target-panel-id <pane>] --confirm-restart
                                      Adopt a legacy agent pane into Hmux using its exact provider conversation ID
  dure hmux adopt --from-session <session> --target-panel-id <pane> --provider <claude|codex> --agent-name <name> --confirm-restart
                                      Convert a provider in a legacy terminal to a managed Agent in the same pane
  dure hmux rehost --name <project/agent> [--backend ID] [--confirm-restart] [--json]
                                       Preview a local source; confirmation starts native rehost and publishes its binding
  dure hmux rehost --name <project/agent> [--target-panel-id <pane>] [--conversation-id <id> | --fresh] [--permission-mode <default|skip_permissions>] [--existing-session <session>] [--confirm-restart] [--json]
                                      Preview or apply a managed Agent rehost or permission-mode change
  dure hmux rehost status [<original-session-id> --workspace ID] --operation-id ID [--json]
                                       Read a local operation without running recovery or requiring the app
  dure hmux rehost start <original-session-id> --workspace ID --operation-id ID --confirm-restart [--json]
                                       Start or replay one local same-conversation rehost without the app
  dure hmux rehost retry [<original-session-id> --workspace ID] --operation-id ID --confirm-restart [--json]
                                       Resume only the journaled local operation; never create a fresh one
  dure hmux rehost publish <agent-id> --from-session <original-session-id> --workspace ID --operation-id ID [--backend ID] [--json]
                                       Publish native completion to the Agent binding without running recovery
  dure hmux convert --name <session> --target-panel-id <pane> --to <managed|standalone> [--agent-name <name>]
                                      Convert the Hmux session class using its exact conversation ID (preview by default)
  dure hmux stop --name <project/agent> [--target-panel-id <pane>] [--yes]
                                      Stop the exact managed Hmux provider and clean up its Agent
  dure hmux migrate ...             Alias for hmux adopt
  dure orchestration events-canary --session-file PATH [--backend ID] [--json]
                                      Read-only event observation for an existing exact session
  dure orchestration invoke <method> <body-json> [--backend ID] [--json]
                                      Call the same versioned API on local, SSH or hosted backends
  dure workflow done --task <id> --dispatch <id> --generation <n> [--result <text>]
                                      Complete work as the current exact Hmux worker session
  dure workflow show --task <id> --dispatch <id> --generation <n>
                                      Read an existing delegated-work receipt
  dure doctor migrate-home [--apply]
                                   Move ~/.hebbian to ~/.dure (preview by default).
                                   Refuses while a lock owner is active; after migration,
                                   the old path remains available through a compatibility symlink.
  dure skills get <name> [--json]  Read the guide bundled with this CLI; no running app required
  dure skills status [--json]      Show every bundled skill's install state per provider; always the user's real home
  dure skills install [name] [--global] [--provider claude|codex|all]
                                      Install a bundled skill; --global widens to ~/.claude and ~/.codex; omit the name with --global to install every bundled skill
  dure skills update <name|--all> --global [--provider claude|codex|all]
                                      Re-install outdated/modified/unmanaged skills in the user's real home; leaves current ones alone; --global is required (receipts are per user)
  dure skills remove <name> [--provider claude|codex|all]
                                      Remove an installed skill and its receipt; always the user's real home
  dure computer <sub> ...          Control the macOS desktop (osascript); see computer help
  dure github share <ssh-destination> --repo [HOST/]OWNER/REPO
                                      Share local gh issue reads with a Dure SSH terminal
  dure quick-commands <list|put|remove> ...
                                      Manage saved prompts through the connected app; never executes them
  dure client pane <open|create|split|close|state|act> ...
                                      Manage panes in the connected Dure client
  dure client project add [PATH] [--space ID_OR_NAME | --space-id ID] [--host ID]
                                      Add a shared app working location; no pane or worktree creation
  dure client host add <SSH_CONFIG_ALIAS> [--name NAME] [--json]
  dure client host add --hostname HOST --user USER [--port PORT] [--identity-file PATH]
                                      Register an SSH host in the app; returns its ID for --host
  dure client workspace open <pane-id> --space-id ID [--target TARGET]
                                      Open the exact local workspace in an external app
  dure perf report [--projection terminal-input] [--json]
  dure perf summary [--json]       One-shot input latency and frame-wait summary
  dure sessions list [--backend ID] [--json]
                                      Query local or remote sessions with bounded reads, without the app daemon
  dure sessions show <id> [--workspace ID] [--json]
                                      Inspect the exact session runtime and its Agent/pane projection
  dure inspect <id> [--workspace ID] [--backend ID] [--json]
                                      Alias for sessions show; same read-only receipt
  dure projects list [--backend ID] [--json]
                                      List backend project identities without the app daemon
  dure projects show <id> [--backend ID] [--json]
                                      Read the exact project authority used by daemonless spawn
  dure projects register <id> [--path PATH] [--name NAME] [--backend ID] [--json]
                                      Register cwd or the specified path on the selected backend
  dure recovery <get|put|status|observe> [--backend ID] [--json]
  dure provider-defaults <get|set> [provider mode] [--backend ID] [--json]
                                      Read or change provider permission defaults on the selected backend
  dure providers capabilities [--json]
                                      Read-only bundled provider declarations; no runtime probe
  dure runtime get <agent-id> [--backend ID] [--json]
  dure runtime switch <agent-id> chat|terminal [--backend ID] [--json]
  dure spaces list [--backend ID] [--json]
                                      List client-local Spaces and pane counts without the app
  dure spaces show <id-or-name> [--backend ID] [--json]
                                      Inspect each pane's exact session generation and liveness
  dure sessions recent [--json]    List recent provider-native sessions (requires the app)
  dure workspace import preview    Preview the desktop/pane plan and its exact token
  dure workspace import status     Read the import journal and receipt status
  dure workspace import apply --plan-token TOKEN --yes
                                      Create desktops and panes from the reviewed plan
  dure version [--json]            Print CLI package and build identity
  dure backend status [--json] [--timeout-ms N] [--probe-budget-ms N]
                                      Read backend/Hmux status independently of the app
  dure backend health [--json] [--timeout-ms N] [--probe-budget-ms N]
                                      Status JSON; exit 0 ready, 1 degraded, 2 failure
  dure backend reconcile [--backend ID] [--json]
                                      Connect to a compatible owner; recover an unavailable local service
  dure backend activate [--backend ID] [--json]
                                      Activate this verified bundle through the managed replacement transaction
  dure server <status|health> ...  Compatibility alias for backend
  dure orch status [--json] [--repo PATH] [--backend ID] [--timeout-ms N] [--cache-ms N]
                                      Read combined CI and host status independently of the app
  dure orch health [--json] [--repo PATH] [--backend ID] [--timeout-ms N] [--cache-ms N]
                                      Exit 0 healthy, 1 degraded, 2 unknown
  dure diagnostics [--json] [--check] [--require app,hmux,path]
                                      Diagnose and verify the CLI, app, backend and Hmux in one pass
  dure profiles <list|show|resolve|test> [ID] [--backend ID] [--json]
                                      Inspect, select and test backend profiles independently of the app

<name> is an agent name, project/name to disambiguate, or a session ID.
Deprecated compatibility aliases: hebbian-ade, hebbian-ide (same executable)
Legacy control/client display projection: ~/.dure/agents.json (written by the app)`;

const WORKFLOW_HELP = `dure workflow — delegated workflow control

Usage:
  dure workflow done --task <id> --dispatch <id> --generation <n> [--result <text>] [--json]
  dure workflow show --task <id> --dispatch <id> --generation <n> [--backend ID] [--json]

done resolves the exact generation of the current managed Hmux worker Session and completes it.
--result records up to 16 KiB of result text in the same canonical receipt.
show reads existing receipts without inferring Hmux Session state.
Session and provider identities are not accepted as flags.`;

const WHOAMI_HELP = `dure whoami — print the current agent's latest IDE identity

Usage:
  dure whoami              Print only the latest display name
  dure whoami --json       Print display name and stable identity fields
  dure whoami --agent NAME Resolve an agent explicitly when run outside its pane
  dure whoami --json --strict-session ID
                           Require one unique local registry session and stable ID

The command identifies the current agent by HMUX_SESSION_ID (or the legacy
HEBBIAN_SESSION), then reads the latest Dure registry. Renaming changes only the
display name. It does not move the worktree, rename the branch, restart the
provider, or change the session ID. HMUX_SESSION_NAME remains the launch-time
value because a running process environment cannot be rewritten.`;

/** 유지보수 커맨드 — 레지스트리 불필요(앱이 안 돌았어도 동작해야 한다). */
async function cmdDoctor(opts) {
  if (!opts.rest[0]) {
    // 인자 없음 = 에이전트 환경 의존성 점검(훅·스킬). migrate-home은 유지.
    cmdEnvironmentDoctor(opts);
    return;
  }
  if (opts.rest[0] !== "migrate-home") {
    fail("Usage: dure doctor [--json] | dure doctor migrate-home [--apply]");
  }
  const { migrateHome } = await import("./lib/migrate-home.mjs");
  const outcome = migrateHome(homedir(), { apply: Boolean(opts.apply) });
  for (const line of outcome.log) process.stdout.write(line + "\n");
  if (outcome.applied) {
    process.stdout.write("\x1b[32m✓\x1b[0m Migration complete. Restart the app and agents to use the new paths.\n");
  }
}

/** backend profile 조회 — 앱 레지스트리나 app daemon이 없어도 동작한다. */
async function cmdProfiles(opts) {
  const {
    backendProfilesErrorReport,
    formatBackendProfilesReport,
    loadBackendProfiles,
    projectBackendProfile,
    selectBackendProfile,
  } = await import("./lib/backend-profiles.mjs");
  const { loadBackendProfilesWithDefault, localBackendErrorReport } =
    await import("./lib/local-backend.mjs");
  const [action, profileId] = opts.rest;
  if (
    !action ||
    action === "help" ||
    action === "-h" ||
    action === "--help"
  ) {
    process.stdout.write(
      "dure profiles <list|show|resolve|test> [ID] [--backend ID] [--json]\n",
    );
    return;
  }
  if (!new Set(["list", "show", "resolve", "test"]).has(action)) {
    fail(
      "Usage: dure profiles <list|show|resolve|test> [ID] [--backend ID] [--json]",
    );
  }
  if (action === "show" && !profileId) {
    fail("Usage: dure profiles show <ID> [--json]");
  }
  if (opts.rest.length > (new Set(["show", "test"]).has(action) ? 2 : 1)) {
    fail("Too many backend profile arguments.");
  }
  if (opts.backendSpecified && !new Set(["resolve", "test"]).has(action)) {
    fail("--backend is only supported by dure profiles resolve/test.");
  }
  if (action === "test" && profileId && opts.backendSpecified) {
    fail("dure profiles test cannot use ID and --backend together.");
  }
  let selectedProfile;
  let testHelpers;
  try {
    const catalog =
      action === "test"
        ? loadBackendProfiles({ environment: process.env })
        : await loadBackendProfilesWithDefault({
            bootstrapMissing: action === "list" || action === "resolve",
            cliScriptPath: CLI_SCRIPT_PATH,
          });
    let report;
    if (action === "list") {
      report = {
        schemaVersion: 1,
        apiVersion: "dure.backend-profiles/v1",
        kind: "dure.backend_profiles.list",
        profiles: catalog.profiles.map(projectBackendProfile),
      };
    } else {
      const selection = selectBackendProfile(catalog, {
        explicitId:
          action === "show"
            ? profileId
            : action === "test" && profileId
              ? profileId
              : opts.backendSpecified
              ? (opts.backend ?? "")
              : undefined,
        environment: process.env,
      });
      selectedProfile = selection.profile;
      if (action === "test") {
        testHelpers = await import("./lib/backend-profile-preflight.mjs");
        report = await testHelpers.testBackendProfile(selection);
      } else {
        report = {
          schemaVersion: 1,
          apiVersion: "dure.backend-profiles/v1",
          kind:
            action === "show"
              ? "dure.backend_profiles.show"
              : "dure.backend_profiles.resolve",
          selection: {
            source: selection.source,
            id: selection.profile.id,
          },
          profile: projectBackendProfile(selection.profile),
        };
      }
    }
    process.stdout.write(
      (opts.json
        ? JSON.stringify(report)
        : action === "test"
          ? testHelpers.formatBackendProfileTestReport(report)
          : formatBackendProfilesReport(report)) +
        "\n",
    );
  } catch (error) {
    const report =
      action === "test" && selectedProfile && testHelpers
        ? testHelpers.backendProfileTestErrorReport(error, selectedProfile)
        : error?.name === "LocalBackendError"
        ? localBackendErrorReport(error)
        : backendProfilesErrorReport(error);
    if (opts.json) {
      process.stdout.write(JSON.stringify(report) + "\n");
    } else {
      process.stderr.write(
        `\x1b[31m${report.error.code}: ${report.error.message}\x1b[0m\n`,
      );
    }
    process.exitCode = 2;
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "environment" || (cmd === "help" && rest[0] === "environment")) {
    const { runEnvironmentCommand } = await import("./lib/environment-command.mjs");
    try {
      process.exitCode = await runEnvironmentCommand(cmd === "help" ? ["--help"] : rest, { resolveBackend: backendProfileQueryContext }) ? 0 : 2;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    }
    return;
  }
  if (cmd === "recovery" || (cmd === "help" && rest[0] === "recovery")) {
    const { runRecoveryCommand } = await import("./lib/recovery-command.mjs");
    try {
      process.exitCode = await runRecoveryCommand(cmd === "help" ? ["--help"] : rest, { resolveBackend: backendProfileQueryContext }) ? 0 : 2;
    } catch (error) {
      fail(error.message);
    }
    return;
  }
  if (cmd === "goal" || (cmd === "help" && rest[0] === "goal")) {
    const { runGoalCommand } = await import("./lib/goal-command.mjs");
    try {
      process.exitCode = await runGoalCommand(cmd === "help" ? ["--help"] : rest, { resolveBackend: backendProfileQueryContext }) ? 0 : 2;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    }
    return;
  }
  if (cmd === "slack" || (cmd === "help" && rest[0] === "slack")) {
    const { runSlackCommand } = await import("./lib/slack-command.mjs");
    try {
      await runSlackCommand(cmd === "help" ? ["--help"] : rest, {
        resolveBackend: backendProfileQueryContext,
        presentRun: async ({ message: _message, ...run }) => {
          const { presentAgentRunRuntime } = await import("./lib/run-presentation.mjs");
          return presentAgentRunRuntime({ ...run, target: { state: "background", windowLabel: "main" }, descriptor: loadServer() });
        },
      });
    } catch {
      process.stderr.write("Slack connector could not start or continue. Check the local configuration, Pro backend and Slack app connection.\n");
      process.exitCode = 2;
    }
    return;
  }
  if (cmd === "github" || (cmd === "help" && rest[0] === "github")) {
    const { runGithubShareCommand } = await import("./lib/github-share-command.mjs");
    return runGithubShareCommand(cmd === "help" ? ["--help"] : rest);
  }
  if (cmd === "browser" || (cmd === "help" && rest[0] === "browser")) {
    const { BROWSER_HELP, collectBrowserCommand } = await import("./lib/browser-command.mjs");
    const separator = rest.indexOf("--");
    const options = separator < 0 ? rest : rest.slice(0, separator);
    if (cmd === "help" || rest.length === 0 || options.includes("--help") || options.includes("-h")) {
      process.stdout.write(`${BROWSER_HELP}\n`);
      return;
    }
    const report = await collectBrowserCommand({ args: rest, resolveBackend: backendProfileQueryContext, sourceEnvironment: process.env });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.ok ? 0 : 2;
    return;
  }
  if (cmd === "quick-commands" || (cmd === "help" && rest[0] === "quick-commands")) {
    const { runQuickCommands } = await import("./lib/quick-commands.mjs");
    try {
      process.stdout.write(`${await runQuickCommands(cmd === "help" ? ["--help"] : rest, loadServer)}\n`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (cmd === "providers" || (cmd === "help" && rest[0] === "providers")) {
    const { runProviderCapabilitiesCommand } = await import("./lib/provider-capabilities.mjs");
    return runProviderCapabilitiesCommand(cmd === "help" ? ["--help"] : rest, CLI_SCRIPT_PATH);
  }
  if (cmd === "runtime" || (cmd === "help" && rest[0] === "runtime")) {
    const { RUNTIME_HELP, collectAgentRuntimeCommand, formatAgentRuntimeCommand } =
      await import("./lib/agent-runtime-command.mjs");
    if (cmd === "help" || rest.length === 0 || rest.some((arg) => arg === "--help" || arg === "-h")) {
      process.stdout.write(`${RUNTIME_HELP}\n`);
      return;
    }
    const opts = parseOpts(rest);
    const report = await collectAgentRuntimeCommand({
      args: opts.rest,
      resolveBackend: () => backendProfileQueryContext(opts),
      requestId: opts.idempotencyKey,
      operationId: opts.operationId,
      conversationId: opts.conversationId,
      ...(opts.expectedRevision === undefined ? {} : { expectedRevision: Number(opts.expectedRevision) }),
      ...(opts.deadlineMs === undefined ? {} : { deadlineMs: Number(opts.deadlineMs) }),
    });
    process.stdout.write(`${opts.json ? JSON.stringify(report) : formatAgentRuntimeCommand(report)}\n`);
    process.exitCode = report.ok ? 0 : 2;
    return;
  }
  if (cmd === "send-keys" || (cmd === "help" && rest[0] === "send-keys")) {
    const { runSendKeysCommand } = await import("./lib/send-keys-command.mjs");
    return await runSendKeysCommand(cmd === "help" ? ["--help"] : rest, {
      loadRegistry: loadRegistryOptional, hmuxCommand,
    });
  }
  if (cmd === "wait" || (cmd === "help" && rest[0] === "wait")) {
    const { runWaitCommand } = await import("./lib/wait-command.mjs");
    const { loadSessionClientProjection } = await import("./lib/client-registry.mjs");
    const interruption = captureInterruption();
    try {
      process.exitCode = await runWaitCommand(cmd === "help" ? ["--help"] : rest, {
        hmuxCommand: hmuxCommand(), signal: interruption.signal,
        resolveContext: async (options) => options.subject === "response"
          ? sessionQueryContext(options, loadSessionClientProjection)
          : { backend: await backendProfileQueryContext(options) },
      });
    } finally {
      interruption.dispose();
    }
    return;
  }
  if (cmd === "send" || (cmd === "help" && rest[0] === "send")) {
    const { runSendCommand } = await import("./lib/send-command.mjs");
    return await runSendCommand(cmd === "help" ? ["--help"] : rest, {
      parseOptions: parseOpts,
      loadRegistry,
      resolveAgent: resolve,
      send: sendText,
      fail,
    });
  }
  if (cmd === "help" && rest[0] === "whoami") {
    process.stdout.write(WHOAMI_HELP + "\n");
    return;
  }
  if (cmd === "help" && rest[0] === "workflow") {
    process.stdout.write(WORKFLOW_HELP + "\n");
    return;
  }
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    process.stdout.write(HELP + "\n");
    return;
  }
  if (
    (cmd === "run" ||
      (cmd === "spawn" &&
        !["preview", "apply", "status"].includes(rest[0]))) &&
    rest.some((argument) => argument === "--help" || argument === "-h")
  ) {
    process.stdout.write(`${RUN_HELP}\n`);
    return;
  }
  if (
    (cmd === "checkpoint" || cmd === "comment") &&
    !rest.includes("--hook-json")
  ) {
    // Retired 2026-08-27. Exit 0 so agents mid-flight on older hook
    // instructions never see a failure; humans get one stderr line. Hook
    // invocations fall through to the JSON no-op below — Gemini requires
    // parseable stdout.
    process.stderr.write(
      "dure checkpoint has been retired. Dure attention indicators now provide status.\n",
    );
    return;
  }
  if ((cmd === "orch" || cmd === "orchestration") && rest[0] === "events-canary") {
    const { runEventCanaryCommand } = await import("./lib/orchestration-event-canary.mjs");
    process.exitCode = await runEventCanaryCommand(rest.slice(1), CLI_SCRIPT_PATH);
    return;
  }
  if (cmd === "client") return await cmdClient(rest);
  let opts;
  opts = cmd === "workflow" ? parseWorkflowOpts(rest) : parseOpts(rest);
  if (
    cmd === "whoami" &&
    (opts.rest[0] === "help" || opts.rest[0] === "-h" || opts.rest[0] === "--help")
  ) {
    process.stdout.write(WHOAMI_HELP + "\n");
    return;
  }
  // 레지스트리(앱이 기록)가 필요 없는 명령 — 앱이 한 번도 안 돌았어도 동작
  if (cmd === "version" || cmd === "--version") return cmdVersion(opts);
  if (cmd === "backend" || cmd === "server") {
    return await cmdBackend(opts.rest[0], opts);
  }
  if (
    (cmd === "orch" || cmd === "orchestration") &&
    (opts.rest[0] === "status" || opts.rest[0] === "health")
  ) {
    return cmdOrchestrationStatus(opts.rest[0], opts);
  }
  if (
    (cmd === "orch" || cmd === "orchestration") &&
    opts.rest[0] === "invoke"
  ) {
    return await cmdOrchestrationInvoke(opts);
  }
  if (cmd === "orch" || cmd === "orchestration") {
    return cmdOrch(opts.rest[0]);
  }
  if (cmd === "diagnostics") return await cmdDiagnostics(opts);
  if (cmd === "profiles") return await cmdProfiles(opts);
  if (cmd === "integration") return await cmdIntegration(opts.rest[0], opts);
  if (cmd === "skills") return cmdSkills(null, opts.rest[0], opts);
  if (cmd === "computer") return cmdComputer(null, opts.rest[0], opts);
  if (cmd === "hmux") return await cmdHmux(opts.rest[0], opts);
  if (cmd === "perf") return await cmdPerf(opts.rest[0], opts);
  if (cmd === "ls" || cmd === "list") return await cmdLs(opts);
  if (cmd === "sessions") return await cmdSessions(opts.rest[0], opts);
  if (cmd === "inspect") {
    return await cmdSessions("show", { ...opts, rest: ["show", ...opts.rest] });
  }
  if (cmd === "projects") return await cmdProjects(opts.rest[0], opts);
  if (cmd === "schedule" || cmd === "schedules") {
    return await cmdSchedule(opts.rest[0], opts);
  }
  if (cmd === "auto" || cmd === "automations") {
    fail(
      "dure auto has been retired. Use dure schedule instead of file-based automations.json.",
    );
  }
  if (cmd === "provider-defaults") {
    return await cmdProviderLaunchDefaults(opts.rest[0], opts);
  }
  if (cmd === "run") return await cmdRun(opts);
  if (
    cmd === "spawn" &&
    (opts.rest[0] === "preview" ||
      opts.rest[0] === "apply" ||
      opts.rest[0] === "status")
  ) {
    return await cmdAgentSpawn(opts.rest[0], opts);
  }
  if (cmd === "spawn") {
    process.stderr.write(
      "dure spawn is deprecated. Use dure run, which uses the same backend Run.\n",
    );
    return await cmdRun(opts, { legacySpawn: true });
  }
  if (cmd === "workflow") return await cmdWorkflow(opts.rest[0], opts);
  if (cmd === "spaces") return await cmdSpaces(opts.rest[0], opts);
  if (cmd === "workspace") return await cmdWorkspace(opts);
  if (cmd === "__ssh") return await cmdInternalSsh(rest);
  if (cmd === "install") return await cmdInstall(opts);
  if (cmd === "doctor") return await cmdDoctor(opts);
  if (cmd === "hooks") return cmdHooks(opts.rest[0], opts);
  if (cmd === "feedback") {
    // Never needs the app registry — this is the one thing an agent should
    // be able to do even when the app has never run.
    const { runFeedbackCommand, classifyFeedbackArgs, formatFeedbackError } = await import(
      "./lib/feedback-command.mjs"
    );
    // Classified against the RAW argv (`rest`), not `opts` — parseOpts has
    // already consumed the evidence of a disallowed or misplaced flag by
    // the time `opts` exists. The only options are feedback's own
    // (--kind/--contact/--json/--yes/--help/-h); any other flag-shaped
    // token is rejected wherever it appears, and an own flag after the
    // first positional word is rejected too, instead of being silently
    // swallowed (or, for --help/-h, silently discarding the report while
    // printing usage instead). A backstop also confirms the scan's own
    // idea of "the text" agrees with parseOpts's actual result. See
    // classifyFeedbackArgs's doc comment.
    const classified = classifyFeedbackArgs(rest);
    if (classified.outcome === "help") {
      process.stdout.write(`${HELP}\n`);
      return;
    }
    if (classified.outcome === "error") {
      const message =
        classified.token !== undefined
          ? `Unrecognized flag "${classified.token}" for dure feedback: options must come before the text and must be one of --kind, --contact, --json, --yes, --help. If this is meant to be feedback text, put your text after a literal "--", or pipe it via stdin.`
          : "dure feedback's argument scan and the shared parser disagree about the feedback text — refusing to send a possibly corrupted report. This is an internal inconsistency; please report it.";
      process.stderr.write(formatFeedbackError(message, opts.json));
      process.exitCode = 2;
      return;
    }
    process.exitCode = await runFeedbackCommand(opts);
    return;
  }
  if ((cmd === "checkpoint" || cmd === "comment") && opts.hookJson) {
    // Checkpoint feature retired 2026-08-27 — the line was never read, and
    // agent self-narration duplicates the attention authority. Registered
    // SessionStart hooks keep calling this until uninstalled; a valid no-op
    // JSON keeps every provider quiet (Gemini requires parseable stdout).
    process.stdout.write("{}\n");
    return;
  }
  if (cmd === "read") {
    await cmdRead(opts.rest[0], opts);
    return;
  }
  if (cmd === "transcript") {
    await cmdTranscript(opts.rest[0], opts);
    return;
  }
  if (cmd === "attach") return await cmdAttach(opts);
  const reg = loadRegistry();
  switch (cmd) {
    case "logs":
      await cmdLogs(reg, resolve(reg, opts.rest[0]), opts.lines || 2000);
      break;
    case "enter": {
      // 이미 입력창에 떠 있는 프롬프트를 제출한다(빈 텍스트 + Enter).
      // 관리형 에이전트에서 spawn/전달이 Enter를 빠뜨렸을 때의 구제책.
      const agent = resolve(reg, opts.rest[0]);
      await sendText(
        reg,
        agent,
        "",
        true,
        opts.windowLabel,
        opts.idempotencyKey,
      );
      process.stdout.write(`\x1b[32m✓\x1b[0m Sent Enter to ${agent.name}\n`);
      break;
    }
    case "whoami":
    case "name":
      cmdWhoami(reg, opts);
      break;
    case "skills":
      cmdSkills(reg, opts.rest[0], opts);
      break;
    case "computer":
      cmdComputer(reg, opts.rest[0], opts);
      break;
    default:
      fail(`Unknown command: ${cmd}\n\n${HELP}`);
  }
}

await main();
