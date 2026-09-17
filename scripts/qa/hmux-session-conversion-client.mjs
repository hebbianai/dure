import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveQaLogPath } from "./lib/qa-log-receipt.mjs";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cli = required("DURE_QA_HMUX_CLI");
const runtime = required("DURE_HMUX_RUNTIME_BIN");
const codex = required("HEBBIAN_QA_CODEX_BIN");
const claude = required("HEBBIAN_QA_CLAUDE_BIN");
const discoveryRoot = required("HMUX_DISCOVERY_ROOT");
const stateRoot = required("DURE_QA_STATE_ROOT");
const homeSetup = JSON.parse(
  readFileSync(path.join(stateRoot, "conversion-home-setup.json"), "utf8"),
);
if (
  homeSetup?.schema !== 1 ||
  homeSetup?.ok !== true ||
  homeSetup?.profile !== "codex-selected" ||
  !Array.isArray(homeSetup?.sharedDirectories) ||
  !Array.isArray(homeSetup?.appendFiles) ||
  homeSetup.project !== path.join(stateRoot, "project")
) {
  throw new Error("conversion home setup receipt is invalid");
}
const project = homeSetup.project;
const qaLog = resolveQaLogPath();
const qaCodexHome = path.join(process.env.HOME, ".codex");
const qaClaudeHome = path.join(process.env.HOME, ".claude");
const serverPath = required("DURE_QA_SERVER_DESCRIPTOR");
const managedClaudeSettingsPath = path.join(
  path.dirname(serverPath),
  "managed-claude-settings.json",
);
const name = `conversion-smoke-${process.pid}`;
let sourceSessionId;
let replacementSessionId;
let promotedPanelId;
let managedShellSessionId;
let managedShellReplacementSessionId;
let managedShellPanelId;
let managedShellPromotedPanelId;

function runHmux(args, options = {}) {
  const result = spawnSync(
    cli,
    ["--discovery-root", discoveryRoot, ...args],
    {
      cwd: project,
      encoding: "utf8",
      timeout: options.timeout ?? 30_000,
      env: process.env,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `hmux ${args.join(" ")} failed (${result.status}): ${
        result.stderr || result.stdout
      }`,
    );
  }
  return result.stdout;
}

function sessionJson(identifier) {
  return JSON.parse(
    runHmux(["--json", "session", "show", identifier]),
  );
}

function qaLogPayload(line) {
  const boundary = line.indexOf("] ");
  if (boundary < 0) throw new Error(`invalid QA log line: ${line}`);
  return JSON.parse(line.slice(boundary + 2));
}

async function waitFor(description, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for ${description}${
      lastError ? `: ${String(lastError)}` : ""
    }`,
  );
}

async function post(route, payload) {
  const server = JSON.parse(readFileSync(serverPath, "utf8"));
  const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${server.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(
      `${route} failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }
  return body;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function hmuxExpectedFenceJson(sessionId, workspaceId, stopFence) {
  return JSON.stringify({
    workspace_id: workspaceId,
    session_id: sessionId,
    runner_principal: stopFence.runnerPrincipal,
    runner_instance: stopFence.runnerInstance,
    channel_epoch: stopFence.channelEpoch,
    host_instance_id: stopFence.hostInstanceId,
    terminal_epoch: stopFence.terminalEpoch,
  });
}

async function convertProviderPane({
  sourceSessionId,
  workspaceId,
  paneId,
  sourceRuntime,
  description,
}) {
  const preview = await waitFor(
    `${description} exact Codex conversion preview`,
    async () => {
      const response = await post("/hmux/convert", {
        name: sourceSessionId,
        targetPanelId: paneId,
        to: "managed",
      });
      return response?.preview === true ? response : false;
    },
    90_000,
  );
  const conversationId = preview.conversion?.conversationId;
  if (
    !conversationId ||
    preview.source?.runtime !== sourceRuntime ||
    preview.source?.workspaceId !== workspaceId
  ) {
    throw new Error(
      `${description} preview lost its source or conversation identity: ${JSON.stringify(preview)}`,
    );
  }
  const sourceAfterPreview = sessionJson(sourceSessionId);
  if (
    sourceAfterPreview.lifecycle !== "ready" ||
    sourceAfterPreview.workspace_id !== workspaceId
  ) {
    throw new Error(`${description} preview changed the source session`);
  }

  const converted = await post("/hmux/convert", {
    name: sourceSessionId,
    targetPanelId: paneId,
    to: "managed",
    confirmRestart: true,
  });
  if (
    converted.conversion?.outcome !== "converted" ||
    converted.conversion?.conversationId !== conversationId ||
    converted.pane?.runtime !== "hmux_managed_v1" ||
    converted.pane?.panelId !== paneId
  ) {
    throw new Error(
      `unexpected ${description} conversion receipt: ${JSON.stringify(converted)}`,
    );
  }
  const replacement = sessionJson(converted.pane.sessionId);
  if (
    replacement.lifecycle !== "ready" ||
    replacement.session_class !== "managed"
  ) {
    throw new Error(
      `${description} managed replacement is not healthy: ${JSON.stringify(replacement)}`,
    );
  }
  return { conversationId, converted };
}

