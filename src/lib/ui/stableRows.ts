// 파생 목록의 참조 안정화 (순수 로직).
//
// 고빈도 store 갱신(세션 activity·cwd·레이아웃 저장 등)마다 파생 훅이 목록을
// 새로 만들면, 내용이 같아도 배열·행 참조가 바뀌어 하위 memo가 전부 깨진다.
// 이전 결과와 얕은 비교로 같은 행은 이전 참조를 재사용하고, 전부 같으면
// 배열 자체도 이전 참조를 돌려준다 — 재계산 비용은 남지만 재렌더 파급이
// 끊긴다.

// 주의: 키 개수 + a쪽 키 순회 비교라 {x: undefined}와 {y: undefined}를 같다고
// 본다. 고정 키 집합의 행 객체(SpaceRow류)에는 도달 불가한 케이스지만, 다른
// 용도로 재사용한다면 키 집합이 고정인지 확인할 것.
function shallowEqualRecords(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function reuseStableRows<T extends Record<string, unknown>>(
  previous: readonly T[] | undefined,
  next: readonly T[],
): readonly T[] {
  if (!previous) return next;
  let reusedAll = previous.length === next.length;
  const merged = next.map((row, index) => {
    const before = previous[index];
    if (before && shallowEqualRecords(before, row)) return before;
    reusedAll = false;
    return row;
  });
  return reusedAll ? previous : merged;
}
