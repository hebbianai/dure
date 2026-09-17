import { invoke } from "@tauri-apps/api/core";

// macOS 공유 시트는 화면 좌표에 앵커해야 한다. 메뉴 항목의 action 콜백에는
// 마우스 이벤트가 없는 경우가 있어(dockview 탭 메뉴), 마지막 포인터 위치를
// 캡처 단계에서 기억해 두고 그 자리에 시트를 띄운다.
let lastPointer = { x: 40, y: 40 };
if (typeof document !== "undefined") {
  document.addEventListener(
    "mousedown",
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    },
    true,
  );
}

/** 로컬 파일을 macOS 공유 시트(AirDrop·Telegram·KakaoTalk …)로 공유한다.
 *  시트는 마지막 포인터 위치(=메뉴를 클릭한 자리)에 앵커된다. */
export async function shareFileAtPointer(path: string): Promise<void> {
  try {
    await invoke<void>("share_file", { path, x: lastPointer.x, y: lastPointer.y });
  } catch (e) {
    console.error("Failed to share the file:", e);
  }
}
