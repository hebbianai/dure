import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_PARENT_RELOAD_TIMEOUT_MS,
  DEFAULT_RESTART_SETTLEMENT_TIMEOUT_MS,
  DEV_LAUNCH_COLD_BOOTSTRAP_REQUIRED,
  DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
  DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE,
  DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
  DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
  LEGACY_DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  MAX_STATUS_CONNECTION_FAILURES,
  PARENT_RELOAD_CAPABILITY,
  RESTART_STATUS_POLL_MS,
  RESTART_STATUS_REQUEST_TIMEOUT_MS,
  RESTART_SETTLEMENT_RECOVERY_MS,
  TERMINAL_ACK_CONNECTION_TIMEOUT_MS,
  isPreparingParentReloadSuccessor,
  parentReloadReceiptFromDescriptor,
  parseDevLaunchGeneration,
  parseDevLaunchHmuxProviderIdentity,
  parseDevLaunchIdentity,
  parentGenerationProbeRequest,
  parseDevLaunchRestartReceipt,
  parseDevLaunchV2Envelope,
  randomIdentity,
  responseProtocolMatches,
  sameDevLaunchIdentity,
  sameOptionalDevLaunchIdentity,
  validateParentGenerationFrame,
} from "./dev-launch-contract.mjs";
import { observeProcessLiveness } from "./process-identity.mjs";
import {
  assertOwnerOnlyDirectory,
  createDescriptor,
  descriptorPath,
  isOwner,
  readDescriptor,
  safeLstat,
  writeDescriptor,
} from "./dev-launch-storage.mjs";

function assertOwnerOnlySocket(pathname) {
  if (process.platform === "win32") return;
  const stat = safeLstat(pathname);
  if (
    !stat ||
    stat.isSymbolicLink() ||
    !stat.isSocket() ||
    !isOwner(stat) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error(`dev launch supervisor socket is unsafe: ${pathname}`);
  }
}

