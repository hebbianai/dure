import type { Agent } from "@/types";

/** True when the agent is an orchestration worker — a delegate-once target
 * carrying a backend workflowDispatch receipt. Such a session's own "turn
 * finished" desktop notification is not the user's cue; the in-app unread dot
 * is unaffected.
 *
 * Quick-dispatch is deliberately NOT a signal here: its only caller is the
 * user-facing overlay, so a quick-dispatched agent is the user's own pane
 * and must keep notifying (2026-09-03 regression: tagging it silenced every
 * agent the user launched that way). */
export function isDispatchedAgent(
	agent: Pick<Agent, "workflowDispatch">,
): boolean {
	return agent.workflowDispatch !== undefined;
}
