// pane tear-out — dockview pane 드래그가 앱의 모든 창 밖에서 끝나면 그
// pane을 별도 OS 창(popout 데스크탑)으로 분리한다 (hebbian-frontend-mqo7).
//
// dock.ts의 dragState는 여러 dragend 리스너(DesktopBar 정리 등)가 지우므로
// 실행 순서에 기대지 않고, 드래그 시작 시(armPaneTearOut) 자체 사본을 들고
// dragend에서 판정한다. 사이드바 항목 드래그(spacesDrag)는 이 경로를 타지
// 않는다 — dockview pane 드래그(onWillDragPanel)만 무장된다.
import { popOutPanels } from "@/lib/workspace/window/popout";
import { isDesktopWorkspaceWindowLabel } from "@/lib/workspace/desktop/desktopVisibilityLease";
import {
	createPaneWindowDropRequest,
	PANE_WINDOW_DROP_EVENT,
	paneDragReleaseTarget,
	type LabeledScreenRect,
	type PaneTransferPayload,
} from "@/lib/workspace/pane/paneWindowTransfer";

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 스크린 좌표가 모든 창 사각형 밖인가 — tear-out 판정 (순수).
 *  경계선 위(모서리 정확히)는 안쪽으로 본다: 창끝에서 놓친 드롭이 의도치
 *  않은 분리를 만들지 않게. 창 목록이 비면(조회 실패) 분리하지 않는다. */
export function isOutsideAllWindows(
  point: { x: number; y: number },
  windows: readonly ScreenRect[],
): boolean {
  if (windows.length === 0) return false;
  return windows.every(
    (w) =>
      point.x < w.x || point.x > w.x + w.width || point.y < w.y || point.y > w.y + w.height,
  );
}

/** 모든 앱 창의 스크린 사각형(logical px) — DragEvent.screenX/Y와 같은 좌표계.
 *  Tauri는 physical을 주므로 각 창의 scaleFactor로 나눈다. */
export async function appWindowRects(): Promise<LabeledScreenRect[]> {
  const { getAllWindows } = await import("@tauri-apps/api/window");
  const rects = await Promise.all(
    (await getAllWindows()).map(async (w): Promise<LabeledScreenRect | null> => {
      try {
        const [position, size, scale, focused, visible, minimized] =
          await Promise.all([
            w.outerPosition(),
            w.outerSize(),
            w.scaleFactor(),
            w.isFocused().catch(() => false),
            w.isVisible(),
            w.isMinimized(),
          ]);
        if (!visible || minimized) return null;
        return {
          label: w.label,
          x: position.x / scale,
          y: position.y / scale,
          width: size.width / scale,
          height: size.height / scale,
          workspace: isDesktopWorkspaceWindowLabel(w.label),
          focused,
        };
      } catch {
        return null;
      }
    }),
  );
  return rects.filter((rect): rect is LabeledScreenRect => rect !== null);
}

let armed: PaneTransferPayload | null = null;
let listenerInstalled = false;

function onDragEnd(event: DragEvent) {
  const drag = armed;
  armed = null;
  if (!drag) return;
  // 내부 드롭존이 받았으면(move/copy) tear-out 아님 — none만 후보.
  if (event.dataTransfer && event.dataTransfer.dropEffect !== "none") return;
  const point = { x: event.screenX, y: event.screenY };
  void (async () => {
    const windows = await appWindowRects();
    const target = paneDragReleaseTarget(
      point,
      drag.sourceWindowLabel,
      windows,
    );
    if (target.kind === "workspace") {
      const { emitTo } = await import("@tauri-apps/api/event");
      await emitTo(
        { kind: "WebviewWindow", label: target.windowLabel },
        PANE_WINDOW_DROP_EVENT,
        createPaneWindowDropRequest(drag, target.windowLabel, point),
      ).catch(() => null);
      return;
    }
    if (target.kind !== "outside") return;
    await popOutPanels(drag.fromDesktopId, [drag.panelId]).catch(() => null);
  })();
}

function disarm() {
  armed = null;
}

/** dockview pane 드래그 시작 시 호출 — 이번 드래그를 tear-out 후보로 무장. */
export function armPaneTearOut(drag: PaneTransferPayload): void {
  armed = drag;
  if (listenerInstalled) return;
  listenerInstalled = true;
  window.addEventListener("dragend", onDragEnd, true);
  // dragend 유실(드래그 중 소스 DOM 제거·재배치) 대비 — 다음 드래그 시작에서
  // stale 무장을 해제한다. 캡처라 dockview dragstart(버블) → onWillDragPanel
  // 재무장보다 먼저 실행돼 순서가 안전하다.
  window.addEventListener("dragstart", disarm, true);
  // 창 밖 ESC 취소는 dragend가 none+창밖이라 진짜 드롭과 구별 불가 — 취소
  // 키에서 해제한다 (드래그 중이 아닐 때의 ESC disarm은 무해한 no-op).
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") disarm();
    },
    true,
  );
}