function socketPathFor(worktreeRoot, channel, generation) {
  const digest = createHash("sha256")
    .update(`${worktreeRoot}\0${channel}\0${generation}`)
    .digest("hex")
    .slice(0, 24);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\dure-dev-launch-${digest}`;
  }
  const uid = process.getuid ? process.getuid() : "user";
  return `/tmp/dure-dev-launch-${uid}-${digest}.sock`;
}

function connectForFrame({
  socketPath,
  frame,
  timeoutMs,
  timeoutAfterConnect = false,
}) {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socketPath);
    let requestSent = false;
    let settled = false;
    let body = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      if (error) {
        error.devLaunchRequestSent = requestSent;
        reject(error);
      }
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error("dev launch supervisor request timed out")),
      timeoutMs,
    );
    connection.setEncoding("utf8");
    connection.once("connect", () => {
      // The exact supervisor owns restart completion after admission. Its
      // prerequisites may legitimately take minutes and continue even if this
      // client disconnects. Legacy v1 therefore bounds only endpoint
      // connection; v2 admission and status frames retain a response deadline.
      if (!timeoutAfterConnect) clearTimeout(timer);
      requestSent = true;
      connection.write(`${JSON.stringify(frame)}\n`);
    });
    connection.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_FRAME_BYTES) {
        finish(new Error("dev launch supervisor response is too large"));
        return;
      }
      const newline = body.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(null, JSON.parse(body.slice(0, newline)));
      } catch (error) {
        finish(
          new Error(`invalid dev launch supervisor response: ${error.message}`),
        );
      }
    });
    connection.once("error", (error) => finish(error));
    connection.once("end", () => {
      if (!settled) finish(new Error("dev launch supervisor closed without a receipt"));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function parentGenerationEndpointMatches(descriptor, timeoutMs) {
  let response;
  try {
    response = await connectForFrame({
      socketPath: descriptor.socketPath,
      frame: parentGenerationProbeRequest(descriptor),
      timeoutMs,
      timeoutAfterConnect: true,
    });
  } catch {
    return false;
  }
  try {
    validateParentGenerationFrame(response, descriptor);
  } catch (error) {
    const unavailable = new Error(error.message);
    unavailable.code = DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE;
    throw unavailable;
  }
  return true;
}

function restartRejection(receipt, request, protocolVersion) {
  if (
    !responseProtocolMatches(receipt, protocolVersion) ||
    receipt.requestId !== request.requestId
  ) {
    return new Error("dev launch supervisor rejection does not match request");
  }
  const rejected = new Error(
    typeof receipt.reason === "string"
      ? receipt.reason
      : "dev launch supervisor rejected restart",
  );
  rejected.destructiveBoundaryCrossed =
    receipt.destructiveBoundaryCrossed === true
      ? true
      : receipt.destructiveBoundaryCrossed === false
        ? false
        : null;
  rejected.restartRequestId = request.requestId;
  return rejected;
}

function validateReceiptEnvelope(receipt, request, descriptor) {
  let normalized;
  try {
    normalized = parseDevLaunchRestartReceipt(receipt, {
      worktreeRoot: descriptor.worktreeRoot,
      channel: descriptor.channel,
      protocolVersion: descriptor.protocolVersion,
    });
  } catch {
    throw new Error("dev launch supervisor receipt identity does not match request");
  }
  if (
    normalized.requestId !== request.requestId ||
    !sameDevLaunchIdentity(normalized.supervisor, descriptor.supervisor) ||
    !sameOptionalDevLaunchIdentity(
      normalized.previousFrontend,
      descriptor.frontend,
    ) ||
    (descriptor.frontend !== undefined && !normalized.frontend)
  ) {
    throw new Error("dev launch supervisor receipt identity does not match request");
  }
  if (
    normalized.launch.generation === normalized.previousLaunch.generation
  ) {
    throw new Error("dev launch supervisor replacement receipt is invalid");
  }
  return normalized;
}

function validateReceipt(receipt, request, descriptor) {
  if (receipt?.type === "restart_rejected") {
    throw restartRejection(receipt, request, descriptor.protocolVersion);
  }
  const normalized = validateReceiptEnvelope(receipt, request, descriptor);
  if (!sameDevLaunchIdentity(normalized.previousLaunch, descriptor.launch)) {
    throw new Error("dev launch supervisor receipt identity does not match request");
  }
  return normalized;
}

function validateAdmission(admission, request, descriptor) {
  if (
    !admission ||
    !responseProtocolMatches(admission) ||
    admission.type !== "restart_admitted" ||
    admission.requestId !== request.requestId ||
    admission.worktreeRoot !== descriptor.worktreeRoot ||
    admission.channel !== descriptor.channel ||
    !sameDevLaunchIdentity(admission.supervisor, descriptor.supervisor) ||
    !sameDevLaunchIdentity(admission.previousLaunch, descriptor.launch) ||
    !sameOptionalDevLaunchIdentity(
      admission.previousFrontend,
      descriptor.frontend,
    )
  ) {
    throw new Error("dev launch supervisor admission does not match request");
  }
  return admission;
}

function validatePendingRestart(status, request, descriptor) {
  if (
    !status ||
    !responseProtocolMatches(status) ||
    status.type !== "restart_pending" ||
    status.requestId !== request.requestId ||
    status.worktreeRoot !== descriptor.worktreeRoot ||
    status.channel !== descriptor.channel ||
    !sameDevLaunchIdentity(status.supervisor, descriptor.supervisor) ||
    !sameOptionalDevLaunchIdentity(
      status.previousFrontend,
      descriptor.frontend,
    ) ||
    (status.phase !== "preparing" && status.phase !== "retiring")
  ) {
    throw new Error("dev launch supervisor status does not match request");
  }
  return status;
}

function validateRecoveredRestartStatus(status, request, descriptor) {
  if (status?.type === "restart_pending") {
    return validatePendingRestart(status, request, descriptor);
  }
  if (status?.type === "restart_rejected") {
    throw restartRejection(status, request, descriptor.protocolVersion);
  }
  return validateReceiptEnvelope(status, request, descriptor);
}

function unavailableAuthority(message) {
  const unavailable = new Error(message);
  unavailable.code = DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE;
  unavailable.destructiveBoundaryCrossed = false;
  return unavailable;
}

function activeDescriptor({ home, channel, worktreeRoot }) {
  try {
    const { value } = readDescriptor({ home, channel, worktreeRoot });
    assertOwnerOnlySocket(value.socketPath);
    return value;
  } catch (error) {
    throw unavailableAuthority(error.message);
  }
}

function activeRestartDescriptor(options) {
  const descriptor = activeDescriptor(options);
  const recoveringFrontend =
    descriptor.protocolVersion === DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION &&
    descriptor.state === "preparing" &&
    descriptor.launch !== null &&
    descriptor.frontend != null &&
    descriptor.capabilities.includes(
      DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
    );
  if (descriptor.state !== "ready" && !recoveringFrontend) {
    throw unavailableAuthority(
      "dev launch supervisor is still preparing its initial launch",
    );
  }
  return descriptor;
}

function matchingStartupFailure({
  home,
  channel,
  worktreeRoot,
  sourceGeneration,
  hmuxProviderIdentity,
}) {
  if (!hmuxProviderIdentity) return undefined;
  let descriptor;
  try {
    descriptor = readDescriptor({ home, channel, worktreeRoot }).value;
  } catch {
    return undefined;
  }
  const failure = descriptor.startupFailure;
  if (
    descriptor.sourceGeneration !== sourceGeneration ||
    failure?.hmux.sessionId !== hmuxProviderIdentity.sessionId ||
    failure.hmux.workspaceId !== hmuxProviderIdentity.workspaceId
  ) {
    return undefined;
  }
  return failure;
}

function restartTransactionRequest(descriptor, requestId, type) {
  return {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    type,
    requestId,
    worktreeRoot: descriptor.worktreeRoot,
    channel: descriptor.channel,
    capability: descriptor.capability,
    supervisor: descriptor.supervisor,
  };
}

function validateRestartAcknowledgement(response, descriptor, requestId) {
  if (
    !responseProtocolMatches(response) ||
    response.type !== "restart_acknowledged" ||
    response.requestId !== requestId ||
    response.worktreeRoot !== descriptor.worktreeRoot ||
    response.channel !== descriptor.channel ||
    !sameDevLaunchIdentity(response.supervisor, descriptor.supervisor)
  ) {
    throw new Error("dev launch restart acknowledgement does not match request");
  }
}

async function acknowledgeTerminalRestart(descriptor, requestId) {
  try {
    const response = await connectForFrame({
      socketPath: descriptor.socketPath,
      frame: restartTransactionRequest(descriptor, requestId, "restart_ack"),
      timeoutMs: TERMINAL_ACK_CONNECTION_TIMEOUT_MS,
      timeoutAfterConnect: true,
    });
    validateRestartAcknowledgement(response, descriptor, requestId);
  } catch {
    // Terminal truth is already validated; retention remains the fallback.
  }
}

function withRestartEvidence(error, request, lastPhase) {
  const failure = error instanceof Error ? error : new Error(String(error));
  failure.restartRequestId = request.requestId;
  if (lastPhase === "retiring") {
    failure.destructiveBoundaryCrossed = true;
  } else if (
    failure.destructiveBoundaryCrossed !== true &&
    failure.destructiveBoundaryCrossed !== false
  ) {
    failure.destructiveBoundaryCrossed = null;
  }
  return failure;
}

function indeterminateRestartError(
  error,
  request,
  lastPhase,
  restartRequestSent = true,
) {
  const indeterminate = new Error(
    `dev launch supervisor restart transaction ${request.requestId} lost its authority: ${error.message}`,
  );
  if (!restartRequestSent && lastPhase === null) {
    indeterminate.destructiveBoundaryCrossed = false;
  }
  return withRestartEvidence(indeterminate, request, lastPhase);
}

export async function requestDevLaunchRestart({
  root: worktreeRoot,
  channel,
  home = homedir(),
  timeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS,
  settlementTimeoutMs = DEFAULT_RESTART_SETTLEMENT_TIMEOUT_MS,
  expectedAuthority,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(
      "dev launch restart connection timeout must be a positive integer",
    );
  }
  if (!Number.isSafeInteger(settlementTimeoutMs) || settlementTimeoutMs < 1) {
    throw new Error(
      "dev launch restart settlement timeout must be a positive integer",
    );
  }
  const descriptor =
    expectedAuthority ??
    activeRestartDescriptor({
      home,
      channel,
      worktreeRoot,
    });
  const request = {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    type: "restart",
    requestId: randomIdentity(),
    worktreeRoot,
    channel,
    capability: descriptor.capability,
    supervisor: descriptor.supervisor,
    expectedLaunch: descriptor.launch,
    ...(descriptor.frontend !== undefined
      ? { expectedFrontend: descriptor.frontend }
      : {}),
    ...(descriptor.protocolVersion === DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION
      ? {
          protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
          expectedState: descriptor.state,
        }
      : {}),
  };
  if (
    descriptor.protocolVersion === LEGACY_DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION
  ) {
    try {
      const response = await connectForFrame({
        socketPath: descriptor.socketPath,
        frame: request,
        timeoutMs,
      });
      return validateReceipt(response, request, descriptor);
    } catch (error) {
      if (error?.restartRequestId) throw error;
      throw indeterminateRestartError(
        error,
        request,
        null,
        error?.devLaunchRequestSent !== false,
      );
    }
  }
  let admitted = false;
  let lastPhase = null;
  let frame = request;
  let restartRequestSent = false;
  let statusConnectionFailures = 0;
  const settlementDeadlineMs = Date.now() + settlementTimeoutMs;
  let recoveryDeadlineMs = null;
  try {
    for (;;) {
      if (admitted && Date.now() >= settlementDeadlineMs) {
        if (recoveryDeadlineMs === null) {
          // The supervisor may be retiring its exact candidate as the
          // deadline fires. Keep observing this request until that retained
          // terminal truth can be acknowledged; never mint a second restart.
          recoveryDeadlineMs =
            Date.now() +
            Math.min(
              settlementTimeoutMs,
              RESTART_SETTLEMENT_RECOVERY_MS,
            );
          frame = restartTransactionRequest(
            descriptor,
            request.requestId,
            "restart_status",
          );
        } else if (Date.now() >= recoveryDeadlineMs) {
          throw indeterminateRestartError(
            new Error(
              "settlement deadline expired without a terminal status",
            ),
            request,
            lastPhase,
          );
        }
      }
      let response;
      try {
        response = await connectForFrame({
          socketPath: descriptor.socketPath,
          frame,
          timeoutMs: Math.min(timeoutMs, RESTART_STATUS_REQUEST_TIMEOUT_MS),
          timeoutAfterConnect: true,
        });
        statusConnectionFailures = 0;
        if (frame === request) restartRequestSent = true;
      } catch (error) {
        if (frame === request && error?.devLaunchRequestSent !== false) {
          restartRequestSent = true;
        }
        if (frame.type === "restart_status") {
          statusConnectionFailures += 1;
        }
        if (
          (frame === request &&
            !restartRequestSent &&
            error?.devLaunchRequestSent === false) ||
          statusConnectionFailures >= MAX_STATUS_CONNECTION_FAILURES ||
          await observeProcessLiveness(descriptor.supervisor, {
            timeoutMs: Math.min(
              timeoutMs,
              RESTART_STATUS_REQUEST_TIMEOUT_MS,
            ),
          }) === "stale"
        ) {
          throw indeterminateRestartError(
            error,
            request,
            lastPhase,
            restartRequestSent,
          );
        }
        frame = restartTransactionRequest(
          descriptor,
          request.requestId,
          "restart_status",
        );
        await delay(RESTART_STATUS_POLL_MS);
        continue;
      }

      if (response.type === "restart_admitted") {
        validateAdmission(response, request, descriptor);
        admitted = true;
        lastPhase = "preparing";
      } else if (response.type === "restart_pending") {
        validatePendingRestart(response, request, descriptor);
        admitted = true;
        lastPhase = response.phase;
      } else if (
        !admitted &&
        response.type === "restart_rejected" &&
        response.reason === "dev launch restart transaction is unavailable"
      ) {
        frame = request;
        await delay(RESTART_STATUS_POLL_MS);
        continue;
      } else {
        try {
          const terminal =
            frame.type === "restart_status"
              ? validateRecoveredRestartStatus(response, frame, descriptor)
              : validateReceipt(response, request, descriptor);
          await acknowledgeTerminalRestart(descriptor, request.requestId);
          return terminal;
        } catch (error) {
          if (error?.restartRequestId === request.requestId) {
            await acknowledgeTerminalRestart(descriptor, request.requestId);
          }
          throw error;
        }
      }

      frame = restartTransactionRequest(
        descriptor,
        request.requestId,
        "restart_status",
      );
      await delay(RESTART_STATUS_POLL_MS);
    }
  } catch (error) {
    throw withRestartEvidence(error, request, lastPhase);
  }
}

function coldBootstrapRequired(message) {
  const error = new Error(`cold_bootstrap_required: ${message}`);
  error.code = DEV_LAUNCH_COLD_BOOTSTRAP_REQUIRED;
  error.destructiveBoundaryCrossed = false;
  return error;
}

function assertParentReloadAuthority(descriptor, requireFrontendAuthority) {
  if (
    !descriptor.capabilities.includes(PARENT_RELOAD_CAPABILITY) ||
    (requireFrontendAuthority &&
      !descriptor.capabilities.includes(
        DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
      ))
  ) {
    throw coldBootstrapRequired(
      "the active supervisor cannot hand off its parent generation",
    );
  }
}

function validateParentReloadAdmission(response, request, descriptor) {
  if (response?.type === "parent_reload_rejected") {
    const error = new Error(
      typeof response.reason === "string"
        ? response.reason
        : "dev launch supervisor rejected parent reload",
    );
    error.destructiveBoundaryCrossed =
      response.destructiveBoundaryCrossed === true
        ? true
        : response.destructiveBoundaryCrossed === false
          ? false
          : null;
    error.parentReloadRequestId = request.requestId;
    throw error;
  }
  if (
    !responseProtocolMatches(response) ||
    response.type !== "parent_reload_admitted" ||
    response.requestId !== request.requestId ||
    response.worktreeRoot !== descriptor.worktreeRoot ||
    response.channel !== descriptor.channel ||
    !sameDevLaunchIdentity(response.previousSupervisor, descriptor.supervisor) ||
    !sameDevLaunchIdentity(response.previousLaunch, descriptor.launch) ||
    !sameOptionalDevLaunchIdentity(
      response.previousFrontend,
      descriptor.frontend,
    ) ||
    response.targetSupervisorGeneration !==
      request.targetSupervisorGeneration ||
    response.targetSourceGeneration !== request.targetSourceGeneration
  ) {
    throw new Error("dev launch parent reload admission does not match request");
  }
}

function predecessorExitedBeforeHandoff(request) {
  const error = new Error(
    "dev launch parent predecessor exited before committing handoff",
  );
  error.destructiveBoundaryCrossed = false;
  error.parentReloadRequestId = request.requestId;
  return error;
}

async function observeParentHandoffLiveness(owner, role, deadline) {
  const liveness = await observeProcessLiveness(owner, {
    timeoutMs: Math.max(1, deadline - Date.now()),
  });
  if (liveness === "unknown") {
    throw new Error(`exact parent ${role} liveness is indeterminate`);
  }
  return liveness;
}

async function awaitParentReloadActivation({
  home,
  channel,
  worktreeRoot,
  request,
  predecessor,
  timeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pathname = descriptorPath(home, channel);
      if (!safeLstat(pathname)) {
        if (
          await observeParentHandoffLiveness(
            predecessor.supervisor,
            "predecessor",
            deadline,
          ) === "stale"
        ) {
          throw predecessorExitedBeforeHandoff(request);
        }
        if (Date.now() >= deadline) {
          throw new Error("dev launch parent descriptor disappeared during handoff");
        }
        await delay(RESTART_STATUS_POLL_MS);
        continue;
      }
      const { value } = readDescriptor({ home, channel, worktreeRoot });
      const failure = value.parentReloadFailure;
      if (
        failure?.type === "parent_reload_failure" &&
        failure.requestId === request.requestId &&
        failure.targetSupervisorGeneration ===
          request.targetSupervisorGeneration &&
        failure.targetSourceGeneration === request.targetSourceGeneration
      ) {
        const error = new Error(
          `dev launch parent reload failed: ${failure.reason ?? "unknown failure"}`,
        );
        error.destructiveBoundaryCrossed =
          failure.destructiveBoundaryCrossed === true;
        throw error;
      }
      const receipt = parentReloadReceiptFromDescriptor(
        value,
        request,
        predecessor,
      );
      if (receipt) {
        assertOwnerOnlySocket(value.socketPath);
        if (
          await observeParentHandoffLiveness(
            value.supervisor,
            "successor",
            deadline,
          ) === "stale"
        ) {
          throw new Error("activated parent generation is not live");
        }
        const remainingMs = Math.max(1, deadline - Date.now());
        if (
          await parentGenerationEndpointMatches(
            value,
            Math.min(250, remainingMs),
          )
        ) {
          return receipt;
        }
      }
      if (!receipt) {
        const matchesCommittedHandoff =
          value.state === "handoff" &&
          value.handoff?.requestId === request.requestId &&
          value.handoff?.targetSupervisorGeneration ===
            request.targetSupervisorGeneration &&
          value.handoff?.targetSourceGeneration ===
            request.targetSourceGeneration;
        const isPredecessor = sameDevLaunchIdentity(
          value.supervisor,
          predecessor.supervisor,
        ) && sameDevLaunchIdentity(value.launch, predecessor.launch);
        const isPreparingSuccessor = isPreparingParentReloadSuccessor(
          value,
          request,
          predecessor,
        );
        if (isPredecessor) {
          const predecessorLiveness = await observeParentHandoffLiveness(
            predecessor.supervisor,
            "predecessor",
            deadline,
          );
          if (predecessorLiveness === "stale") {
            throw predecessorExitedBeforeHandoff(request);
          }
        }
        if (isPreparingSuccessor) {
          const successorLiveness = await observeParentHandoffLiveness(
            value.supervisor,
            "successor",
            deadline,
          );
          if (successorLiveness === "stale") {
            throw new Error(
              "exact parent successor exited before activation",
            );
          }
        }
        if (matchesCommittedHandoff) {
          const successorLiveness = await observeParentHandoffLiveness(
            value.supervisor,
            "successor",
            deadline,
          );
          if (successorLiveness === "stale") {
            throw new Error(
              "exact parent successor exited after committed handoff",
            );
          }
        }
        if (
          !matchesCommittedHandoff &&
          !isPredecessor &&
          !isPreparingSuccessor
        ) {
          throw new Error(
            "dev launch parent authority changed to an unrelated generation",
          );
        }
      }
    } catch (error) {
      error.destructiveBoundaryCrossed ??= true;
      error.parentReloadRequestId = request.requestId;
      throw error;
    }
    if (Date.now() >= deadline) {
      const error = new Error(
        "dev launch parent reload did not activate its exact target generation",
      );
      error.destructiveBoundaryCrossed = true;
      error.parentReloadRequestId = request.requestId;
      throw error;
    }
    await delay(RESTART_STATUS_POLL_MS);
  }
}

async function requestDevLaunchParentReloadParsed({
  root: worktreeRoot,
  channel,
  sourceGeneration,
  home = homedir(),
  timeoutMs = DEFAULT_PARENT_RELOAD_TIMEOUT_MS,
  requireFrontendAuthority = false,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("dev launch parent reload timeout must be a positive integer");
  }
  const descriptor = activeDescriptor({ home, channel, worktreeRoot });
  if (descriptor.protocolVersion !== DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION) {
    throw coldBootstrapRequired(
      "the active supervisor cannot hand off its parent generation",
    );
  }
  assertParentReloadAuthority(descriptor, requireFrontendAuthority);
  if (descriptor.state !== "ready") {
    throw coldBootstrapRequired(
      "the active supervisor is not ready for an exact parent handoff",
    );
  }
  const request = {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    type: "parent_reload",
    requestId: randomIdentity(),
    worktreeRoot,
    channel,
    capability: descriptor.capability,
    expectedSupervisor: descriptor.supervisor,
    expectedLaunch: descriptor.launch,
    ...(descriptor.frontend !== undefined
      ? { expectedFrontend: descriptor.frontend }
      : {}),
    targetSupervisorGeneration: randomIdentity(),
    targetSourceGeneration: sourceGeneration,
  };
  try {
    const response = await connectForFrame({
      socketPath: descriptor.socketPath,
      frame: request,
      timeoutMs: Math.min(timeoutMs, RESTART_STATUS_REQUEST_TIMEOUT_MS),
      timeoutAfterConnect: true,
    });
    validateParentReloadAdmission(response, request, descriptor);
  } catch (error) {
    if (error?.parentReloadRequestId) throw error;
    if (error?.devLaunchRequestSent === false) {
      error.destructiveBoundaryCrossed = false;
      error.parentReloadRequestId = request.requestId;
      throw error;
    }
    // Admission can be lost when exec closes the predecessor endpoint. The
    // committed handoff descriptor is the one recovery authority across exec.
  }
  return awaitParentReloadActivation({
    home,
    channel,
    worktreeRoot,
    request,
    predecessor: descriptor,
    timeoutMs,
  });
}

export function requestDevLaunchParentReload(options) {
  parseDevLaunchGeneration(
    options.sourceGeneration,
    "target source generation",
  );
  return requestDevLaunchParentReloadParsed(options);
}

async function observeActiveDevLaunchParentGeneration({
  root: worktreeRoot,
  channel,
  home = homedir(),
  hmuxProviderIdentity,
  sourceGeneration,
  requireParentReloadAuthority = false,
  requireFrontendAuthority = false,
  timeoutMs = RESTART_STATUS_REQUEST_TIMEOUT_MS,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(
      "dev launch parent observation timeout must be a positive integer",
    );
  }
  const startupFailure = matchingStartupFailure({
    home,
    channel,
    worktreeRoot,
    hmuxProviderIdentity,
    sourceGeneration,
  });
  if (startupFailure) {
    const error = new Error(startupFailure.reason);
    error.destructiveBoundaryCrossed = false;
    throw error;
  }
  const descriptor = activeDescriptor({ home, channel, worktreeRoot });
  if (
    descriptor.protocolVersion !== DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION ||
    descriptor.state !== "ready" ||
    descriptor.sourceGeneration === undefined
  ) {
    throw coldBootstrapRequired(
      "the active parent does not expose a ready v2 generation",
    );
  }
  if (requireParentReloadAuthority) {
    assertParentReloadAuthority(descriptor, requireFrontendAuthority);
  }
  if (
    await observeProcessLiveness(descriptor.supervisor, { timeoutMs }) !==
      "active"
  ) {
    const error = new Error("observed parent generation is not live");
    error.code = DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE;
    error.destructiveBoundaryCrossed = false;
    throw error;
  }
  let endpointMatches;
  try {
    endpointMatches = await parentGenerationEndpointMatches(
      descriptor,
      timeoutMs,
    );
  } catch (error) {
    error.destructiveBoundaryCrossed = false;
    throw error;
  }
  if (!endpointMatches) {
    const error = new Error(
      "observed parent endpoint did not prove its exact generation",
    );
    error.code = DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE;
    error.destructiveBoundaryCrossed = false;
    throw error;
  }
  return {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    type: "parent_generation_receipt",
    worktreeRoot,
    channel,
    sourceGeneration: descriptor.sourceGeneration,
    supervisor: descriptor.supervisor,
    launch: descriptor.launch,
    ...(descriptor.frontend !== undefined
      ? { frontend: descriptor.frontend }
      : {}),
    observedAtMs: Date.now(),
  };
}

async function awaitActiveDevLaunchParentGeneration(
  options,
  sourceGeneration,
) {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return undefined;
    try {
      const observation = await observeActiveDevLaunchParentGeneration({
        ...options,
        timeoutMs: remainingMs,
      });
      if (observation.sourceGeneration === sourceGeneration) {
        return observation;
      }
    } catch (error) {
      if (
        error?.code !== DEV_LAUNCH_COLD_BOOTSTRAP_REQUIRED &&
        error?.code !== DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE
      ) {
        throw error;
      }
    }
    const delayMs = Math.min(RESTART_STATUS_POLL_MS, deadline - Date.now());
    if (delayMs <= 0) return undefined;
    await delay(delayMs);
  }
}

/** Observe the authenticated live parent without deriving identity from checkout files. */
export async function observeDevLaunchParentAuthority(options) {
  const hmuxProviderIdentity = parseDevLaunchHmuxProviderIdentity(
    options.hmuxProviderIdentity,
  );
  return observeActiveDevLaunchParentGeneration({
    ...options,
    hmuxProviderIdentity,
  });
}

/** Observe the same live runtime authority accepted by child restart. */
export async function observeDevLaunchRestartAuthority({
  root: worktreeRoot,
  channel,
  home = homedir(),
  timeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS,
}) {
  const descriptor = activeRestartDescriptor({
    home,
    channel,
    worktreeRoot,
  });
  if (
    await observeProcessLiveness(descriptor.supervisor, { timeoutMs }) !==
    "active"
  ) {
    throw unavailableAuthority("observed dev launch supervisor is not live");
  }
  return descriptor;
}

export async function observeDevLaunchParentGeneration(options) {
  const sourceGeneration = parseDevLaunchGeneration(
    options.sourceGeneration,
    "observed source generation",
  );
  const hmuxProviderIdentity = parseDevLaunchHmuxProviderIdentity(
    options.hmuxProviderIdentity,
  );
  const observation = await observeActiveDevLaunchParentGeneration({
    ...options,
    sourceGeneration,
    hmuxProviderIdentity,
  });
  if (observation.sourceGeneration !== sourceGeneration) {
    throw coldBootstrapRequired(
      "the active parent does not serve the requested source generation",
    );
  }
  return observation;
}

function parentGenerationAfterReload(receipt) {
  return {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    type: "parent_generation_receipt",
    worktreeRoot: receipt.worktreeRoot,
    channel: receipt.channel,
    sourceGeneration: receipt.sourceGeneration,
    supervisor: receipt.supervisor,
    launch: receipt.launch,
    ...(receipt.frontend !== undefined
      ? { frontend: receipt.frontend }
      : {}),
    observedAtMs: Date.now(),
  };
}

export async function ensureDevLaunchParentGeneration(options) {
  parseDevLaunchGeneration(
    options.sourceGeneration,
    "target source generation",
  );
  const observationOptions = {
    ...options,
    timeoutMs: Math.min(
      options.timeoutMs ?? RESTART_STATUS_REQUEST_TIMEOUT_MS,
      RESTART_STATUS_REQUEST_TIMEOUT_MS,
    ),
  };
  const active = await observeActiveDevLaunchParentGeneration(
    observationOptions,
  );
  if (active.sourceGeneration === options.sourceGeneration) {
    return { outcome: "already_active", parentGeneration: active };
  }
  try {
    const activation = await requestDevLaunchParentReloadParsed(options);
    return {
      outcome: "activated",
      parentGeneration: parentGenerationAfterReload(activation),
      activation,
    };
  } catch (error) {
    if (error?.destructiveBoundaryCrossed !== false) throw error;
    let parentGeneration;
    try {
      parentGeneration = await awaitActiveDevLaunchParentGeneration(
        observationOptions,
        options.sourceGeneration,
      );
    } catch {
      throw error;
    }
    if (!parentGeneration) throw error;
    return { outcome: "already_active", parentGeneration };
  }
}

export {
  assertOwnerOnlyDirectory,
  createDescriptor,
  delay,
  descriptorPath,
  isOwner,
  readDescriptor,
  safeLstat,
  socketPathFor,
  writeDescriptor,
};
