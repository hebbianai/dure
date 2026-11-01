/** Point-in-time admission of the signing host before release work starts.
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

export function assessReleaseHost(
  observation,
  { maxLoadPerCore = RELEASE_HOST_MAX_LOAD_PER_CORE } = {},
) {
  if (!Number.isFinite(maxLoadPerCore) || maxLoadPerCore <= 0) {
    throw new Error(
      "release_host_load_limit_invalid: the load limit must be a positive number of one-minute load per logical core",
    );
  }
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
