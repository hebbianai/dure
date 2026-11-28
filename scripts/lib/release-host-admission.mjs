import {
  DEFAULT_HOST_RESOURCE_POLICY,
  waitForHostResources,
} from "./host-resource-admission.mjs";

/** Admission of the signing host before release work starts.
 *
 * Threshold evidence (hebbianai/dure#308, release run 41195693547 on the
 * 16-core signing host): DMG packaging succeeded at a one-minute load average
 * of about 155 (under 10 per logical core) and failed at 400–935 (25–58 per
 * core) while the host swapped heavily. 16 per core (256 on that host) sits
 * between the two observations with margin on the healthy side, and it is the
 * ceiling the shared host resource policy already accepts. The limit is per
 * logical core so hosted runners with 3–4 cores are judged by the same rule.
 */
export const RELEASE_HOST_MAX_LOAD_PER_CORE = 16;

/** How long pre-tag admission waits for a busy host before it refuses.
 *
 * Evidence (hebbianai/dure#836): v0.2.73's preflight was refused twice within
 * 19 minutes before it was admitted, and every refusal cost an operator rerun
 * (v0.2.71 waited 2 h 49 min for one). 25 minutes covers that contention; a
 * host that stays busy is still refused before any version exists.
 */
export const RELEASE_HOST_WAIT_MINUTES = 25;

function releaseLoadLimit(maxLoadPerCore) {
  if (!Number.isFinite(maxLoadPerCore) || maxLoadPerCore <= 0) {
    throw new Error(
      "release_host_load_limit_invalid: the load limit must be a positive number of one-minute load per logical core",
    );
  }
  return maxLoadPerCore;
}

/** The shared host-resource policy evaluated at the release load limit. Only
 * critical memory pressure blocks release work, as in assessReleaseHost. */
export function releaseHostResourcePolicy(maxLoadPerCore = RELEASE_HOST_MAX_LOAD_PER_CORE) {
  return Object.freeze({
    ...DEFAULT_HOST_RESOURCE_POLICY,
    enabled: true,
    maxLoadPerCore: releaseLoadLimit(maxLoadPerCore),
    memoryPressureCeiling: "warning",
  });
}

/** Wait up to maxWaitMs for the release load limit. Resolves true once the
 * host is under it and false when the wait ends first; it never stops work. */
export async function waitForReleaseHost({
  label,
  maxWaitMs,
  maxLoadPerCore = RELEASE_HOST_MAX_LOAD_PER_CORE,
  log,
  waitForHost = waitForHostResources,
}) {
  const policy = releaseHostResourcePolicy(maxLoadPerCore);
  const report = (receipt) => {
    const observed = receipt.observation ?? {};
    const load = Number.isFinite(observed.loadPerCore) ? observed.loadPerCore.toFixed(1) : "unknown";
    log(`host ${receipt.state}: one-minute load per core ${load} (limit ${maxLoadPerCore}), memory pressure ${observed.memoryPressure ?? "unknown"}${receipt.reasonCodes?.length ? ` [${receipt.reasonCodes.join(", ")}]` : ""}`);
  };
  try {
    await waitForHost({
      policyPath: "release-host-admission",
      readPolicy: () => policy,
      maxWaitMs,
      label,
      report,
    });
    return true;
  } catch (error) {
    log(`host still busy after ${Math.round(maxWaitMs / 1000)}s (${error.message})`);
    return false;
  }
}

export function assessReleaseHost(
  observation,
  { maxLoadPerCore = RELEASE_HOST_MAX_LOAD_PER_CORE } = {},
) {
  releaseLoadLimit(maxLoadPerCore);
  const {
    oneMinuteLoad = null,
    logicalCores = null,
    loadPerCore = null,
    memoryPressure = "unknown",
  } = observation ?? {};
  const receipt = { oneMinuteLoad, logicalCores, loadPerCore, memoryPressure, maxLoadPerCore };
  const refuse = (code, detail) =>
    Object.freeze({ ...receipt, ok: false, code, message: `${code}: ${detail}` });
  if (
    !Number.isFinite(oneMinuteLoad) ||
    !Number.isFinite(loadPerCore) ||
    loadPerCore < 0
  ) {
    return refuse(
      "release_host_load_unavailable",
      "the one-minute load average could not be observed, so the host is not admitted for release work",
    );
  }
  const load = `one-minute load average ${oneMinuteLoad.toFixed(1)} is ${loadPerCore.toFixed(1)} per logical core on ${logicalCores} cores`;
  if (memoryPressure === "critical") {
    return refuse(
      "release_host_memory_critical",
      `memory pressure is critical (${load}); let other work finish, then rerun the failed jobs`,
    );
  }
  if (loadPerCore > maxLoadPerCore) {
    return refuse(
      "release_host_overloaded",
      `${load}; release work admits at most ${maxLoadPerCore} per core. Let other work finish, then rerun the failed jobs`,
    );
  }
  return Object.freeze({
    ...receipt,
    ok: true,
    code: null,
    message: `release host admitted: ${load} (limit ${maxLoadPerCore}), memory pressure ${memoryPressure}`,
  });
}
