import { parseHookEvent } from "@/lib/agents/agentStateModel";
import { handleActivity } from "@/lib/agents/hookActivity";
import {
  decideHookReportRoute,
  resolveHookReportBinding,
} from "@/lib/agents/hookReportRouting";
import { hmux } from "@/lib/ipc";
import {
  conversationIdentityFromHook,
  hookSessionFenceEvidence,
} from "@/lib/sessions/managed/managedConversationIdentity";
import { providerFromCommand } from "@/lib/agents/providers";
import { bindingForAgent } from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";

/** Reports queued behind the one Host report in flight. The server already
 * caps the route at 60/s; this only absorbs a burst the Host folds more
 * slowly than it arrives. Past it the newest report is dropped — the Host's
 * fold semantics make a stale retry worse than a gap, and the gap is said. */
export const HOOK_REPORT_QUEUE_LIMIT = 256;

const pending: Array<Parameters<typeof hmux.reportAgentState>[0]> = [];
let inFlight = false;
let overflowSaid = false;

export function resetHookReportQueueForTests(): void {
  pending.length = 0;
  inFlight = false;
  overflowSaid = false;
}

/** One report at a time, in hook order: a Host fold applies in arrival order,
 * and two concurrent invokes carry no ordering between them. A failed report
 * is logged and the next one goes; a retry could land behind a newer report. */
function drain(): void {
  if (inFlight) return;
  const next = pending.shift();
  if (!next) return;
  inFlight = true;
  hmux
    .reportAgentState(next)
    .catch((error) => {
      console.warn("[hooks] Host state report failed", error);
    })
    .finally(() => {
      inFlight = false;
      drain();
    });
}

function enqueueHookReport(
  request: Parameters<typeof hmux.reportAgentState>[0],
): void {
  if (pending.length >= HOOK_REPORT_QUEUE_LIMIT) {
    if (!overflowSaid) {
      overflowSaid = true;
      console.warn(
        `[hooks] hook report queue is full (${HOOK_REPORT_QUEUE_LIMIT}); dropping newer reports until it drains`,
      );
    }
    return;
  }
  overflowSaid = false;
  pending.push(request);
  drain();
}

/** Route validated hook state into the Host-owned semantic projection. */
export function handleHookState(params: Record<string, unknown>): void {
  const parsed = parseHookEvent(params);
  if (!parsed) return;
  if (parsed.event === "UserPromptSubmit") handleActivity(params);
  const state = useStore.getState();
  const agent = state.agents.find(
    (candidate) => candidate.sessionId === parsed.sessionId,
  );
  const provider = providerFromCommand(parsed.provider ?? "");
  const conversationId = conversationIdentityFromHook(params);
  const fenceEvidence = hookSessionFenceEvidence(params);
  if (provider) state.setSessionAgentPin(parsed.sessionId, provider);
  const reportBinding = resolveHookReportBinding(
    agent ? bindingForAgent(agent, state.projects) : undefined,
    parsed.sessionId,
    fenceEvidence,
  );
  const route = decideHookReportRoute(
    reportBinding,
    parsed.state,
    parsed.terminalEvents,
    provider &&
      (agent ? provider === agent.provider : reportBinding !== undefined) &&
      conversationId &&
      fenceEvidence.kind !== "malformed"
      ? {
          providerId: provider,
          conversationId,
          ...(fenceEvidence.kind === "fenced"
            ? { expectedFence: fenceEvidence.fence }
            : {}),
        }
      : undefined,
  );
  if (!route) return;
  enqueueHookReport({
    sessionId: route.sessionId,
    workspaceId: route.workspaceId,
    ...route.report,
  });
}
