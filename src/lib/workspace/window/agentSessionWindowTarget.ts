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

/**
 * 별도 큰 창이 안전하게 재사용할 수 있는 Agent runtime만 고른다.
 *
 * URL에는 agentId만 전달하고, 실제 Hmux identity는 persisted Agent registry에서
 * 다시 읽는다. sessionId/source가 Agent와 어긋난 오래된 레코드나 입력이 불가능한
 * 구형 observer-only binding은 새 창 진입점에서 fail closed 한다.
 */
export function agentSessionWindowBinding(
	agent: Pick<Agent, "runtimeBinding" | "sessionId" | "sessionKind">,
): TerminalPaneBindingV1 | undefined {
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
	return binding;
}
