// Hook reports become provider_event observations only through an exact Host
// route. Reports without one cannot become product runtime state.

import type { HookState } from "@/lib/agents/agentStateModel";
import { hmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { HMUX_LOCAL_SHELL_WORKSPACE_ID } from "@/lib/hmux/identity/hmuxProviderSessionSource";
import type {
  HookSessionFence,
  HookSessionFenceEvidence,
} from "@/lib/sessions/managed/managedConversationIdentity";
import {
  hmuxManagedBinding,
  type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import type { Provider } from "@/types";

/** working lease TTL. A hook install that also reports terminal events
 *  (Stop, Notification) holds the lease for the protocol maximum
 *  (AGENT_STATE_REPORT_MAX_WORKING_TTL_MS, 24h), the same lease the managed
 *  Claude, Codex and Pi reporters send: the turn ends at a semantic event,
 *  never at a timer, so a long tool call stays visibly busy. An install
 *  without terminal events only bridges prompt submit → first output with a
 *  30s hint. The Host owns expiry; the frontend keeps no matching timer. */
export const HOST_WORKING_TTL_STICKY_MS = 86_400_000;
export const HOST_WORKING_TTL_HINT_MS = 30_000;

export interface HookAgentStateReport {
  activity: "working" | "waiting";
  attention: "none" | "input_required" | "approval_required" | "error";
  turnCompleted: boolean;
  workingTtlMs?: number;
  conversationIdentity?: {
    providerId: Provider;
    conversationId: string;
    expectedFence?: HookSessionFence;
  };
}

/** 훅 4-state → host AgentStateReport 매핑 (DESIGN v2):
 *  working→(working,none,ttl), waiting→(waiting,none),
 *  blocked→(waiting,approval_required), done→(waiting,none,turn_completed). */
export function mapHookStateToReport(
  state: HookState,
  terminalEvents: boolean,
): HookAgentStateReport {
  switch (state) {
    case "working":
      return {
        activity: "working",
        attention: "none",
        turnCompleted: false,
        workingTtlMs: terminalEvents
          ? HOST_WORKING_TTL_STICKY_MS
          : HOST_WORKING_TTL_HINT_MS,
      };
    case "waiting":
      return { activity: "waiting", attention: "none", turnCompleted: false };
    case "blocked":
      return {
        activity: "waiting",
        attention: "approval_required",
        turnCompleted: false,
      };
    case "done":
      return { activity: "waiting", attention: "none", turnCompleted: true };
  }
}

export interface HookReportRoute {
  sessionId: string;
  workspaceId: string;
  report: HookAgentStateReport;
}

/** Resolve the Host route from an Agent binding or, before local-shell Agent
 * promotion, from the exact managed generation carried by a current hook. */
export function resolveHookReportBinding(
  binding: TerminalPaneBindingV1 | undefined,
  sessionId: string,
  fenceEvidence: HookSessionFenceEvidence,
): TerminalPaneBindingV1 | undefined {
  if (binding) return binding;
  if (
    fenceEvidence.kind !== "fenced" ||
    fenceEvidence.fence.sessionId !== sessionId ||
    fenceEvidence.fence.workspaceId !== HMUX_LOCAL_SHELL_WORKSPACE_ID
  ) {
    return undefined;
  }
  const fence = fenceEvidence.fence;
  return hmuxManagedBinding(
    fence.sessionId,
    fence.workspaceId,
    undefined,
    undefined,
    hmuxManagedGeneration(fence),
  );
}

/** Resolve a Host-owned report target. Unbound and retired runtime records
 * cannot authorize a semantic state mutation. */
export function decideHookReportRoute(
  binding: TerminalPaneBindingV1 | undefined,
  state: HookState,
  terminalEvents: boolean,
  conversationIdentity?: HookAgentStateReport["conversationIdentity"],
): HookReportRoute | null {
  if (
    binding?.runtime === "hmux_managed_v1" ||
    binding?.runtime === "hmux_standalone_v1"
  ) {
    return {
      sessionId: binding.sessionId,
      workspaceId: binding.workspaceId,
      report: {
        ...mapHookStateToReport(state, terminalEvents),
        ...(conversationIdentity ? { conversationIdentity } : {}),
      },
    };
  }
  return null;
}
