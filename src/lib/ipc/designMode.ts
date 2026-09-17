// ipc/designMode — Design Mode 요소 픽커.
//
// ipc.ts 도메인 분할 1단계(2026-08-01): 내용은 구 src/lib/ipc.ts에서 그대로
// 옮겨졌고, 소비자는 barrel(src/lib/ipc.ts)을 통해 기존 경로를 유지한다.
// invoke 래퍼는 이 디렉토리에만 둔다(architecture fitness 게이트가 강제).
import { invoke } from "@tauri-apps/api/core";

// ---------- design mode (요소 픽커) ----------

/** 사용자 앱 창을 열고 픽커를 주입한다. loopback URL만 허용된다(Rust에서 검증). */
export const designModeOpenBrowser = (
	url: string,
	script: string,
	nonce: string,
) => invoke<string>("design_mode_open_browser", { url, script, nonce });

export const designModeCloseBrowser = () =>
	invoke<void>("design_mode_close_browser");

/** 집은 요소를 크롭해 PNG로 저장하고 경로를 돌려준다. 화면 기록 권한이 없으면
 *  실패하고, 호출자는 그것을 무시하고 진행한다(fail-open). */
export const designModeScreenshot = (rect: {
	x: number;
	y: number;
	width: number;
	height: number;
}) => invoke<string>("design_mode_screenshot", rect);
