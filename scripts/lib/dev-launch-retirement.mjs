import {
  CHILD_IDENTITY_TIMEOUT_MS,
  CHILD_KILL_TIMEOUT_MS,
  CHILD_STOP_TIMEOUT_MS,
} from "./dev-launch-contract.mjs";
import { delay } from "./dev-launch-client.mjs";
import { isProcessAlive, observeProcessLiveness } from "./process-identity.mjs";
import {
  legacyProcessGroupPresent,
  observeOwnedProcessGroup,
  signalExactProcess,
  signalOwnedProcessGroup,
} from "./process-group-authority.mjs";

export const candidateCleanupAuthority = Object.freeze({
  activationLease: "activation_lease",
  publishedIdentity: "published_identity",
});

function observationUnavailable(message) {
  const error = new Error(message);
  error.code = "DEV_LAUNCH_OBSERVATION_UNAVAILABLE";
  return error;
}

export async function launchRuntimeState(identity, label) {
  if (!identity) return "stale";
  if (identity.processGroup) {
    const group = await observeOwnedProcessGroup(identity);
    if (group.state === "retired") return "stale";
    if (group.state === "owned") {
      return group.leaderCurrent && group.witnessCurrent
        ? "active"
        : "owned_group";
    }
    throw observationUnavailable(
      `could not observe dev launch ${label} process group: ${group.reason ?? "exact_generation_unproven"}`,
    );
  } else {
    if (process.platform === "win32") {
      throw observationUnavailable("legacy Windows launch has no Job retirement authority");
    }
    const leaderLiveness = await observeProcessLiveness(identity);
    if (leaderLiveness === "unknown") {
      throw observationUnavailable(
        `could not verify stale supervisor ${label} identity`,
      );
    }
    if (
      leaderLiveness === "active" ||
      !legacyProcessGroupPresent(identity.pid)
    ) {
      return leaderLiveness;
    }
  }
  throw new Error(
    `stale dev launch ${label} leader has a live process group without exact signal authority`,
  );
}

/** Shutdown does not release its control authority while it still owns a child.
 * Every retirement attempt re-enters the same exact-generation signal boundary;
 * an unavailable observation never grants permission to signal or forget it. */
export async function settleOwnedLaunchRetirement(record, onPending) {
  let previousReason;
  for (;;) {
    try {
      await retireOwnedLaunch(record);
      onPending(null);
      return;
    } catch (error) {
      onPending(error);
      if (error.message !== previousReason) {
        process.stderr.write(`Dev launch retirement pending: ${error.message}\n`);
        previousReason = error.message;
      }
      await delay(250);
    }
  }
}

export async function launchRetired(record) {
  const pid = record.launch?.pid ?? record.child.pid;
  const group = record.launch?.processGroup
    ? await observeOwnedProcessGroup(record.launch)
    : null;
  if (!group && process.platform === "win32") {
    if (record.windowsJob || !record.launch) return record.exited;
    throw observationUnavailable("legacy Windows launch has no Job retirement authority");
  }
  if (
    !record.exited &&
    (group
      ? group.state === "retired" ||
        (record.launch &&
          group.state === "owned" &&
          !group.leaderCurrent)
      : record.launch &&
        await observeProcessLiveness(record.launch) === "stale")
  ) {
    record.exited = true;
    record.exit = { code: null, signal: null };
  }
  return (
    record.exited &&
    (group ? group.state === "retired" :
      !record.detached || !Number.isSafeInteger(pid) || !legacyProcessGroupPresent(pid))
  );
}

export async function waitForLaunchRetirement(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const witnessPid = record.launch?.processGroup?.witness.pid;
  if (Number.isSafeInteger(witnessPid) && witnessPid > 0) {
    do {
      if (!isProcessAlive(witnessPid)) return await launchRetired(record);
      await delay(25);
    } while (Date.now() < deadline);
    return await launchRetired(record);
  }
  do {
    if (await launchRetired(record)) return true;
    await delay(25);
  } while (Date.now() < deadline);
  return false;
}

export async function retireOwnedLaunch(
  record,
  { onRetirementCommitted, requireActive = false } = {},
) {
  const pid = record.launch?.pid ?? record.child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (await launchRetired(record)) {
    if (requireActive) {
      throw new Error("dev launch child exited before restart admission");
    }
    return;
  }
  if (
    !requireActive &&
    record.exited &&
    record.launch?.processGroup &&
    await waitForLaunchRetirement(record, CHILD_IDENTITY_TIMEOUT_MS)
  ) {
    return;
  }
  if (
    !record.launch ||
    record.cleanupAuthority === candidateCleanupAuthority.activationLease
  ) {
    if (record.child.connected) record.child.disconnect();
    if (!(await waitForLaunchRetirement(record, CHILD_STOP_TIMEOUT_MS))) {
      throw new Error(
        "dev launch child did not retire after its activation lease was revoked",
      );
    }
    return;
  }
  const runtimeState = await launchRuntimeState(
    record.launch,
    "launch cleanup",
  );
  if (requireActive && runtimeState !== "active") {
    throw new Error("dev launch child process identity changed before restart");
  }
  if (
    !record.launch?.processGroup &&
    runtimeState !== "active"
  ) {
    if (
      runtimeState === "stale" &&
      await waitForLaunchRetirement(record, CHILD_IDENTITY_TIMEOUT_MS)
    ) {
      return;
    }
    throw new Error(
      "dev launch child leader identity is unavailable while its process group remains live",
    );
  }
  if (record.launch?.processGroup && runtimeState === "stale") {
    return;
  }
  onRetirementCommitted?.();
  record.restarting = true;
  const signal = async (name) => {
    if (record.launch?.processGroup) {
      await signalOwnedProcessGroup(record.launch, name);
      return;
    }
    await signalExactProcess(record.launch, name);
  };
  try {
    await signal("SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (await waitForLaunchRetirement(record, CHILD_STOP_TIMEOUT_MS)) return;
  try {
    await signal("SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (!(await waitForLaunchRetirement(record, CHILD_KILL_TIMEOUT_MS))) {
    throw new Error("dev launch child did not exit after SIGKILL");
  }
}
