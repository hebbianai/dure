/**
 * QR 스캐너 — 카메라가 있으면 카메라로, 없으면 붙여넣기로.
 *
 * ## 어떤 플러그인이 실제로 존재하는가
 *
 * Tauri 2에서 카메라에 닿는 공식 플러그인은 `@tauri-apps/plugin-barcode-scanner`
 * 하나이고, 지원 플랫폼은 **Android와 iOS뿐**이다. Rust 크레이트가 통째로
 * `#![cfg(mobile)]`이라 데스크탑 빌드에서는 아예 존재하지 않는다. 그래서
 * 데스크탑에서 `scan()`을 부르면 명령이 없다는 거부가 돌아온다 — 예외가 아니라
 * 설계된 결과다.
 *
 * 그 거부를 삼키지 않고 [[ScanUnavailable]]로 바꿔서 화면이 붙여넣기 칸을
 * 내놓는다. 페어링의 본체(코드 해석 → 키 생성 → 등록)는 스캔한 *문자열*만
 * 받으므로, 카메라 없는 환경에서도 같은 경로가 그대로 돈다. 데스크탑에서
 * 페어링을 시험할 수 있다는 뜻이고, 시험할 수 없는 코드는 검증되지 않은
 * 코드다.
 *
 * ## 권한
 *
 * 카메라 권한은 거절될 수 있고, "이번에 거절"과 "다시 묻지 마"는 다른 상태다.
 * 후자는 앱 안에서 되돌릴 방법이 없어서 설정 앱으로 보내야 한다 —
 * [[ScanOutcome]]이 둘을 구분하는 이유다.
 */

import { t } from "./i18n";

/** 스캔이 무엇을 만들어냈는가. 실패도 값이다 — 예외로 던지면 화면이 구분할 수 없다. */
export type ScanOutcome =
  | { kind: "scanned"; content: string }
  /** 사용자가 취소했다. 오류가 아니므로 배너를 띄우지 않는다. */
  | { kind: "cancelled" }
  /** 이 플랫폼에 카메라 플러그인이 없다. 붙여넣기로 넘어간다. */
  | { kind: "unavailable"; detail: string }
  /** 이번 요청에서 거절됨. 다시 물어볼 수 있다. */
  | { kind: "permission_denied" }
  /** 영구 거절. 앱 설정에서만 되돌릴 수 있다. */
  | { kind: "permission_blocked" }
  | { kind: "failed"; detail: string };

/** 플러그인 표면. 테스트에서 갈아끼우기 위해 주입 가능한 모양으로 둔다. */
export interface ScannerBridge {
  checkPermissions(): Promise<string>;
  requestPermissions(): Promise<string>;
  scan(options: { formats: string[]; windowed: boolean }): Promise<{ content: string }>;
  /**
   * Stop a scan that is still running.
   *
   * In windowed mode the camera keeps reading behind whatever the app draws
   * next, so leaving the scan screen has to say so. Optional because a bridge
   * that never started a scan has nothing to stop.
   */
  cancel?(): Promise<void>;
}

/** QR만 읽는다. 다른 바코드는 페어링 코드가 될 수 없고, 넓힐 이유가 없다. */
const QR_ONLY = ["QR_CODE"];

/**
 * Read once with the camera.
 *
 * `windowed: true` — the webview turns transparent and the camera shows
 * through it, which is what lets the scan screen (Figma 2865:76794) put its
 * scrim, reticle, hint and paste button *over* the camera. In full-screen mode
 * (`windowed: false`) the native scanner covers everything and none of that UI
 * is ever seen.
 *
 * This mode only works when **every surface the app paints has been pulled
 * away**. One left standing hides the camera behind it and the screen becomes a
 * black sheet with a reticle on it. The pulling away is the
 * `html[data-scan="on"]` rule in `styles.css`; setting and clearing that
 * attribute belongs to whoever opens the scan screen (`app.ts`), because
 * opening the camera and clearing the background have to happen in the same
 * screen transition.
 */
export async function scanPairingCode(bridge: ScannerBridge): Promise<ScanOutcome> {
  let permission: string;
  try {
    permission = await bridge.checkPermissions();
  } catch (error) {
    // 플러그인 자체가 없는 경우가 여기로 온다 — 데스크탑 빌드의 정상 경로다.
    return { kind: "unavailable", detail: describe(error) };
  }

  if (permission === "prompt" || permission === "prompt-with-rationale") {
    try {
      permission = await bridge.requestPermissions();
    } catch (error) {
      return { kind: "failed", detail: describe(error) };
    }
  }
  if (permission === "denied") return { kind: "permission_blocked" };
  if (permission !== "granted") return { kind: "permission_denied" };

  try {
    const scanned = await bridge.scan({ formats: QR_ONLY, windowed: true });
    return { kind: "scanned", content: scanned.content };
  } catch (error) {
    // 사용자가 뒤로 가기를 누르면 플러그인이 취소로 거부한다. 이것을 오류로
    // 띄우면 "취소했는데 왜 오류가 뜨지"가 된다.
    if (isCancellation(error)) return { kind: "cancelled" };
    return { kind: "failed", detail: describe(error) };
  }
}

function isCancellation(error: unknown): boolean {
  return /cancel/i.test(describe(error));
}

function describe(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    // Native plugin rejections cross IPC as plain objects, not Error instances.
    for (const key of ["message", "error"] as const) {
      const detail = (error as Record<string, unknown>)[key];
      if (typeof detail === "string" && detail.trim()) return detail;
    }
  }
  return t("pairing.scanner.failed");
}
