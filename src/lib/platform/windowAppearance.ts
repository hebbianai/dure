import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { setNativeTitleBarColors } from "@/lib/ipc/system";
import {
  useResolvedDark,
  useResolvedUiSurfaceColors,
} from "@/lib/theme/themePreference";
import {
  type DesktopPlatform,
  detectDesktopPlatform,
} from "@/lib/workspace/desktop/desktopPlatform";

/** 앱 테마를 네이티브 창 외형 값으로 옮긴다. */
export function nativeWindowTheme(isDark: boolean): "dark" | "light" {
  return isDark ? "dark" : "light";
}

/** Windows already identifies the app through the taskbar. Keep useful
 * secondary-window context, but remove the redundant product prefix from the
 * native caption; the main window's bare "Dure" becomes empty. */
export function nativeWindowTitle(
  title: string,
  platform: DesktopPlatform = detectDesktopPlatform(),
): string {
  if (platform !== "windows") return title;
  if (title === "Dure") return "";
  return title.replace(/^Dure\s*[—-]\s*/, "").trim();
}

/**
 * 네이티브 창 외형(NSAppearance)을 앱 테마에 맞춘다.
 *
 * 셸 유리는 `windowEffects`의 NSVisualEffectView가 그리는데, 그 material은 창의
 * NSAppearance를 따른다. 앱 테마와 시스템 외형이 어긋나면 — 시스템 다크 + 앱
 * 라이트가 흔하다 — 라이트 UI 뒤에 어두운 material이 깔린다. 셸 틴트가 반투명
 * 하므로 그게 그대로 비쳐 사이드바가 검게 보인다(2026-07-31 실측, 사용자 보고).
 *
 * 그래서 창 외형을 시스템이 아니라 **앱 테마**에 맞춘다. 웹뷰 안의
 * `prefers-color-scheme`도 이 값을 따르므로, 테마가 "시스템"일 때는 읽은 값과
 * 쓰는 값이 같아 진동하지 않는다.
 */
export function useNativeWindowTheme(): void {
  const isDark = useResolvedDark();
  const { background, foreground } = useResolvedUiSurfaceColors();
  useEffect(() => {
    // 실패해도 앱은 정상 동작한다 — material이 시스템 외형을 따를 뿐이다.
    getCurrentWindow()
      .setTheme(nativeWindowTheme(isDark))
      .catch((error) => {
        console.warn("[glass] failed to match the window appearance to the theme", error);
      });
  }, [isDark]);
  useEffect(() => {
    // Windows owns the caption that contains minimize/maximize/close. Match it
    // to the same opaque app-floor token instead of leaving a system-coloured
    // strip above the webview. Other platforms implement this as a no-op.
    setNativeTitleBarColors(background, foreground).catch((error) => {
      console.warn("[window] failed to match the native title bar to the app surface", error);
    });
  }, [background, foreground]);
}
