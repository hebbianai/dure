import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { isMacPlatform } from "@/lib/workspace/desktop/desktopPlatform";
import { subscribeCurrentWindowResize } from "@/lib/workspace/window/currentWindowResize";

/**
 * 셸의 창 chrome — 모서리·테두리·그림자는 창 모드 전용이다.
 *
 * 전체화면은 창 모서리라는 개념 자체가 없다. 화면을 꽉 채운 창을 CSS로 깎으면
 * 그 자리에 창 뒤가 비쳐 보이고(측정: 화면 가장자리 1px + 네 모서리에 회색
 * 조각), 테두리·그림자도 그릴 자리가 없다.
 *
 * 네이티브 모서리는 창의 `windowEffects.radius`가 깎는다
 * (`windows.ts`의 `GLASS_WINDOW_NATIVE_OPTIONS`). 여기 CSS 반경은 그 값과 같아야
 * 한다 — 어긋난 만큼 모서리에 쐐기가 생기고, `windows.test.ts`가 그걸 잡는다.
 */
/**
 * 창 모서리 반경. macOS 네이티브 창을 실측해서 맞춘 값이다(2026-08-01):
 * 같은 스크린샷 안에서 네이티브 앱 창의 좌상단 호는 이미지 34~36px이고, 우리
 * 창(당시 10px)의 호가 27.6px이었다 — 배율 2.76을 적용하면 12~13pt다.
 * 그전 값 10px은 여기서 두 단 모자랐다.
 */
export const SHELL_CORNER_RADIUS = 12;

/**
 * 셸 표면의 모서리/그림자. 전체화면에서는 전부 뗀다.
 *
 * 테두리는 `border`가 아니라 그림자 계열이 그린다 — 레이아웃 박스를 늘리지
 * 않는다. `shadow-shell`의 흰 20% inset 링은 어두운 배경 전용이라, 밝은
 * 배경·라이트 테마에서 창이 뒤와 섞였다(2026-08-17 사용자 제보). 테마
 * 인지 링을 겹쳐 양쪽 테마에서 얇은 경계가 남는다. 색은 foreground/15 —
 * border 토큰은 자체 알파(10%)에 /60이 곱해져 ~6%로 사실상 투명했다
 * (2026-08-17 사용자 재제보).
 * (index.css `--glass-shadow-shell`). 링은 레이아웃 박스를 늘리지 않아 셸 안쪽
 * 여백 계산이 테두리 유무에 흔들리지 않는다.
 *
 * 여기서 CSS 반경을 떼는 것만으로는 전체화면 모서리가 펴지지 않는다 — 창의
 * `windowEffects.radius`가 네이티브로 따로 깎기 때문이다. 그쪽은
 * useNativeShellRadius가 맞춘다.
 */
function windowUsesCustomShell(fullscreen: boolean, macPlatform: boolean): boolean {
  return macPlatform && !fullscreen;
}

/** The CSS frame complements the frameless macOS overlay window. Windows and
 * Linux keep their native frame, so shaping the React root would draw a second
 * window inside it. */
export function shellChromeClass(
  fullscreen: boolean,
  macPlatform = isMacPlatform(),
): string {
  return windowUsesCustomShell(fullscreen, macPlatform)
    ? "rounded-[12px] shadow-shell"
    : "";
}

/** 셸 가장자리 경계 오버레이 — 루트의 inset 그림자·링은 가장자리까지 채우는
 *  자식(헤더·본문)이 위에 덮어 보이지 않는다(2026-08-17 사용자 제보 2회로
 *  확인). 그래서 경계선은 자식들 뒤가 아니라 위에, pointer-events 없는
 *  absolute 오버레이로 그린다. 색은 foreground/15 — border 토큰은 자체
 *  알파(10%)에 /60이 곱해져 ~6%로 사실상 투명했고, shadow-shell의 흰 림은
 *  라이트 테마에서 소멸한다. Tailwind v4라 v3의 ring-inset이 아니라
 *  inset-ring 유틸리티를 쓴다. 전체화면에서는 렌더하지 않는다. */
export function shellEdgeOverlayClass(
  fullscreen: boolean,
  macPlatform = isMacPlatform(),
): string {
  if (!windowUsesCustomShell(fullscreen, macPlatform)) return "";
  return "pointer-events-none absolute inset-0 z-50 rounded-[12px] inset-ring-1 inset-ring-foreground/15";
}

