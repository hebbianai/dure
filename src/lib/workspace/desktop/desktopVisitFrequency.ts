/**
 * 최근 전환 이력에서 "자주 돌아가는 데스크탑"을 고른다 — LRU(최근성)와 공간
 * 이웃 prewarm이 놓치는 점프 패턴(⌘로 몇 개 데스크탑을 오가는 사용)을 warm
 * 유지 후보로 승격하기 위한 신호. 지수 감쇠 방문 점수라 오래된 방문은 잊힌다.
 */
export interface DesktopVisitSample {
  desktopId: string;
  sequence: number;
}

const DEFAULT_DECAY = 0.92;
const DEFAULT_LIMIT = 3;

export function frequentDesktopIds(
  transitions: readonly DesktopVisitSample[],
  options: {
    exclude?: readonly string[];
    limit?: number;
    decay?: number;
  } = {},
): string[] {
  const decay = options.decay ?? DEFAULT_DECAY;
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (limit <= 0 || transitions.length === 0) return [];
  const excluded = new Set(options.exclude ?? []);

  const ordered = [...transitions].sort((a, b) => a.sequence - b.sequence);
  const scores = new Map<string, number>();
  for (let index = 0; index < ordered.length; index += 1) {
    const age = ordered.length - 1 - index;
    const weight = decay ** age;
    const id = ordered[index].desktopId;
    scores.set(id, (scores.get(id) ?? 0) + weight);
  }

  return [...scores.entries()]
    .filter(([id]) => !excluded.has(id))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id]) => id);
}
