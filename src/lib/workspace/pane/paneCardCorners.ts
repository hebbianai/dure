import {
  subscribeTerminalDocumentResizeLifecycle,
  terminalDocumentResizePhase,
} from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";

/** pane 카드의 바깥 변·모서리 표시 — 어느 그룹의 어느 변과 모서리가 카드
 *  바깥에 닿는지 재서 알려준다.
 *
 *  Spaces 호버 오버레이(::after)는 그룹마다 그리는데, 컨테이너가
 *  --glass-radius-pane으로 클리핑하므로 그 모서리에 닿는 링은 같은 라운드를
 *  가져야 한다 — 사각이면 모서리가 호 바깥으로 나가 통째로 잘린다(2026-08-07
 *  사용자 보고). 안쪽 모서리는 시안대로 각지게 둔다. 포커스 링은 그룹 바깥
 *  box-shadow라 그룹의 라운드를 그대로 따라가므로 잴 것이 없다.
 *
 *  카드 외곽선 자체는 여기서 다루지 않는다. 컨테이너가 `p-px` +
 *  `.pane-card-surface`의 inset 링으로 긋는다 — 바깥 경계가 곧 컨테이너의
 *  경계라 변을 고를 필요가 없고, 그룹마다 링을 얹으면 둥근 모서리에서 검은
 *  선이 남았다(2026-08-10, index.css의 --glass-card-outline 주석).
 *
 *  dockview는 그룹을 절대좌표로 배치하고 분할 구조가 임의라 이 판정은 측정으로만
 *  가능하다. */

export type PaneCardCorner = "tl" | "tr" | "bl" | "br";

export interface PaneCardRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** dockview는 그룹을 소수 픽셀로 배치한다. 1px 이내는 같은 변으로 본다. */
const PANE_CARD_CORNER_TOLERANCE = 1;

export const PANE_CARD_CORNER_ATTRIBUTE = "data-pane-card-corners";

function touchedEdges(
  group: PaneCardRect,
  container: PaneCardRect,
  tolerance: number,
): Record<"top" | "right" | "bottom" | "left", boolean> {
  const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  return {
    top: near(group.top, container.top),
    right: near(group.right, container.right),
    bottom: near(group.bottom, container.bottom),
    left: near(group.left, container.left),
  };
}

export function paneCardCorners(
  group: PaneCardRect,
  container: PaneCardRect,
  tolerance: number = PANE_CARD_CORNER_TOLERANCE,
): PaneCardCorner[] {
  const { top, right, bottom, left } = touchedEdges(group, container, tolerance);
  const corners: PaneCardCorner[] = [];
  if (top && left) corners.push("tl");
  if (top && right) corners.push("tr");
  if (bottom && left) corners.push("bl");
  if (bottom && right) corners.push("br");
  return corners;
}

/** 값이 그대로면 쓰지 않는다 — 사시를 드래그하는 동안 매 프레임 attribute를
 *  쓰면 그룹 chrome 스타일이 계속 무효화된다. 바뀌었을 때만 true. */
export function applyPaneCardCorners(
  group: HTMLElement,
  corners: readonly PaneCardCorner[],
): boolean {
  const value = corners.join(" ");
  if ((group.getAttribute(PANE_CARD_CORNER_ATTRIBUTE) ?? "") === value)
    return false;
  if (value) group.setAttribute(PANE_CARD_CORNER_ATTRIBUTE, value);
  else group.removeAttribute(PANE_CARD_CORNER_ATTRIBUTE);
  return true;
}

function isMeasurable(rect: PaneCardRect): boolean {
  return rect.right > rect.left && rect.bottom > rect.top;
}

/** 그룹이 실제로 앉는 상자 — 컨테이너의 content box다.
 *
 *  컨테이너는 카드 외곽선을 padding 1px + inset ring으로 갖는다(index.css의
 *  --glass-card-outline). 그 1px을 빼지 않고 비교하면 두께가 1px 허용 오차를
 *  통째로 먹어, dockview의 소수 배치가 조금만 어긋나면 바깥 모서리를 놓친다 —
 *  그 그룹만 안쪽용 2px 라운드로 남아, 12px로 깎는 컨테이너 클리핑 안에서
 *  혼자 뾰족해 모서리가 잘려 보인다(2026-08-11 사용자 보고).
 *  clientLeft/clientWidth는 border까지만 걷어내므로 padding은 직접 뺀다. */
