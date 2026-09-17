import { isAgentUnread, useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { handleHookState } from "@/lib/agents/hookReportHandler";
import { useStore } from "@/store";

type Wait = (milliseconds: number) => Promise<unknown>;

function hasAttentionDot(pattern: string): boolean {
	return Boolean(document.querySelector(`[title*="${pattern}"]`));
}

function reportHookState(
	state: "blocked" | "done" | "waiting",
	event: string,
): void {
	handleHookState({
		sessionId: "qa-none",
		provider: "claude",
		state,
		event,
		terminalEvents: true,
	});
}

/** Exercises the frontend half of the normalized hook pipeline. The real
 * managed Claude HTTP hook is covered separately by the clean-HOME Hmux
 * conversion smoke. */
export async function runDiffPaneHookProbe(
	agentId: string,
	wait: Wait,
): Promise<Record<string, string>> {
	// The fake session has an exited heuristic, so seed waiting before events.
	useStore.getState().setAgentActivity(agentId, "waiting");

	// The attention titles are t()-routed product copy and the default display
	// language is English, so match the resolved English strings.
	reportHookState("done", "Stop");
	await wait(1500);
	const hookDone = hasAttentionDot("Response complete") ? "OK" : "FAIL";

	reportHookState("blocked", "Notification");
	await wait(1500);
	const hookBlocked = hasAttentionDot("Approval required")
		? "OK"
		: "FAIL";

	reportHookState("waiting", "Notification");
	await wait(1500);
	const hookIdleWaiting = hasAttentionDot("Approval required")
		? "FAIL"
		: "OK";

	const attention = useAgentAttention.getState();
	const wasUnread = isAgentUnread(attention.episodes, attention.acks, agentId);
	useAgentAttention.getState().ack(agentId);
	const after = useAgentAttention.getState();
	const unreadAck =
		wasUnread && !isAgentUnread(after.episodes, after.acks, agentId)
			? "OK"
			: "FAIL";

	return { hookDone, hookBlocked, hookIdleWaiting, unreadAck };
}
