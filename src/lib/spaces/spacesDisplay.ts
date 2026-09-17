// Spaces 목록의 표시 상태 파생 — attention join(P0-1)의 순수 로직.
// 표시 상태 해석 자체는 attention watcher(agentAttentionWatch)가 소유한다;
// 여기는 그 결과를 목록 UI로 옮기는 랭크/정렬만 남는다.

import type { AgentDisplayState } from "@/lib/agents/agentStateModel";

/** 정렬 우선순위 — 주의가 필요한 것부터. error(고장)·blocked(승인)가 최상단,
 *  그다음 input(확인 대기), working, connecting, waiting, exited 순. */
export const DISPLAY_RANK: Record<AgentDisplayState, number> = {
  error: 0,
  blocked: 1,
  input: 2,
  working: 3,
  connecting: 4,
  waiting: 5,
  unknown: 6,
  exited: 7,
};

/** 미오픈 에이전트 정렬 — unread 우선, 그다음 표시 상태 랭크, 이름순.
 *  열린 스페이스 행은 패널 순서를 유지한다(상태 변화로 행이 커서 밑에서
 *  튀지 않게) — 정렬은 '대기열' 성격인 미오픈 목록에만 적용한다. */
export function compareUnopenedAgents(
  a: { unread: boolean; state: AgentDisplayState; name: string },
  b: { unread: boolean; state: AgentDisplayState; name: string },
): number {
  if (a.unread !== b.unread) return a.unread ? -1 : 1;
  if (DISPLAY_RANK[a.state] !== DISPLAY_RANK[b.state]) {
    return DISPLAY_RANK[a.state] - DISPLAY_RANK[b.state];
  }
  return a.name.localeCompare(b.name);
}

export interface RecentAgentActivity {
  text: string;
  at?: number;
}

/** Select one existing semantic activity without separating its text and time. */
export function latestAgentActivity(
  prompt?: RecentAgentActivity,
): RecentAgentActivity | undefined {
  return prompt;
}
