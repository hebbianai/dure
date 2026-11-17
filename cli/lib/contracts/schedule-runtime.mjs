export const SCHEDULE_RUNTIME_CAPABILITY = "schedule.runtime_observation_v1";

const ATTENTION = ["none", "input_required", "approval_required", "error"];

// A chat-runtime run has no terminal session. The backend adds its
// conversation state next to `schedule_runtime_not_native`, so a client that
// predates it still reads the occurrence as before.
function isConversation(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    ["working", "waiting"].includes(value.activity) && ATTENTION.includes(value.attention);
}

export function isScheduleRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0) return false;
  if (value.conversation !== undefined &&
      (value.state !== "unavailable" || !isConversation(value.conversation))) return false;
  if (value.session !== undefined && (!value.session ||
      ["sessionId", "workspaceId", "providerId", "runnerPrincipal", "runnerInstance", "channelEpoch", "hostInstanceId", "terminalEpoch"]
        .some((key) => typeof value.session[key] !== "string" || !/^[A-Za-z0-9._:+-]{1,256}$/.test(value.session[key])) ||
      !/^[1-9][0-9]*$/.test(value.session.channelEpoch))) return false;
  return value.state === "unavailable"
    ? typeof value.errorCode === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(value.errorCode)
    : value.state === "observed" && value.session !== undefined &&
      ["starting", "running", "exited"].includes(value.lifecycle) &&
      ["working", "waiting"].includes(value.activity) &&
      ATTENTION.includes(value.attention);
}

// A run on the chat runtime has no terminal session to observe; a current
// backend adds its conversation state instead.
export function isScheduleChatRuntime(runtime) {
  return runtime?.state === "unavailable" && runtime.errorCode === "schedule_runtime_not_native";
}

export function scheduleRuntimeStatus(runtime) {
  if (!runtime) return undefined;
  if (runtime.state === "unavailable") {
    const conversation = runtime.conversation;
    if (conversation) {
      if (conversation.attention === "input_required") return "inputRequired";
      if (conversation.attention === "approval_required") return "approvalRequired";
      if (conversation.attention === "error") return "turnFailed";
      return conversation.activity === "working" ? "providerWorking" : "chatIdle";
    }
    // A scheduled agent sleeps after confirmed idle; a stop is final.
    if (runtime.errorCode === "schedule_runtime_sleeping") return "asleep";
    if (runtime.errorCode === "schedule_runtime_stopped") return "stopped";
    return "runtimeUnavailable";
  }
  if (runtime.lifecycle === "exited") return "exitedWithoutReport";
  if (runtime.attention === "input_required") return "inputRequired";
  if (runtime.attention === "approval_required") return "approvalRequired";
  if (runtime.attention === "error") return "providerError";
  if (runtime.lifecycle === "starting") return "providerStarting";
  return runtime.activity === "working" ? "providerWorking" : "providerWaiting";
}