function containsRollout(directory) {
  if (!existsSync(directory)) return false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory() && containsRollout(child)) return true;
    if (entry.isFile() && entry.name.endsWith(".jsonl")) return true;
  }
  return false;
}

try {
  // Keep the existing official hook probe inside the client's owned process
  // tree and disposable data root, before starting conversion conversations.
  const hookProbe = spawnSync(process.execPath, [
    path.resolve("scripts/qa/managed-claude-hook-channel-handoff-smoke.mjs"),
  ], { encoding: "utf8", env: { ...process.env, TMPDIR: stateRoot }, timeout: 120_000 });
  if (hookProbe.status !== 0) {
    throw new Error(`channel handoff hook probe failed: ${hookProbe.error || hookProbe.stderr || hookProbe.stdout}`);
  }
  process.stdout.write(hookProbe.stdout);
  await waitFor(
    "QA project registration",
    () => {
      if (!existsSync(qaLog)) return false;
      const log = readFileSync(qaLog, "utf8");
      return (
        log.includes('"hmuxconversion-project"') &&
        log.includes('"ready":true')
      );
    },
    180_000,
  );
  await waitFor("managed Claude settings", () =>
    existsSync(managedClaudeSettingsPath),
  );
  for (const canonicalPath of [
    path.join(process.env.HOME, ".claude", "settings.json"),
    path.join(process.env.HOME, ".codex", "hooks.json"),
    path.join(process.env.HOME, ".kimi", "config.toml"),
  ]) {
    if (existsSync(canonicalPath)) {
      throw new Error(`app mutated canonical provider settings: ${canonicalPath}`);
    }
  }
  const managedClaudeSettings = JSON.parse(
    readFileSync(managedClaudeSettingsPath, "utf8"),
  );
  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "Notification",
  ]) {
    const handler = managedClaudeSettings.hooks?.[event]?.[0]?.hooks?.[0];
    if (
      handler?.type !== "command" ||
      !handler.command?.endsWith("/managed-claude-hook-v2.sh") ||
      JSON.stringify(handler.args) !==
        JSON.stringify(["claude", "--managed-direct", "--terminal-events"]) ||
      handler.url ||
      handler.headers
    ) {
      throw new Error(`invalid managed Claude ${event} hook`);
    }
  }
  mkdirSync(qaClaudeHome, { recursive: true, mode: 0o700 });
  const userClaudeHookMarker = path.join(
    process.env.HOME,
    "user-claude-session-start-hook-ran",
  );
  const userClaudeSettingsPath = path.join(qaClaudeHome, "settings.json");
  const userClaudeSettings = `${JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `/usr/bin/touch ${JSON.stringify(userClaudeHookMarker)}`,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
  writeFileSync(userClaudeSettingsPath, userClaudeSettings, {
    encoding: "utf8",
    mode: 0o600,
  });
  const claudeHookProbe = spawnSync(
    claude,
    ["--settings", managedClaudeSettingsPath, "--init-only"],
    {
      cwd: project,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HMUX_SESSION_ID: "managed-claude-probe",
        HMUX_WORKSPACE_ID: "managed-claude-workspace",
        HMUX_RUNNER_PRINCIPAL: "local-user",
        HMUX_RUNNER_INSTANCE: "runner-probe",
        HMUX_CHANNEL_EPOCH: "1",
        HMUX_HOST_INSTANCE_ID: "host-probe",
        HMUX_TERMINAL_EPOCH: "terminal-probe",
      },
    },
  );
  if (claudeHookProbe.status !== 0) {
    throw new Error(
      `managed Claude SessionStart probe failed (${claudeHookProbe.status}): ${
        claudeHookProbe.stderr || claudeHookProbe.stdout
      }`,
    );
  }
  if (!existsSync(userClaudeHookMarker)) {
    throw new Error("managed Claude launch replaced the user's SessionStart hook");
  }
  if (readFileSync(userClaudeSettingsPath, "utf8") !== userClaudeSettings) {
    throw new Error("managed Claude launch mutated the user's settings");
  }

  process.env.CODEX_HOME = qaCodexHome;
  const initialLaunchMarker = path.join(
    process.env.HOME,
    ".dure",
    ".qa-managed-launch-ready",
  );
  writeFileSync(initialLaunchMarker, "ready\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  const managedLaunchLine = await waitFor(
    "default and selected-account initial managed launches",
    () => {
      if (!existsSync(qaLog)) return false;
      return (
        readFileSync(qaLog, "utf8")
          .split("\n")
          .find((line) => line.includes('"hmuxcredential-launches"')) || false
      );
    },
    180_000,
  );
  if (
    !managedLaunchLine.includes('"ok":true') ||
    !managedLaunchLine.includes('"kind":"default"') ||
    !managedLaunchLine.includes('"kind":"selected"')
  ) {
    throw new Error(
      `initial managed credential launch probe failed: ${managedLaunchLine}`,
    );
  }
  const crossBindingLine = await waitFor(
    "two-pane managed credential switch",
    () => {
      if (!existsSync(qaLog)) return false;
      return (
        readFileSync(qaLog, "utf8")
          .split("\n")
          .find((line) => line.includes('"hmuxcredential-crossbind"')) || false
      );
    },
    240_000,
  );
  const [crossBindingEvent, crossBinding] = qaLogPayload(crossBindingLine);
  if (
    crossBindingEvent !== "hmuxcredential-crossbind" ||
    crossBinding?.ok !== true
  ) {
    throw new Error(
      `managed credential cross-binding probe failed: ${crossBindingLine}`,
    );
  }

  const created = JSON.parse(
    runHmux([
      "--json",
      "new",
      "--name",
      name,
      "--runtime",
      runtime,
      "--",
      codex,
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
      "Reply exactly HMUX_CONVERSION_READY and do not run tools.",
    ]),
  );
  sourceSessionId = created.sessionId;
  const workspaceId = created.workspaceId;
  await waitFor("standalone Codex Host readiness", () => {
    const source = sessionJson(sourceSessionId);
    return source.lifecycle === "ready" && source.session_class === "standalone";
  });
  try {
    await waitFor(
      "Codex rollout creation after the smoke prompt",
      () => containsRollout(path.join(qaCodexHome, "sessions")),
      30_000,
    );
  } catch (error) {
    const screen = runHmux(["read", sourceSessionId, "-n", "30"]);
    throw new Error(`${String(error)}\nCodex screen:\n${screen}`);
  }

  const attach = await post("/hmux/attach", {
    name,
    cwd: project,
  });
  const paneId = attach.pane?.panelId;
  if (
    typeof paneId !== "string" || !paneId ||
    attach.pane?.sessionId !== sourceSessionId ||
    attach.pane?.workspaceId !== workspaceId ||
    attach.pane?.runtime !== "hmux_standalone_v1"
  ) {
    throw new Error(`unexpected standalone pane: ${JSON.stringify(attach)}`);
  }

  const managedShell = await post("/pane/create", {
    referenceSessionId: sourceSessionId,
    referencePanelId: paneId,
    direction: "right",
    cwd: project,
  });
  if (
    managedShell.pane?.runtime !== "hmux_managed_v1" ||
    managedShell.pane?.binding?.workspaceId !== "dure-local-shells-v1" ||
    !managedShell.pane?.binding?.stopFence
  ) {
    throw new Error(
      `unexpected managed shell pane: ${JSON.stringify(managedShell)}`,
    );
  }
  managedShellSessionId = managedShell.pane.sessionId;
  managedShellPanelId = managedShell.pane.panelId;
  runHmux([
    "--json",
    "command-input",
    "--target",
    managedShellSessionId,
    "--workspace",
    managedShell.pane.binding.workspaceId,
    "--expected-fence-json",
    hmuxExpectedFenceJson(
      managedShellSessionId,
      managedShell.pane.binding.workspaceId,
      managedShell.pane.binding.stopFence,
    ),
    "--text",
    [
      shellQuote(codex),
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
      shellQuote(
        "Reply exactly HMUX_MANAGED_SHELL_CONVERSION_READY and do not run tools.",
      ),
    ].join(" "),
    "--submit",
  ]);

  // Provider discovery and the open Codex rollout can lag Host readiness.
  const standaloneConversion = await convertProviderPane({
    sourceSessionId,
    workspaceId,
    paneId,
    sourceRuntime: "hmux_standalone_v1",
    description: "standalone",
  });
  const { conversationId, converted } = standaloneConversion;
  replacementSessionId = converted.pane.sessionId;
  promotedPanelId = converted.pane.panelId;

  const stop = await post("/hmux/stop", {
    name: replacementSessionId,
    targetPanelId: promotedPanelId,
    confirm: true,
  });
  if (!["stopped", "already_exited"].includes(stop.stop?.stopReceipt?.outcome)) {
    throw new Error(`managed cleanup failed: ${JSON.stringify(stop)}`);
  }
  replacementSessionId = undefined;

  const managedShellConversion = await convertProviderPane({
    sourceSessionId: managedShellSessionId,
    workspaceId: managedShell.pane.binding.workspaceId,
    paneId: managedShellPanelId,
    sourceRuntime: "hmux_managed_v1",
    description: "managed local shell",
  });
  managedShellReplacementSessionId =
    managedShellConversion.converted.pane.sessionId;
  managedShellPromotedPanelId = managedShellConversion.converted.pane.panelId;
  const managedShellStop = await post("/hmux/stop", {
    name: managedShellReplacementSessionId,
    targetPanelId: managedShellPromotedPanelId,
    confirm: true,
  });
  if (
    !["stopped", "already_exited"].includes(
      managedShellStop.stop?.stopReceipt?.outcome,
    )
  ) {
    throw new Error(
      `managed-shell conversion cleanup failed: ${JSON.stringify(managedShellStop)}`,
    );
  }
  managedShellReplacementSessionId = undefined;

  process.stdout.write(
    JSON.stringify({
      ok: true,
      sourceSessionId,
      managedSessionId: converted.pane.sessionId,
      conversationId,
      paneId: promotedPanelId,
      managedShellSessionId,
      managedShellManagedSessionId:
        managedShellConversion.converted.pane.sessionId,
      managedShellConversationId: managedShellConversion.conversationId,
      managedShellPaneId: managedShellPromotedPanelId,
      assertions: [
        "preview_non_mutating",
        "canonical_provider_settings_untouched",
        "existing_claude_hooks_preserved",
        "managed_claude_session_start_channel_handoff_hook",
        "managed_initial_default_account",
        "managed_initial_selected_account",
        "managed_credential_target_pane_preserved",
        "managed_credential_exact_conversation_preserved",
        "managed_credential_sibling_generation_untouched",
        "exact_conversation_preserved",
        "managed_local_shell_exact_conversation_preserved",
        "managed_local_shell_pane_promoted_to_agent",
        "managed_local_shell_pane_identity_preserved",
        "managed_replacement_ready",
        "pane_promoted_to_agent",
        "pane_identity_preserved",
        "managed_cleanup_confirmed",
      ],
    }) + "\n",
  );
} finally {
  if (managedShellReplacementSessionId && managedShellPromotedPanelId) {
    await post("/hmux/stop", {
      name: managedShellReplacementSessionId,
      targetPanelId: managedShellPromotedPanelId,
      confirm: true,
    }).catch(() => {});
  }
  if (replacementSessionId && promotedPanelId) {
    await post("/hmux/stop", {
      name: replacementSessionId,
      targetPanelId: promotedPanelId,
      confirm: true,
    }).catch(() => {});
  }
  if (sourceSessionId) {
    try {
      runHmux(["kill", sourceSessionId], { timeout: 10_000 });
    } catch {
      // A successful conversion retires the standalone source, so the
      // standalone-only kill command is expected to refuse it.
    }
  }
}
