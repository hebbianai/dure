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
});
export function isScheduleRuntime(value: unknown): value is ScheduleRuntime;
export function scheduleRuntimeStatus(runtime: ScheduleRuntime | undefined): "runtimeUnavailable" | "exitedWithoutReport" | "inputRequired" | "approvalRequired" | "providerError" | "providerStarting" | "providerWorking" | "providerWaiting" | undefined;
