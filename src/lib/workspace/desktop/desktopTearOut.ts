// desktop tear-out — 데스크탑 탭 드래그가 앱의 모든 창 밖에서 끝나면 그
// 데스크탑을 새 창으로 연다. DesktopBar의 ⧉ 버튼과 같은 미러링이고, 제스처만
// 추가한다(원본 바에 데스크탑은 남는다).
//
// 판정 기준을 "데스크탑 바 밖"이 아니라 "앱 창 밖"으로 잡은 이유: dockview는
// 워크스페이스 전역에서 dragover를 무조건 preventDefault한다(dnd/dnd.js의
// DragAndDropObserver, droptarget.js). 그래서 창 안에서 놓으면 payload를 아무도
// 안 받아도 dropEffect가 "move"로 끝나, 바 밖/안을 좌표로 갈라도 워크스페이스
// 위에서는 절대 발화하지 않는다. 창 밖에는 dockview가 없어 dropEffect가 "none"
// 으로 남는다 — paneTearOut이 같은 이유로 같은 기준을 쓴다.
import { appWindowRects, type ScreenRect } from "@/lib/workspace/pane/paneTearOut";
import { openDesktopWindow } from "@/lib/workspace/window/windows";

/** 창 가장자리에서 이만큼 더 벗어나야 분리로 친다(logical px).
 *  데스크탑 탭은 34px 크롬 바 안의 24px 탭이라 위쪽 가장자리가 창 상단에서
 *  5px밖에 안 떨어져 있다. 여백이 없으면 왼쪽으로 순서를 바꾸다 위로 살짝
 *  흘러 메뉴바에 놓는 것만으로 창이 열린다. paneTearOut은 dockview 탭이
 *  프레임 상단에서 42px 아래라 이 문제가 없어 여백이 없다. */
export const TEAR_OUT_MARGIN = 24;

export interface DesktopTearOutInput {
  /** 이번 드래그로 무장된 데스크탑. 우리 드래그가 아니면 null. */
  armedDesktopId: string | null;
  /** dragend 시점의 dataTransfer.dropEffect. */
  dropEffect?: string;
  /** dragend 시점의 스크린 좌표(screenX/screenY). */
  point: { x: number; y: number };
  /** 보이는 모든 앱 창의 스크린 사각형. 조회 실패 시 빈 배열. */
  windows: readonly ScreenRect[];
}

/** 새 창으로 열 데스크탑 id, 아니면 null (순수). */
export function desktopToTearOut(input: DesktopTearOutInput): string | null {
  const { armedDesktopId, dropEffect, point, windows } = input;
  if (!armedDesktopId) return null;
  // 앱 안의 드롭존이 받았으면(move/copy) 그쪽 의미가 우선 — 재정렬이 여기 걸린다.
  if (dropEffect && dropEffect !== "none") return null;
  // 창 목록이 비면(조회 실패) 분리하지 않는다 — 창 열기는 되돌리기 어렵다.
  if (windows.length === 0) return null;
  const clearOfEveryWindow = windows.every(
    (w) =>
      point.x < w.x - TEAR_OUT_MARGIN ||
      point.x > w.x + w.width + TEAR_OUT_MARGIN ||
      point.y < w.y - TEAR_OUT_MARGIN ||
      point.y > w.y + w.height + TEAR_OUT_MARGIN,
  );
  if (!clearOfEveryWindow) return null;
  return armedDesktopId;
}

let armed: string | null = null;
let listenerInstalled = false;

function disarm() {
  armed = null;
}

function onDragEnd(event: DragEvent) {
  const desktopId = armed;
  armed = null;
  if (!desktopId) return;
  // 앱 안의 드롭존이 받았으면 창 조회 자체를 하지 않는다 — 재정렬마다
  // getAllWindows + 창당 IPC 왕복을 도는 걸 막는다(paneTearOut과 동일).
  const dropEffect = event.dataTransfer?.dropEffect;
  if (dropEffect && dropEffect !== "none") return;
  const point = { x: event.screenX, y: event.screenY };
  void (async () => {
    const target = desktopToTearOut({
      armedDesktopId: desktopId,
      dropEffect,
      point,
      windows: await appWindowRects(),
    });
    if (target) await openDesktopWindow(target);
  })().catch(() => {
    // 창 조회·열기 실패는 조용히 넘긴다 — 분리하지 않는 쪽이 안전한 기본값이고,
    // 여기서 던지면 unhandled rejection이 된다.
  });
}

/** 데스크탑 탭 드래그 시작 시 호출 — 이번 드래그를 tear-out 후보로 무장. */
export function armDesktopTearOut(desktopId: string): void {
  armed = desktopId;
  if (listenerInstalled) return;
  listenerInstalled = true;
  window.addEventListener("dragend", onDragEnd, true);
  // dragend 유실(재정렬로 소스 노드가 옮겨지는 경우) 대비 — 다음 드래그
  // 시작에서 stale 무장을 해제한다. 캡처라 React의 버블 onDragStart 재무장보다
  // 먼저 실행돼 순서가 안전하다.
  window.addEventListener("dragstart", disarm, true);
  // 창 밖 ESC 취소는 dragend가 none+창밖이라 진짜 드롭과 구별 불가 — 취소
  // 키에서 해제한다. 다른 창으로 포커스가 넘어간 뒤의 ESC는 이 창에 오지
  // 않으므로 막지 못한다(paneTearOut과 같은 한계).
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") disarm();
    },
    true,
  );
}
