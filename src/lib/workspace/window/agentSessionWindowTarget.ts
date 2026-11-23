import {
	type AgentStructuredInteractionProfileV1,
	normalizeAgentInteractionProfileV1,
} from "@/lib/agents/chat/agentInteractionProfile";
import {
	isHmuxControllerPaneBinding,
	isRemoteHmuxPaneBinding,
	normalizeTerminalPaneBindingV1,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import type { Agent } from "@/types";

const SESSION_KIND_BY_SOURCE: Record<
	TerminalPaneBindingV1["source"],
	Agent["sessionKind"]
> = {
	local: "pty",
	ssh: "ssh",
};

/** What an Agent's large window presents: the same view its pane uses. A
 * Terminal Agent's Hmux pane binding, or a Chat Agent's interaction session. */
export type AgentSessionWindowTarget =
	| { readonly kind: "terminal"; readonly binding: TerminalPaneBindingV1 }
	| {
			readonly kind: "chat";
			readonly profile: AgentStructuredInteractionProfileV1;
	  };

/**
 * 별도 큰 창이 안전하게 보여줄 수 있는 Agent runtime만 고른다.
 *
 * URL에는 agentId만 전달하고, 실제 identity는 persisted Agent registry에서 다시
 * 읽는다. Chat Agent는 backend interaction profile로, Terminal Agent는 Hmux
 * binding으로 고른다. 두 identity를 동시에 가진 레코드, sessionId/source가 Agent와
 * 어긋난 오래된 레코드, 입력이 불가능한 구형 observer-only binding은 fail closed
 * 한다.
 */
export function agentSessionWindowTarget(
	agent: Pick<
		Agent,
		"interactionProfile" | "runtimeBinding" | "sessionId" | "sessionKind"
	>,
): AgentSessionWindowTarget | undefined {
	if (agent.interactionProfile !== undefined) {
		const profile = normalizeAgentInteractionProfileV1(
			agent.interactionProfile,
		);
		// Persistence refuses a Chat profile beside a terminal binding: that
		// record names two runtimes, so neither is the Agent's.
		return profile && agent.runtimeBinding === undefined
			? { kind: "chat", profile }
			: undefined;
	}
	const binding = normalizeTerminalPaneBindingV1(agent.runtimeBinding);
	if (
		!binding ||
		(!isHmuxControllerPaneBinding(binding) &&
			!isRemoteHmuxPaneBinding(binding)) ||
		binding.sessionId !== agent.sessionId ||
		SESSION_KIND_BY_SOURCE[binding.source] !== agent.sessionKind
	) {
		return undefined;
	}
	return { kind: "terminal", binding };
}

/** One presentation generation of the window. Readiness reported for an
 * earlier key never marks a later presentation ready. */
export function agentSessionWindowTargetKey(
	target: AgentSessionWindowTarget | undefined,
): string | undefined {
	if (!target) return undefined;
	return target.kind === "terminal"
		? JSON.stringify(["terminal", target.binding.sessionId])
		: JSON.stringify([
				"chat",
				target.profile.backendProfileId,
				target.profile.interactionSessionId,
			]);
}