function containerContentBox(container: HTMLElement): PaneCardRect {
  const rect = container.getBoundingClientRect();
  const style = getComputedStyle(container);
  const pad = (value: string) => Number.parseFloat(value) || 0;
  const insetLeft = container.clientLeft + pad(style.paddingLeft);
  const insetTop = container.clientTop + pad(style.paddingTop);
  return {
    left: rect.left + insetLeft,
    top: rect.top + insetTop,
    right:
      rect.left + container.clientLeft + container.clientWidth - pad(style.paddingRight),
    bottom:
      rect.top + container.clientTop + container.clientHeight - pad(style.paddingBottom),
  };
}

/** 컨테이너 안의 모든 그룹을 다시 측정해 표시를 맞춘다.
 *
 *  숨은 데스크탑은 content-visibility로 자손 레이아웃이 없어 그룹이 0 크기로
 *  읽힌다. 그 값으로 덮어쓰면 다시 보일 때 모서리가 사라진 채로 남으므로,
 *  측정 불가한 대상은 직전 표시를 유지한다. */
export function syncPaneCardCorners(container: HTMLElement): void {
  const containerRect = containerContentBox(container);
  if (!isMeasurable(containerRect)) return;
  // 측정을 먼저 다 끝내고 나서 쓴다 — 읽기/쓰기를 번갈아 하면 강제 리플로우가
  // 그룹 수만큼 쌓인다(이 파일 근처의 기존 관측: Workspace.tsx 상단 주석).
  const measured: [HTMLElement, PaneCardCorner[]][] = [];
  for (const group of container.querySelectorAll<HTMLElement>(".dv-groupview")) {
    const rect = group.getBoundingClientRect();
    if (!isMeasurable(rect)) continue;
    measured.push([group, paneCardCorners(rect, containerRect)]);
  }
  for (const [group, corners] of measured) {
    applyPaneCardCorners(group, corners);
  }
}

export interface PaneCardCornersHandle {
  /** 지금 다시 측정한다 — 데스크탑이 다시 보이게 된 순간처럼, 레이아웃
   *  이벤트도 컨테이너 리사이즈도 없이 측정 가능해지는 경계에서 필요하다. */
  readonly refresh: () => void;
  readonly dispose: () => void;
}

/** Keep the marks in step with the geometry dockview actually laid out: every
 *  layout event and every group box change re-measures, batched to one read
 *  per frame so a sash drag's event storm cannot pile up forced reflows. */
export function installPaneCardCorners({
  container,
  onLayoutChange,
}: {
  container: HTMLElement;
  /** dockview api.onDidLayoutChange — disposable을 돌려준다 */
  onLayoutChange: (listener: () => void) => { dispose: () => void };
}): PaneCardCornersHandle {
  let frame: number | undefined;
  const cancelScheduledMeasurement = () => {
    if (frame === undefined) return;
    cancelAnimationFrame(frame);
    frame = undefined;
  };
  const scheduleMeasurement = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      syncPaneCardCorners(container);
    });
  };
  const schedule = () => {
    if (terminalDocumentResizePhase(container.ownerDocument) !== "idle") return;
    scheduleMeasurement();
  };

  // Measure when a group's box changes, not when the container's does. The
  // groups are what dockview lays out: a window resize or sidebar toggle
  // reaches them through dockview-react's own ResizeObserver → api.layout(),
  // which emits no layout event, and a layout restored at another window's
  // size is only laid out to this container by that same path. Watching the
  // container instead measured before that relayout — and on a frozen
  // desktop (content-visibility: hidden) WebKit never relays the grid out at
  // all while the container keeps tracking the window, so each measurement
  // compared stale group boxes against the live card and wrote wrong marks
  // that nothing corrected until an unrelated change (2026-09-03, one moved
  // pane alone in a space lost all four card corners).
  const observer = new ResizeObserver(schedule);
  const observed = new Set<Element>();
  const watchGroups = () => {
    const present = new Set<Element>(
      container.querySelectorAll(".dv-groupview"),
    );
    for (const group of present) {
      if (observed.has(group)) continue;
      observed.add(group);
      observer.observe(group);
    }
    for (const group of observed) {
      if (present.has(group)) continue;
      observed.delete(group);
      observer.unobserve(group);
    }
  };
  const layout = onLayoutChange(() => {
    watchGroups();
    schedule();
  });
  const stopResizeLifecycle = subscribeTerminalDocumentResizeLifecycle(
    container.ownerDocument,
    {
      begin: cancelScheduledMeasurement,
      settle: scheduleMeasurement,
    },
  );
  watchGroups();
  schedule();

  return {
    refresh: schedule,
    dispose: () => {
      cancelScheduledMeasurement();
      layout.dispose();
      observer.disconnect();
      observed.clear();
      stopResizeLifecycle();
    },
  };
}
