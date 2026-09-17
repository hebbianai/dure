// 데스크탑별 미완료 터미널 construction 원장.
//
// active+visible terminal construction이 레이아웃을 측정하는 동안 Workspace가
// content-visibility로 강등되지 않게 한다. TerminalView가 inactive/hidden pane을
// 이 boundary 전에 unmount하므로 이 원장에는 표시 가능한 construction만 온다.

const pendingByDesktop = new Map<string, Set<string>>();
const listenersByDesktop = new Map<string, Set<() => void>>();

function notify(desktopId: string) {
  for (const listener of listenersByDesktop.get(desktopId) ?? []) listener();
}

/** 미완료 construction 등록. 반환된 dispose는 완료·언마운트 공용이다 —
 *  boundary의 effect cleanup(constructed 전이·언마운트 둘 다 통과)에 그대로
 *  걸면 pending 구간과 등록 구간이 정확히 일치한다. */
export function trackDesktopTerminalConstruction(
  desktopId: string,
  terminalId: string,
): () => void {
  let pending = pendingByDesktop.get(desktopId);
  if (!pending) {
    pending = new Set();
    pendingByDesktop.set(desktopId, pending);
  }
  pending.add(terminalId);
  notify(desktopId);
  return () => {
    const current = pendingByDesktop.get(desktopId);
    if (!current?.delete(terminalId)) return;
    if (current.size === 0) pendingByDesktop.delete(desktopId);
    notify(desktopId);
  };
}

export function desktopConstructionPending(desktopId: string): boolean {
  return (pendingByDesktop.get(desktopId)?.size ?? 0) > 0;
}

export function subscribeDesktopConstruction(
  desktopId: string,
  listener: () => void,
): () => void {
  let listeners = listenersByDesktop.get(desktopId);
  if (!listeners) {
    listeners = new Set();
    listenersByDesktop.set(desktopId, listeners);
  }
  listeners.add(listener);
  return () => {
    // dispose와 같은 재조회 가드 — 캡처된 Set을 지우면 이중 해제가 새
    // 구독자의 Set을 맵에서 떼어내 통지가 조용히 끊긴다.
    const current = listenersByDesktop.get(desktopId);
    if (!current?.delete(listener)) return;
    if (current.size === 0) listenersByDesktop.delete(desktopId);
  };
}

export function resetDesktopConstructionLedgerForTest(): void {
  pendingByDesktop.clear();
  listenersByDesktop.clear();
}
