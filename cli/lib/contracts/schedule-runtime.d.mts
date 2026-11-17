export const SCHEDULE_RUNTIME_CAPABILITY: "schedule.runtime_observation_v1";
type Session = Record<"sessionId" | "workspaceId" | "providerId" | "runnerPrincipal" | "runnerInstance" | "channelEpoch" | "hostInstanceId" | "terminalEpoch", string>;
export type ScheduleRuntime = { observedAtMs: number } & ({
  state: "observed";
  session: Session;
  lifecycle: "starting" | "running" | "exited";
  activity: "working" | "waiting";
  attention: "none" | "input_required" | "approval_required" | "error";
} | {
  state: "unavailable";
  session?: Session;
  errorCode: string;
  /** Chat-runtime runs only, next to `schedule_runtime_not_native`. */
  conversation?: {
    activity: "working" | "waiting";
    attention: "none" | "input_required" | "approval_required" | "error";
  };
});
export function isScheduleRuntime(value: unknown): value is ScheduleRuntime;
export function isScheduleChatRuntime(runtime: ScheduleRuntime | undefined): boolean;
export function scheduleRuntimeStatus(runtime: ScheduleRuntime | undefined): "runtimeUnavailable" | "chatIdle" | "turnFailed" | "asleep" | "stopped" | "exitedWithoutReport" | "inputRequired" | "approvalRequired" | "providerError" | "providerStarting" | "providerWorking" | "providerWaiting" | undefined;
