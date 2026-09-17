/**
 * 사용자가 마지막으로 입력한 에이전트 (프레젠테이션 상태).
 *
 * 왜 필요한가: Design Mode로 UI를 클릭하는 동안 활성 pane은 계속 바뀌지만
 * 사용자가 **대화하던** 에이전트는 그대로다. 캡처를 보낼 기본 대상은 활성
 * pane이 아니라 이 값이다.
 *
 * store.ts에 두지 않은 이유: 이것은 세션 런타임 사실이 아니라 UI 표면의 최근성
 * 힌트이고, store는 god-file 래칫 상한 바로 아래다. 영속화하지 않는다 — 앱을
 * 다시 켰을 때 "마지막으로 입력한" 것은 이미 의미가 없다.
 */
const state = {
	agentId: undefined as string | undefined,
	at: 0,
};

/** 사용자 키스트로크가 이 에이전트로 갔다. 출력·프로그램 입력이 아니라 사용자
 *  입력에서만 부른다 — 에이전트가 스스로 떠드는 것은 최근성이 아니다. */
export function recordAgentInput(agentId: string, nowMs = Date.now()): void {
	state.agentId = agentId;
	state.at = nowMs;
}

/** 마지막으로 입력한 에이전트. 아직 없으면 undefined. */
export function lastInputAgentId(): string | undefined {
	return state.agentId;
}

export function lastInputAtMs(): number {
	return state.at;
}

/** 그 에이전트가 사라졌을 때 남은 참조를 지운다 — 없는 에이전트를 기본 대상으로
 *  제시하면 사용자가 보낸 뒤에야 실패를 알게 된다. */
export function forgetAgentInput(agentId: string): void {
	if (state.agentId !== agentId) return;
	state.agentId = undefined;
	state.at = 0;
}

/** 테스트 전용 초기화. */
export function resetAgentInputRecency(): void {
	state.agentId = undefined;
	state.at = 0;
}