/**
 * chrome 줄 맨 앞 신호등 자리의 폭(px) (Figma 464:27438).
 *
 * macOS 창 모드에서는 네이티브 신호등(titleBarStyle=Overlay)이 그 82px 위에
 * 얹히므로 비워 둬야 한다. 전체화면에서는 macOS가 신호등을 감추고, 마우스를
 * 위로 올렸을 때만 OS가 자기 오버레이 바를 이 줄 *위에* 내려 덮는다 — 앱이
 * 자리를 비켜 줄 이유가 없다. 그래서 데스크탑 탭이 왼쪽에 붙는다(사용자 요청).
 * 전체화면 값 14px은 시안 2156:23585의 chrome 줄 좌우 여백(px-14)이다 —
 * 예전엔 셸 여백(App.tsx pl-2)에 맞춘 8px이었는데, 시안은 chrome 줄을 그보다
 * 살짝 넓게 잡는다.
 *
 * macOS가 아니면 네이티브 창 장식이 남으므로 신호등 자리라는 개념이 없고,
 * 콘텐츠 여백만 둔다 — 전체화면 여부와 무관하다.
 */
export function trafficLightSpacerWidth(
  macPlatform: boolean,
  fullscreen: boolean,
  /** 네이티브에서 실측한 신호등 오른쪽 끝(창 왼쪽 기준 px). 없으면 폴백. */
  measuredRight?: number | null,
): number {
  if (!macPlatform) return NON_MAC_CONTENT_INSET;
  if (fullscreen) return FULLSCREEN_CHROME_INSET;
  // 실측이 있으면 그 끝에서 정확히 WORDMARK_GAP 뒤에 워드마크를 붙인다.
  // 버튼 지름·간격은 macOS가 정하고 버전마다 흔들려서 상수로는 못 맞춘다.
  if (measuredRight != null && measuredRight > 0) {
    return measuredRight + WORDMARK_GAP;
  }
  return TRAFFIC_LIGHT_RESERVE;
}

/**
 * 사이드바가 접혔을 때 토글 버튼 박스의 왼쪽 여백(px).
 *
 * 시안 2156:24653은 16px 토글 아이콘을 `px-14`로 감싼다 — 글리프가 창 왼쪽에서
 * 정확히 14px에 온다. 우리 토글은 히트 영역 때문에 24px 버튼이고 글리프가 그
 * 안에서 4px 들어가 있으므로, 버튼 박스는 (여백 - 4)에서 시작해야 글리프가
 * 여백 위치에 온다. 펼침 상태는 워드마크가 그 자리를 쓰므로 해당 없다.
 *
 * 창 모드에서는 여백이 신호등 자리(82px)라 글리프가 신호등 바로 뒤에 온다 —
 * 버튼 박스만 4px 앞서지만 네이티브 신호등이 그 위에 그려지므로 가려지지
 * 않는다.
 */
export function collapsedToggleInset(
  macPlatform: boolean,
  fullscreen: boolean,
  measuredRight?: number | null,
): number {
  return trafficLightSpacerWidth(macPlatform, fullscreen, measuredRight) - TOGGLE_GLYPH_INSET;
}

/**
 * 접힘 상태에서 토글을 사이드바 레일 밖(워크스페이스 줄)에 둘지.
 *
 * 레일은 52px뿐이라 그 안에서는 토글이 신호등 위에 겹친다 — 오른쪽 끝에 붙으면
 * 글리프가 창 왼쪽 22px, 즉 닫기 버튼 정중앙에 온다(2026-08-07 사용자 보고).
 * 전체화면에서는 신호등이 없으므로 옮길 이유가 없다.
 */
export function collapsedToggleLeavesRail(
  macPlatform: boolean,
  fullscreen: boolean,
): boolean {
  return macPlatform && !fullscreen;
}

/**
 * 워크스페이스 줄 안에서 접힘 토글 버튼 박스의 왼쪽 여백(px).
 *
 * 펼쳤을 때 워드마크가 서는 창 좌표에 글리프를 맞춘다(사용자 요청 2026-08-07) —
 * 그 값에서 레일 폭을 빼면 이 줄 기준 좌표가 된다. 음수면 0으로 접는다.
 */
export function collapsedToggleWorkspaceInset(
  macPlatform: boolean,
  fullscreen: boolean,
  railWidth: number,
  measuredRight?: number | null,
): number {
  const wordmark = trafficLightSpacerWidth(macPlatform, fullscreen, measuredRight);
  return Math.max(0, wordmark - TOGGLE_GLYPH_INSET - railWidth);
}

/** 24px 토글 버튼 안에서 16px 글리프가 들어가 있는 거리. */
const TOGGLE_GLYPH_INSET = 4;

