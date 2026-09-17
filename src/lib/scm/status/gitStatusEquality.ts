// GitStatus 동등성 (순수 로직) — git 폴링 결과가 변화 없으면 store 갱신을
// 단락해, 사이드바 에이전트 행들이 5초마다 참조 변경만으로 재렌더되는 것을
// 막는다. store.ts가 import하므로 store 의존이 없어야 한다(순환 방지 —
// lib/git.ts는 store를 import해서 이 함수를 둘 수 없다).
import type { GitStatus } from "@/types";

export interface GitStatusSlice {
  gitStatuses: Record<string, GitStatus>;
  gitStatusErrors: Record<string, string>;
}

/** setGitStatus의 다음 상태 계산. 변화가 없으면 null — 호출자(store)가 state
 *  자신을 반환해 zustand 리스너 통지 자체를 생략한다. 변화가 있으면 바뀐
 *  슬라이스만 담은 부분 갱신을 돌려준다(gitStatuses 참조 보존 포함). */
export function planGitStatusUpdate(
  current: GitStatusSlice,
  agentId: string,
  status: GitStatus,
): Partial<GitStatusSlice> | null {
  const unchanged = sameGitStatus(current.gitStatuses[agentId], status);
  const hasError = agentId in current.gitStatusErrors;
  if (unchanged && !hasError) return null;
  const update: Partial<GitStatusSlice> = {};
  if (!unchanged) update.gitStatuses = { ...current.gitStatuses, [agentId]: status };
  if (hasError) {
    const errors = { ...current.gitStatusErrors };
    delete errors[agentId];
    update.gitStatusErrors = errors;
  }
  return update;
}

export function sameGitStatus(a: GitStatus | undefined, b: GitStatus): boolean {
  if (a === undefined) return false;
  // 키 순회 비교 — GitStatus에 필드가 늘어도 자동으로 비교에 포함된다
  // (명시 나열식은 새 필드를 조용히 놓쳐 stale 표시를 만든다).
  for (const key of Object.keys(b) as (keyof GitStatus)[]) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
