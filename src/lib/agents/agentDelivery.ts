import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { sendHmuxAgentCommandInput } from "@/lib/sessions/managed/managedAgentInput";
import type { Agent } from "@/types";

/** 여러 줄 텍스트가 TUI에서 줄마다 제출되지 않도록 bracketed paste로 감싼다
 *  (claude/codex TUI 모두 bracketed paste를 켠다). formatDiffComments 같은
 *  멀티라인 프롬프트를 raw로 쓰면 첫 줄에서 바로 제출돼 버린다. */
export function wrapBracketedPaste(text: string): string {
	return `\x1b[200~${text}\x1b[201~`;
}

/** Deliver a prompt to an agent and submit it. Every live agent is Hmux-bound
 *  (the legacy PTY/SSH direct-write path retired 2026-08-16); the shared Hmux
 *  client waits for the Host's semantic text/submit receipts, and an unbound
 *  (orphaned legacy) agent fails closed inside sendHmuxAgentCommandInput.
 *  Fresh spawn prompts use the separate Host-atomic one-shot operation. */
export async function deliverAgentPrompt(
	agent: Agent,
	text: string,
): Promise<void> {
	await sendHmuxAgentCommandInput(agent, wrapBracketedPaste(text), true);
	// 위임 입력도 완료 알림 사이클을 arm한다 — 단 전달이 성공했을 때만.
	// 실패한 전달의 arm은 다음 출력 플랩에서 유령 완료 알림이 된다.
	useAgentAttention.getState().armCompletion(agent.sessionId);
}

/** 프롬프트를 **입력만** 한다 — Enter를 보내지 않고 완료 알림도 arm하지
 *  않는다(미제출 프롬프트의 arm은 유령 완료 알림이 된다). 사용자가 내용을
 *  보고 제출하는 신뢰 규칙(DesignMode 캡처와 동일)이 필요한 표면용.
 *  멀티라인이 줄마다 제출되지 않도록 bracketed paste는 유지한다. */
export async function typeAgentPrompt(
	agent: Agent,
	text: string,
): Promise<void> {
	await sendHmuxAgentCommandInput(agent, wrapBracketedPaste(text), false);
}
