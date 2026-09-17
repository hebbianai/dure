/**
 * Design Mode 캡처를 어느 에이전트로 보낼지 (순수 판정).
 *
 * 기본값은 **마지막으로 사용자가 입력한 에이전트**다. Design Mode로 UI를
 * 클릭하는 동안 활성 pane은 계속 바뀌지만 사용자가 대화하던 에이전트는 그대로다.
 * 사용자가 다른 대상을 고를 수 있어야 하므로
 * 후보 목록도 함께 만든다.
 */

export interface AgentTargetCandidate {
	id: string;
	name: string;
	provider: string;
}

export interface AgentTargetChoice {
	/** 기본 선택 — 없으면 보낼 곳이 없다는 뜻이고, 호출자는 안내해야 한다. */
	defaultId?: string;
	candidates: AgentTargetCandidate[];
	/** 기본 선택이 무엇을 근거로 뽑혔는지. UI가 "최근 대화" 같은 힌트를 보일 때
	 *  쓰고, 근거 없이 첫 항목을 고른 경우를 구분한다. */
	reason: "last_input" | "only_candidate" | "first_candidate" | "none";
}

export function chooseAgentTarget(input: {
	candidates: readonly AgentTargetCandidate[];
	lastInputAgentId?: string;
}): AgentTargetChoice {
	const candidates = [...input.candidates];
	if (candidates.length === 0) {
		return { candidates, reason: "none" };
	}
	const last = input.lastInputAgentId;
	if (last && candidates.some((candidate) => candidate.id === last)) {
		return { defaultId: last, candidates, reason: "last_input" };
	}
	// 최근 입력이 없거나 그 에이전트가 사라졌다. 하나뿐이면 그것이 답이고,
	// 여럿이면 첫 번째를 제시하되 근거가 약함을 알린다 — UI가 선택을 강조할 수
	// 있어야 잘못된 pane으로 조용히 보내지 않는다.
	return {
		defaultId: candidates[0].id,
		candidates,
		reason: candidates.length === 1 ? "only_candidate" : "first_candidate",
	};
}
