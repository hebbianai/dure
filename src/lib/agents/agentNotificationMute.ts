import { useStore } from "@/store";
import type { Agent } from "@/types";

/**
 * Whether the person muted this agent's notifications.
 *
 * The flag silences alerts only: the desktop notification and the phone
 * push are both skipped by the notifier, and a paired phone reads it from the
 * catalog for its own local alerts. Attention is untouched, so a muted agent
 * still reaches Next up, Needs you and its unread dot.
 */
export function agentNotificationsMuted(
	agent: Pick<Agent, "notificationsMuted">,
): boolean {
	return agent.notificationsMuted === true;
}

/** Mutes or unmutes one agent. An unmuted agent carries no flag at all. */
export function setAgentNotificationsMuted(agentId: string, muted: boolean): void {
	useStore.setState((state) => {
		const target = state.agents.find((agent) => agent.id === agentId);
		if (!target || agentNotificationsMuted(target) === muted) return state;
		return {
			agents: state.agents.map((agent) => {
				if (agent.id !== agentId) return agent;
				const { notificationsMuted: _previous, ...rest } = agent;
				return muted ? { ...rest, notificationsMuted: true as const } : rest;
			}),
		};
	});
}

/** The menus' view of one agent's mute: undefined for a row with no agent. */
export function useAgentNotificationsMute(agentId: string | undefined): {
	muted: boolean | undefined;
	toggle: () => void;
} {
	const muted = useStore((state) => {
		const agent =
			agentId === undefined
				? undefined
				: state.agents.find((candidate) => candidate.id === agentId);
		return agent ? agentNotificationsMuted(agent) : undefined;
	});
	return {
		muted,
		toggle: () => {
			if (agentId !== undefined && muted !== undefined) {
				setAgentNotificationsMuted(agentId, !muted);
			}
		},
	};
}
