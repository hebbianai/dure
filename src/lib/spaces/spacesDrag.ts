// Spaces 행 드래그 세션 상태 — dataTransfer는 dragover에서 읽을 수 없어
// (Sidebar의 sidebarDrag와 같은 이유) 모듈 변수로 공유한다. Workspace 드롭은
// dataTransfer 페이로드(dure:{"type":"move-panels",...})를 쓰고, Spaces
// 내부의 데스크탑 헤더 드롭 타깃은 이 모듈 상태로 하이라이트를 판정한다.
import {
  createPaneTransferPayload,
  PANE_TRANSFER_MIME,
  serializePaneTransferPayload,
} from "@/lib/workspace/pane/paneWindowTransfer";
import { setDragState } from "@/lib/workspace/pane/paneDragState";
import {
  encodeDureDragPayload,
  stripDureDragPayloadPrefix,
} from "@/lib/platform/productDragPayload";

export interface SpacesDragItem {
  panelId: string;
  fromDesktopId: string;
}

let current: readonly SpacesDragItem[] | null = null;
let removeWindowSettled: (() => void) | null = null;

/** 드래그 중 소스 행이 unmount되면 dragend가 영원히 안 온다 — 창 레벨
 *  drop/dragend(capture)로 세션 종료를 보증해 stale 상태가 이후 무관한
 *  드래그의 드롭 게이트를 열지 않게 한다. */
function clearOnWindowSettled() {
  removeWindowSettled?.();
  const clear = () => endSpacesRowDrag();
  const clearAfterDrop = () => {
    const settledDrag = current;
    // Capture observes every drop, but the destination must consume the drag
    // identity before cleanup. WebKit performs a microtask checkpoint between
    // listeners on the event path, so cleanup must wait for the next task. The
    // identity check cannot clear a newer drag.
    setTimeout(() => {
      if (current === settledDrag) endSpacesRowDrag();
    }, 0);
  };
  window.addEventListener("drop", clearAfterDrop, true);
  window.addEventListener("dragend", clear, true);
  removeWindowSettled = () => {
    window.removeEventListener("drop", clearAfterDrop, true);
    window.removeEventListener("dragend", clear, true);
    removeWindowSettled = null;
  };
}

export function beginSpacesRowDrag(items: readonly SpacesDragItem[]): void {
  current = items;
  clearOnWindowSettled();
}

export function currentSpacesRowDrag(): readonly SpacesDragItem[] | null {
  return current;
}

export function endSpacesRowDrag(): void {
  removeWindowSettled?.();
  current = null;
  // source 행이 desktop 이동으로 unmount되면 dragend가 유실될 수 있다.
  // window drop 정리에서도 Dockview drag identity까지 같이 비운다.
  setDragState(null);
}

/** 드롭 시점의 진실은 dataTransfer 페이로드다 — 모듈 상태는 dragover
 *  하이라이트용일 뿐이고, 실제 이동 대상은 여기서 파싱한다 (stale 방지). */
export function parseSpacesDragPayload(raw: string): SpacesDragItem[] | null {
  const json = stripDureDragPayloadPrefix(raw);
  if (!json.startsWith("{")) return null;
  try {
    const spec = JSON.parse(json) as { type?: string; items?: unknown };
    if (spec.type !== "move-panels" || !Array.isArray(spec.items)) return null;
    return spec.items.filter(
      (item): item is SpacesDragItem =>
        typeof (item as SpacesDragItem)?.panelId === "string" &&
        typeof (item as SpacesDragItem)?.fromDesktopId === "string",
    );
  } catch {
    return null;
  }
}

/** 드래그 시작 행이 다중 선택에 포함돼 있으면 선택 전체가 함께 움직인다 —
 *  우클릭 메뉴의 targetsFor와 같은 규칙. 순수 함수. */
export function resolveSpacesDragItems(
  spaces: readonly { key: string; desktopId: string }[],
  selectedKeys: ReadonlySet<string>,
  draggedKey: string,
): SpacesDragItem[] {
  const keys = selectedKeys.has(draggedKey) ? selectedKeys : new Set([draggedKey]);
  return spaces
    .filter((space) => keys.has(space.key))
    .map((space) => ({ panelId: space.key, fromDesktopId: space.desktopId }));
}

/** Workspace onDidDrop이 파싱하는 dataTransfer 페이로드. */
export function spacesDragPayload(items: readonly SpacesDragItem[]): string {
  return encodeDureDragPayload({ type: "move-panels", items });
}

/** 단일 pane은 일반 Dockview pane과 같은 transfer flavor를 함께 싣는다.
 * text/plain은 Spaces의 데스크탑 헤더·다중 이동 호환 계약이라 유지한다. */
export function writeSpacesPaneDragData(
  dataTransfer: DataTransfer,
  items: readonly SpacesDragItem[],
  sourceWindowLabel: string,
): SpacesDragItem | null {
  dataTransfer.setData("text/plain", spacesDragPayload(items));
  dataTransfer.effectAllowed = "move";
  if (items.length !== 1) {
    setDragState(null);
    return null;
  }
  const [item] = items;
  dataTransfer.setData(
    PANE_TRANSFER_MIME,
    serializePaneTransferPayload(
      createPaneTransferPayload({ ...item, sourceWindowLabel }),
    ),
  );
  setDragState(item);
  return item;
}
