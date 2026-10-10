export const SCHEDULE_RUNTIME_CAPABILITY = "schedule.runtime_observation_v1";

export function isScheduleRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0) return false;
  if (value.session !== undefined && (!value.session ||
      ["sessionId", "workspaceId", "providerId", "runnerPrincipal", "runnerInstance", "channelEpoch", "hostInstanceId", "terminalEpoch"]
        .some((key) => typeof value.session[key] !== "string" || !/^[A-Za-z0-9._:+-]{1,256}$/.test(value.session[key])) ||
      !/^[1-9][0-9]*$/.test(value.session.channelEpoch))) return false;
  return value.state === "unavailable"
    ? typeof value.errorCode === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(value.errorCode)
    : value.state === "observed" && value.session !== undefined &&
      ["starting", "running", "exited"].includes(value.lifecycle) &&
      ["working", "waiting"].includes(value.activity) &&
      ["none", "input_required", "approval_required", "error"].includes(value.attention);
}

export function scheduleRuntimeStatus(runtime) {
  if (!runtime) return undefined;
  if (runtime.state === "unavailable") return "runtimeUnavailable";
  if (runtime.lifecycle === "exited") return "exitedWithoutReport";
  if (runtime.attention === "input_required") return "inputRequired";
  if (runtime.attention === "approval_required") return "approvalRequired";
  if (runtime.attention === "error") return "providerError";
  if (runtime.lifecycle === "starting") return "providerStarting";
  return runtime.activity === "working" ? "providerWorking" : "providerWaiting";
}