/** 신호등 오른쪽 끝과 워드마크 사이 간격 (사용자 지정 2026-08-07). */
const WORDMARK_GAP = 14;
/** 실측을 아직 못 받았을 때 쓰는 신호등 폭. 실측이 오면 대체된다. */
const TRAFFIC_LIGHT_RESERVE = 82;
/** 전체화면 chrome 줄의 좌우 여백 (시안 2156:23585 `px-14`). */
const FULLSCREEN_CHROME_INSET = 14;
/** 네이티브 창 장식이 남는 플랫폼의 콘텐츠 여백. */
const NON_MAC_CONTENT_INSET = 12;
/** chrome 줄 사이드바 열의 최소 폭 — 워드마크가 읽히는 하한. */
const CHROME_SIDEBAR_MIN_WIDTH = 207;

/**
 * 토글 컬럼의 오른쪽 여백(px).
 *
 * 시안 여백(14px)에서 버튼 안 글리프 오프셋(4px)을 뺀 값이다 — 24px 버튼 안에서
 * 16px 글리프가 4px 들어가 있으므로, 박스를 10px에 세워야 글리프가 14px에 온다.
 * 왼쪽과 달리 신호등과 무관하므로 창/전체화면 구분이 없다. 결과적으로 접힘
 * 컬럼은 10 + 24(버튼) + 10 = 44px로 시안과 정확히 같아진다.
 *
 * 펼침 상태도 같은 값을 쓴다. 예전엔 그쪽만 pr-2(8px)라 글리프가 12px에 와서
 * 시안(2156:23585 — 컨테이너 300x44에서 16px 아이콘의 오른쪽 끝이 286, 즉 여백
 * 14px)보다 2px 안쪽이었다. 접힘/펼침이 여백을 달리 할 이유가 없다.
 */
export const TOGGLE_TRAILING_INSET = FULLSCREEN_CHROME_INSET - TOGGLE_GLYPH_INSET;

/**
 * chrome 줄에서 사이드바 쪽 열의 폭(px).
 *
 * 창 모드든 전체화면이든 사이드바 폭을 그대로 따라간다 — 토글이 사이드바
 * 오른쪽 경계에 맞고, 데스크탑 탭은 그 오른쪽(워크스페이스 위)에서 시작한다.
 *
 * 2026-07-30에는 전체화면에서 비워진 신호등 자리(82-14=68px)만큼 이 열도 함께
 * 당겼다. 그런데 사이드바 자체는 전체화면에서 좁아지지 않으므로, 열만 당기면
 * 토글이 사이드바 안쪽으로 68px 들어오고 데스크탑 탭이 사이드바 위를 덮는다
 * (2026-07-31 실측). 시안 2156:32582도 토글을 사이드바 경계에 두고 탭은 그
 * 오른쪽에서 시작한다. 전체화면에서 왼쪽으로 오는 것은 워드마크뿐이고, 그건
 * 신호등 자리를 접는 trafficLightSpacerWidth가 이미 맡는다.
 */
export function chromeSidebarColumnWidth(sidebarWidth: number): number {
  return Math.max(CHROME_SIDEBAR_MIN_WIDTH, sidebarWidth);
}

export function useWindowShellShape(): boolean {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;

    const sync = () => {
      appWindow
        .isFullscreen()
        .then((next) => {
          if (disposed) return;
          setFullscreen(next);
        })
        .catch(() => {});
    };

    sync();
    const stopResize = subscribeCurrentWindowResize(sync);

    return () => {
      disposed = true;
      stopResize();
    };
  }, []);

  return fullscreen;
}

/** `--app-chrome-bar-height`(index.css)와 같은 값이어야 한다. */
const CHROME_BAR_HEIGHT = 44;

/**
 * 네이티브 신호등 중심이 놓일 위치 — 창 위에서의 거리(px).
 *
 * chrome 줄(`--app-chrome-bar-height`)의 세로 중앙이다. 워드마크·사이드바
 * 토글이 그 줄 안에서 중앙에 놓이므로 신호등도 같은 베이스라인에 선다.
 * 기본값(창 위 14px)은 macOS 기본 타이틀바 28px 기준이라 우리 줄에서는 위로
 * 치우친다.
 *
 * "얼마나 내릴까"가 아니라 목표 중심을 그대로 준다 — 상대 이동은 타이틀바
 * 컨테이너의 자연 높이에 의존하는데 그 값이 창 설정마다 달라 어긋난다.
 *
 * 왼쪽 여백도 같은 값을 쓴다(사용자 요청 2026-08-07) — 창 모서리에서 위·왼쪽이
 * 대칭으로 떨어진다.
 */
export const TRAFFIC_LIGHT_CENTER = CHROME_BAR_HEIGHT / 2;
