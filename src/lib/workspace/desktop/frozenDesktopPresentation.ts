// frozen 데스크탑의 렌더 비용 강등 판정.
//
// Inactive Workspace shells keep Dockview and non-terminal pane-local state.
// TerminalView unmounts the terminal subtree of a frozen shell first, while a
// warm shell keeps its structured terminal attachments. content-visibility:
// hidden removes the remaining shell from style/layout/paint in both cases;
// a retained terminal never publishes canonical geometry from that skipped
// state (StructuredTerminalView allows it only on the active desktop); the
// next ResizeObserver delivery after the reveal finishes its geometry.
//
// active+visible terminal construction 중에는 문자 격자와 Dockview 배치가
// 레이아웃을 읽으므로 desktopConstructionLedger pending 동안 강등하지 않는다.
//
// mountSettled(짧은 벽시계)는 마운트 직후 dockview 레이아웃 복원과 panel
// boundary들의 ledger 등록이 아직 안 붙은 창을 덮는 보조 게이트다 —
// construction 자체는 ledger가 책임진다.
//
// Engines without content-visibility ignore the property: frozen shells still
// fall back to visibility:hidden, warm shells stay laid out off-screen.

/** dockview 첫 배치 복원 + boundary들의 ledger 등록이 붙기까지의 여유. */
export const FROZEN_CONSTRUCTION_SETTLE_MS = 2_000;

export function frozenDesktopSkipsRendering(state: {
  frozen: boolean;
  active: boolean;
  mountSettled: boolean;
  constructionPending: boolean;
}): boolean {
  return (
    !state.active &&
    state.mountSettled &&
    !state.constructionPending
  );
}
