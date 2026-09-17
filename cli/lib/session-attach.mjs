import { spawn } from "node:child_process";
import { runBoundedCommand } from "./bounded-command.mjs";
import { supportsHmuxCapability } from "./runtime-diagnostics.mjs";
import { collectSessionQuery } from "./session-query.mjs";

export const MANAGED_ATTACH_HMUX_CAPABILITY = "managed_interactive_attach_v1";
export const SSH_MANAGED_ATTACH_HMUX_CAPABILITY =
  "ssh_managed_interactive_attach_v1";
const CAPABILITY_TIMEOUT_MS = 2_500;
const CAPABILITY_OUTPUT_BYTES = 64 * 1024;

const ATTACH_ERROR_MESSAGES = Object.freeze({
  dure_attach_argument_invalid:
    "usage: dure attach <session-id> --workspace <workspace-id> [--backend ID]",
  dure_attach_hmux_failed: "the Hmux interactive attachment failed",
  dure_attach_hmux_incompatible:
    "the selected Hmux executable cannot provide this attachment",
  dure_attach_hmux_unavailable: "the Hmux executable is unavailable",
  dure_attach_legacy_target_unsupported:
    "dure attach accepts managed Hmux sessions; use hmux attach for a standalone shell",
  dure_attach_session_not_live:
    "the selected managed Hmux session is not a healthy live generation",
  dure_attach_session_unavailable: "the exact Hmux session could not be resolved",
  dure_attach_transport_unsupported:
    "the selected backend transport cannot carry an Hmux attachment",
});

export class SessionAttachError extends Error {
  constructor(code, options = {}) {
    super(ATTACH_ERROR_MESSAGES[code] ?? "the Hmux attachment failed", options);
    this.code = code;
    this.details = options.details;
    this.name = "SessionAttachError";
  }
}

function fail(code, options) {
  throw new SessionAttachError(code, options);
}

function exactFence(session) {
  const generation = session.runtime.generation;
  return {
    workspace_id: session.workspaceId,
    session_id: session.sessionId,
    runner_principal: generation.runnerPrincipal,
    runner_instance: generation.runnerInstance,
    channel_epoch: generation.channelEpoch,
    host_instance_id: generation.hostInstanceId,
    terminal_epoch: generation.terminalEpoch,
  };
}

function localArgv(hmuxCommand, session) {
  return [
    hmuxCommand,
    "managed-attach",
    session.sessionId,
    "--workspace",
    session.workspaceId,
  ];
}

function remoteArgv(hmuxCommand, session, backend) {
  const profile = backend.profile;
  let references;
  try {
    references = backend.transportOptions.resolveSshReferences({
      auth: { ...profile.auth },
      profileId: profile.id,
      trust: { ...profile.trust },
    }).pin();
  } catch (cause) {
    fail("dure_attach_transport_unsupported", { cause });
  }
  if (
    !references?.knownHostsFile ||
    (profile.auth.kind === "identity_file" && !references.identityFile) ||
    (profile.auth.kind !== "identity_file" && profile.auth.kind !== "ssh_agent")
  ) {
    references?.dispose();
    fail("dure_attach_transport_unsupported");
  }
  return {
    references,
    argv: [
      hmuxCommand,
      "remote-managed-attach",
      session.sessionId,
      "--workspace",
      session.workspaceId,
      "--host",
      profile.transport.host,
      "--port",
      String(profile.transport.port),
      "--user",
      profile.transport.user,
      "--connect-timeout-ms",
      String(profile.transport.connectTimeoutMs),
      ...(profile.auth.kind === "identity_file"
        ? ["--identity-file", references.identityFile]
        : ["--ssh-agent"]),
      "--known-hosts-file",
      references.knownHostsFile,
      "--expected-fence-json",
      JSON.stringify(exactFence(session)),
    ],
  };
}

function attachArgv(hmuxCommand, session, backend) {
  if (!backend || backend.profile.transport.kind === "local") {
    return { argv: localArgv(hmuxCommand, session) };
  }
  if (backend.profile.transport.kind === "ssh") {
    return remoteArgv(hmuxCommand, session, backend);
  }
  fail("dure_attach_transport_unsupported");
}

function requiredCapability(backend) {
  return backend?.profile?.transport.kind === "ssh"
    ? SSH_MANAGED_ATTACH_HMUX_CAPABILITY
    : MANAGED_ATTACH_HMUX_CAPABILITY;
}

async function requireAttachCapability(hmuxCommand, backend, execute) {
  const capability = requiredCapability(backend);
  const result = await execute([hmuxCommand, "capabilities", "--json"], {
    maxCaptureBytes: CAPABILITY_OUTPUT_BYTES,
    timeoutMs: CAPABILITY_TIMEOUT_MS,
  });
  if (result.kind === "unavailable") {
    fail("dure_attach_hmux_unavailable");
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout || "");
  } catch {}
  if (
    result.kind !== "success" ||
    !supportsHmuxCapability(payload, capability)
  ) {
    fail("dure_attach_hmux_incompatible", { details: { capability } });
  }
}

function runInteractive(argv, spawnProcess) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(argv[0], argv.slice(1), { stdio: "inherit" });
    } catch (cause) {
      reject(new SessionAttachError("dure_attach_hmux_unavailable", { cause }));
      return;
    }
    let spawnFailure;
    child.once("error", (cause) => {
      spawnFailure = cause;
    });
    child.once("close", (code, signal) => {
      if (spawnFailure) {
        reject(new SessionAttachError("dure_attach_hmux_unavailable", {
          cause: spawnFailure,
        }));
        return;
      }
      if (signal) {
        reject(
          new SessionAttachError("dure_attach_hmux_failed", {
            details: { signal },
          }),
        );
        return;
      }
      if (code === 0) resolve();
      else {
        reject(
          new SessionAttachError("dure_attach_hmux_failed", {
            details: { exitCode: code ?? 1 },
          }),
        );
      }
    });
  });
}

export async function attachManagedSession({
  backend = null,
  hmuxCommand = "hmux",
  sessionId,
  execute = runBoundedCommand,
  spawnProcess = spawn,
  workspaceId,
}) {
  if (!sessionId || !workspaceId) fail("dure_attach_argument_invalid");
  await requireAttachCapability(hmuxCommand, backend, execute);
  const report = await collectSessionQuery({
    action: "show",
    backend,
    hmuxCommand,
    sessionId,
    workspaceId,
    execute,
  });
  if (report.kind !== "dure.sessions.show") {
    fail("dure_attach_session_unavailable", {
      details: { reason: report.error?.code ?? "unknown" },
    });
  }
  const session = report.session;
  if (session.runtime.sessionClass !== "managed") {
    fail("dure_attach_legacy_target_unsupported");
  }
  if (
    session.liveness.health !== "healthy" ||
    session.liveness.exactGeneration !== true
  ) {
    fail("dure_attach_session_not_live");
  }
  const attachment = attachArgv(hmuxCommand, session, backend);
  try {
    await runInteractive(attachment.argv, spawnProcess);
  } finally {
    attachment.references?.dispose();
  }
}

export function formatSessionAttachError(error) {
  const typed =
    error instanceof SessionAttachError
      ? error
      : new SessionAttachError("dure_attach_hmux_failed", { cause: error });
  const detail = typed.details?.reason ?? typed.details?.capability;
  return `${typed.code}: ${typed.message}${detail ? ` (${detail})` : ""}`;
}
