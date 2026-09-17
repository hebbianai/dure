// 데스크탑 탭 스트립의 표시 순서 — 설정 › 일반 › 탐색 › 탭 순서.
//
// "수동"은 사용자가 끌어다 놓은 순서(store의 spaces 배열)를 그대로 쓰고,
// "가장 최근"은 마지막으로 머문 시각이 늦은 탭을 앞으로 보낸다. 정렬만 하는
// 순수 모듈이라 vitest에서 그대로 검증한다.

export type TabOrder = "recent" | "manual";

/** 데스크탑별 마지막 활성 시각(ms). 없는 항목은 "아직 안 가봤다"로 본다. */
export type DesktopVisitTimes = Readonly<Record<string, number>>;

/**
 * 탭 순서 설정에 맞춰 정렬한다.
 *
 * - manual: 입력 배열을 그대로 (같은 배열 참조를 돌려줘 불필요한 리렌더를 피한다)
 * - recent: 최근 방문이 앞. 방문 기록이 없는 탭은 수동 순서를 유지한 채 뒤에 붙는다
 *   — 새로 만든 데스크탑이 아직 안 가봤다는 이유로 맨 앞이나 맨 뒤로 튀지 않게.
 *
 * 같은 시각이면 수동 순서로 안정 정렬한다(Array.sort는 안정 정렬이 보장된다).
 */
export function orderDesktopTabs<T extends { id: string }>(
  spaces: readonly T[],
  order: TabOrder,
  visits: DesktopVisitTimes,
): readonly T[] {
  if (order !== "recent" || spaces.length < 2) return spaces;

  const visited: T[] = [];
  const unvisited: T[] = [];
  for (const desktop of spaces) {
    if (typeof visits[desktop.id] === "number") visited.push(desktop);
    else unvisited.push(desktop);
  }
  visited.sort((a, b) => (visits[b.id] as number) - (visits[a.id] as number));
  return [...visited, ...unvisited];
}

/** 활성 데스크탑이 바뀔 때 기록을 갱신한다. 사라진 데스크탑의 기록은 함께
 *  버려 영구 저장소가 계속 자라지 않게 한다. */
export function recordDesktopVisit(
  visits: DesktopVisitTimes,
  desktopId: string,
  now: number,
  liveDesktopIds: readonly string[],
): Record<string, number> {
  const live = new Set(liveDesktopIds);
  live.add(desktopId);
  const next: Record<string, number> = {};
  for (const [id, at] of Object.entries(visits)) {
    if (live.has(id)) next[id] = at;
  }
  next[desktopId] = now;
  return next;
}

/** 최근순 모드에서는 끌어다 놓기가 의미를 잃는다 — 다음 전환에 바로 덮어써지므로
 *  손잡이 자체를 내려 "왜 안 먹지?"를 없앤다. */
export function allowsManualReorder(order: TabOrder): boolean {
  return order === "manual";
}
