import { t } from "@/lib/i18n";
import { DurableRehydrationCoordinator } from "@/lib/persistence/durableRehydrationCoordinator";
import { recoverCurrentDurableStoreProjection } from "@/lib/persistence/currentDurableProjectionRecovery";
import { DURABLE_APP_STORE_NAME, useStore } from "@/store";
import { useEffect } from "react";
import { create } from "zustand";
import {
  getCurrentWindow,
  type BackgroundThrottlingPolicy,
  type Effect,
  type EffectState,
} from "@tauri-apps/api/window";
import { setShellGlass, setTrafficLightDrop } from "@/lib/ipc";
import { POPOUT_WINDOW_GEOMETRY } from "@/lib/workspace/window/popoutWindowGeometry";
import { isMacPlatform } from "@/lib/workspace/desktop/desktopPlatform";
import {
  SHELL_CORNER_RADIUS,
  TRAFFIC_LIGHT_CENTER,
} from "@/lib/workspace/window/windowShellShape";
import { subscribeCurrentWindowFocus } from "@/lib/workspace/window/currentWindowFocus";
import {
  subscribeDurableStoreChanged,
} from "@/lib/workspace/window/durableStoreBroadcast";
import { subscribeCurrentWindowResize } from "@/lib/workspace/window/currentWindowResize";
import { WebviewKeyboardFocusRecovery } from "@/lib/workspace/window/webviewKeyboardFocusRecovery";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import { MANAGED_AGENT_REHOSTED_EVENT } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import {
	agentSessionSourceFromSearch,
	normalizeAgentSessionSourceWindowLabel,
	normalizeAgentSessionSourcePaneOwnerId,
	publishAgentSessionSource,
	rememberAgentSessionSource,
	subscribeAgentSessionRuntimeState,
} from "@/lib/workspace/window/agentSessionWindowSource";
import { subscribeAgentSessionWindowCommands } from "@/lib/workspace/window/agentSessionWindowCommand";
import { executeAgentSessionWindowCommand } from "@/lib/workspace/window/agentSessionWindowCommandRuntime";
import {
	type CreatedSecondaryWindow,
	lookupSecondaryWindow,
	revealSecondaryWindow,
	SecondaryWindowOperationTimeout,
	waitForSecondaryWindowCreation,
} from "@/lib/workspace/window/secondaryWindowOperation";
import { LEGACY_PRODUCT_COMPATIBILITY } from "@/lib/platform/legacyProductCompatibility";
import { webviewStorageOptions } from "@/lib/ipc/core";
import {
	popoutWindowLabel,
	SECONDARY_WINDOW_LABEL_PREFIX,
} from "@/lib/workspace/window/windowLabel";

export { SECONDARY_WINDOW_LABEL_PREFIX } from "@/lib/workspace/window/windowLabel";
export {
	DURABLE_STORE_REHYDRATED_EVENT,
	rehydrateDurableStore,
} from "@/lib/persistence/durableStoreRehydration";

const LAST_MAIN_DESKTOP_KEY = "dure:last-main-desktop";

/** URL의 ?desktop=<id> — 새 창이 처음 보여줄 데스크탑. 없으면 null. */
export function initialDesktopId(): string | null {
  return new URLSearchParams(location.search).get("desktop");
}

/** URL의 ?popout=<desktopId> — pane 분리(popout) 경량 창. 없으면 null. */
export function initialPopoutDesktopId(): string | null {
  return new URLSearchParams(location.search).get("popout");
}

/** URL의 ?sessionWindow=<agentId> — Hmux Agent를 크게 보는 단독 창. */
export function initialAgentSessionWindowId(): string | null {
  return new URLSearchParams(location.search).get("sessionWindow");
}

/** The workspace window that opened the detached Agent session surface. */
export function initialAgentSessionSourceWindowLabel(): string {
	return agentSessionSourceFromSearch(location.search).windowLabel;
}

/** 메인 창에서 마지막으로 보고 있던 데스크탑. 구조 상태와 분리해 저장하므로
 *  보조 창의 독립적인 activeSpaceId와 서로 덮어쓰지 않는다. */
export function rememberedMainDesktopId(): string | null {
  try {
    return (
      localStorage.getItem(LAST_MAIN_DESKTOP_KEY) ??
      localStorage.getItem(LEGACY_PRODUCT_COMPATIBILITY.mainDesktopStorageKey)
    );
  } catch {
    return null;
  }
}

export function rememberMainDesktopId(desktopId: string): void {
  if (!desktopId) return;
  try {
    localStorage.setItem(LAST_MAIN_DESKTOP_KEY, desktopId);
  } catch {
    /* localStorage unavailable — keep the runtime selection only */
  }
}

/** 메인 창인가(백엔드 서비스·알림은 여기서만 1회 실행). 보조 창은 ?desktop /
 *  ?diff / ?popout / ?panel / ?sessionWindow 파라미터가 있으므로 구분된다. */
export function isMainWindow(): boolean {
  const search = new URLSearchParams(location.search);
  return (
    !search.get("desktop") &&
    !search.get("diff") &&
    !search.get("popout") &&
    !search.get("panel") &&
    !search.get("sessionWindow")
  );
}

let counter = 0;

/**
 * Keep native glass options aligned with the main window configuration.
 * Standard windowEffects let macOS clip blur, corners and shadow together;
 * shaping a transparent window did not clip its separate blur/shadow layers.
 * Match SHELL_CORNER_RADIUS so native material and CSS cannot leave wedges.
 * Choose material from observed transparency in both appearances, not its name;
 * the sidebar material previously obscured the backdrop in dark appearance.
 */
/**
 * 전체화면 여부에 따른 창의 네이티브 모서리 반경.
 *
 * CSS 반경만 떼면 전체화면에서도 모서리가 둥글게 남는다 — 셸을 깎는 건
 * `shellChromeClass`의 CSS와 창 유리(NSVisualEffectView)의 `cornerRadius`
 * 둘인데, 후자는 창을 만들 때 정해진 값을 그대로 들고 있기 때문이다. 화면을
 * 꽉 채운 창에서 그 반경만큼 네 모서리가 파여 뒤가 비쳤다(사용자 보고,
 * 2026-08-01).
 */
export function nativeShellRadius(fullscreen: boolean): number {
  return fullscreen ? 0 : SHELL_CORNER_RADIUS;
}

/**
 * 위 값을 실제 창에 건다. 전체화면 상태를 아는 곳(App 루트)에서 한 번 부른다.
 *
 * material의 밝기(dark)도 같이 보낸다. 창 NSAppearance를 앱 테마에 맞춰도
 * (windowAppearance.ts) 이 뷰까지 전파되지 않는 경우가 있어서다 — 어긋나면
 * 다크 UI 뒤에 라이트 material이 깔려 사이드바가 통째로 밝게 씻긴다
 * (2026-08-02 실측: 다크에서 셸 유리가 rgb(148)).
 *
 * `setEffects`를 다시 부르는 방법은 쓸 수 없다. window-vibrancy는 호출할 때마다
 * **새** effect 뷰를 만들어 붙이기만 하고 기존 뷰를 지우지 않으며, 새 뷰를
 * `Below`로 넣어서 반경이 남은 옛 뷰가 위에 그대로 남는다. Tauri의
 * `clearEffects`도 macOS 분기가 없어(`#[cfg(windows)]`뿐) 아무 일도 하지 않는다.
 * 그래서 이미 붙어 있는 그 뷰의 반경만 네이티브에서 직접 바꾼다
 * (src-tauri `shell_corner.rs`).
 */
export function useNativeShellGlass(fullscreen: boolean, dark: boolean): void {
  useEffect(() => {
    // 실패해도 앱은 정상 동작한다 — 모서리·외형만 예전 값으로 남는다.
    setShellGlass(nativeShellRadius(fullscreen), dark).catch((error) => {
      console.warn("[glass] failed to match the shell glass to app state", error);
    });
  }, [fullscreen, dark]);
}

/**
 * 네이티브 신호등을 chrome 줄 중앙으로 내린다. macOS에서만 의미가 있다.
 *
 * 한 번 걸고 끝나지 않는다 — 신호등을 담은 NSTitlebarContainerView의 프레임을
 * 조정하는 방식이라 macOS가 리사이즈·전체화면 전환에서 되돌린다. 그래서 그
 * 시점마다 다시 건다. 백엔드는 이미 원하는 높이면 아무 일도 하지 않으므로
 * 반복 호출이 레이아웃을 흔들지 않는다.
 *
 * 전체화면에서는 macOS가 신호등을 감추고 버튼이 컨테이너에서 떨어져 나가
 * 백엔드가 조용히 넘어간다 — 복귀하면 이 효과가 다시 걸어 준다.
 */
export function useNativeTrafficLightDrop(fullscreen: boolean): void {
  const setMeasuredRight = useTrafficLightMetrics((state) => state.setRight);
  useEffect(() => {
    if (!isMacPlatform()) return;
    let disposed = false;
    const apply = () => {
      if (disposed) return;
      // 실패해도 앱은 정상 동작한다 — 신호등이 기본 위치에 남고 워드마크는
      // 폴백 여백을 쓴다.
      setTrafficLightDrop(TRAFFIC_LIGHT_CENTER, TRAFFIC_LIGHT_CENTER)
        .then((right) => {
          if (!disposed) setMeasuredRight(right ?? null);
        })
        .catch((error) => {
          console.warn("[chrome] failed to reposition the traffic lights", error);
        });
    };
    apply();
    // 리사이즈 중에는 macOS가 매 프레임 되돌리므로 이벤트마다 다시 건다.
    const stopResize = subscribeCurrentWindowResize(apply);
    return () => {
      disposed = true;
      stopResize();
    };
  }, [fullscreen, setMeasuredRight]);
}

/**
 * 네이티브에서 실측한 신호등 오른쪽 끝. 워드마크를 그 뒤 일정 간격에 붙이는 데
 * 쓴다 — 버튼 지름·간격은 macOS가 정하고 버전마다 흔들려 상수로는 못 맞춘다.
 * 실측 전(또는 macOS가 아닐 때)은 null이고 호출부가 폴백을 쓴다.
 */
export const useTrafficLightMetrics = create<{
  right: number | null;
  setRight: (right: number | null) => void;
}>((set) => ({
  right: null,
  setRight: (right) => set((state) => (state.right === right ? state : { right })),
}));

export const GLASS_WINDOW_NATIVE_OPTIONS = {
  // macOS가 비활성 창을 활성화하는 첫 클릭도 WKWebView에 전달한다. 이 값이
  // 없으면 첫 클릭은 창만 key 상태로 만들고 xterm은 두 번째 클릭을 기다린다.
  acceptFirstMouse: true,
  // 웹뷰가 투명해야 그 뒤의 effect view가 보인다. 이걸 끄면 WKWebView가 불투명
  // 배경을 칠해 유리가 통째로 가려진다.
  transparent: true,
  windowEffects: {
    effects: ["menu" as Effect],
    state: "active" as EffectState,
    radius: SHELL_CORNER_RADIUS,
  },
};

/** 앱의 전체 창을 하나 더 연다(VSCode "새 창"). 같은 UI·같은 데스크탑 목록을
 *  공유하되, 이 창은 지정된 데스크탑을 활성으로 시작한다. 각 창의 활성
 *  데스크탑은 독립적이라 모니터별로 다른 데스크탑을 볼 수 있다.
 *  창 옵션은 tauri.conf.json의 메인 창과 동일하게 맞춘다(네이티브 타이틀바가
 *  생기면 상단 바 없는 레이아웃이 어긋나므로 overlay + hiddenTitle 필수). */
export async function openDesktopWindow(desktopId: string) {
  const st = useStore.getState();
  const d = st.spaces.find((x) => x.id === desktopId);
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const label = `${SECONDARY_WINDOW_LABEL_PREFIX}${Date.now()}-${counter++}`;
    const w = new WebviewWindow(label, {
      ...(await webviewStorageOptions()),
      url: `index.html?desktop=${encodeURIComponent(desktopId)}`,
      title: d ? `Dure — ${d.name}` : "Dure",
      width: 1480,
      height: 940,
      minWidth: 900,
      minHeight: 600,
      titleBarStyle: "overlay",
      hiddenTitle: true,
      dragDropEnabled: false,
      ...GLASS_WINDOW_NATIVE_OPTIONS,
      focus: true,
      backgroundThrottling: "disabled" as BackgroundThrottlingPolicy,
    });
    w.once("tauri://error", (e) => console.error("Failed to open a new window:", e));
  } catch (e) {
    console.error("Failed to open a new window:", e);
  }
}

/** 한 에이전트의 Diff Review만 담은 단독 창을 연다. 사이드바·데스크탑 탭 등
 *  IDE chrome 없이 diff pane만 전체 화면으로 띄운다 — 코드 리뷰를 별도
 *  모니터에 띄워두고 에이전트 pane과 나란히 보기 위한 표면(사용자 요청).
 *  desktop 창과 마찬가지로 label은 "win-" 접두사(capabilities glob)와 overlay
 *  타이틀바를 쓴다. 같은 에이전트로 다시 열면 기존 창을 포커스한다. */
const openingSecondaryWindows = new Set<string>();
const uncertainSessionWindows = new Map<
	string,
	{ window: CreatedSecondaryWindow; expiresAt: number }
>();
const UNCERTAIN_SESSION_WINDOW_TTL_MS = 10_000;

/** Return native and WebView focus to the originating surface before exit. */
export async function restoreWindowAfterSecondaryClose(windowLabel = "main") {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
	const sourceWindow = await lookupSecondaryWindow(() =>
		WebviewWindow.getByLabel(
			normalizeAgentSessionSourceWindowLabel(windowLabel),
		),
	);
  if (!sourceWindow) return;
  await revealSecondaryWindow(sourceWindow);
}

/** Per-surface frame options for a single-instance secondary window.
 *  The shared flow owns navigation, focus, throttling, and storage. */
type SecondaryWindowFrameOptions = Omit<
  NonNullable<
    ConstructorParameters<
      typeof import("@tauri-apps/api/webviewWindow").WebviewWindow
    >[1]
  >,
  | "url"
  | "title"
  | "focus"
  | "backgroundThrottling"
  | "dataStoreIdentifier"
  | "dataDirectory"
>;

/** Shared open-or-focus flow for single-instance secondary windows
 *  (diff / popout / source control): reveal the existing window with the same
 *  stable label, otherwise create one with the shared glass-shell options.
 *  Callers differ only in label, url, title, frame options, and log message. */
async function openOrFocusSecondaryWindow(config: {
  label: string;
  url: string;
  title: string;
  frame: SecondaryWindowFrameOptions;
  /** Console prefix for both the async creation error event and thrown failures. */
  failureLog: string;
}): Promise<boolean> {
  const { label, url, title, frame, failureLog } = config;
  // 빠른 더블클릭 방지: getByLabel~생성 사이 비동기 창에서 두 호출이 모두
  // "없음"을 보고 같은 label로 생성하면 두 번째가 거부된다. 진행 중 표시로 막는다.
  if (openingSecondaryWindows.has(label)) return false;
  openingSecondaryWindows.add(label);
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const existing = await lookupSecondaryWindow(() => WebviewWindow.getByLabel(label));
    if (existing) {
      await revealSecondaryWindow(existing);
      return true;
    }
    const w = new WebviewWindow(label, {
      ...(await webviewStorageOptions()),
      url,
      title,
      ...frame,
      ...GLASS_WINDOW_NATIVE_OPTIONS,
      focus: true,
      backgroundThrottling: "disabled" as BackgroundThrottlingPolicy,
    });
    const created = await waitForSecondaryWindowCreation(w, () => WebviewWindow.getByLabel(label));
    await revealSecondaryWindow(created);
    return true;
  } catch (e) {
    console.error(failureLog, e);
    return false;
  } finally {
    openingSecondaryWindows.delete(label);
  }
}

export async function openAgentDiffWindow(agentId: string, title?: string) {
  await openOrFocusSecondaryWindow({
    label: `${SECONDARY_WINDOW_LABEL_PREFIX}diff-${agentId}`,
    url: `index.html?diff=${encodeURIComponent(agentId)}`,
    title: title ? `Diff — ${title}` : "Diff",
    frame: {
      width: 1100,
      height: 860,
      minWidth: 640,
      minHeight: 420,
      titleBarStyle: "overlay",
      hiddenTitle: true,
      dragDropEnabled: false,
    },
    failureLog: "Failed to open the Diff window:",
  });
}

/**
 * 한 Agent의 Hmux 세션을 pane 이동 없이 크게 보여주는 단독 창.
 * stable label을 써서 같은 Agent 버튼을 다시 누르면 새 observer를 더 만들지 않고
 * 기존 창을 복원·포커스한다. 실제 runtime identity는 새 창의 persisted store에서
 * agentId로 다시 해석하므로 URL에 터미널 내용이나 credential을 넣지 않는다.
 */
export async function openAgentSessionWindow(
	agentId: string,
	title?: string,
	sourcePaneOwnerId?: string,
) {
  const label = `${SECONDARY_WINDOW_LABEL_PREFIX}session-${agentId}`;
	const source = {
		windowLabel: normalizeAgentSessionSourceWindowLabel(
			getCurrentWindow().label,
		),
		paneOwnerId: normalizeAgentSessionSourcePaneOwnerId(sourcePaneOwnerId),
	};
	rememberAgentSessionSource(agentId, source);
  if (openingSecondaryWindows.has(label)) return;
  openingSecondaryWindows.add(label);
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
		const existing = await lookupSecondaryWindow(() =>
			WebviewWindow.getByLabel(label),
		);
    if (existing) {
			uncertainSessionWindows.delete(label);
			void publishAgentSessionSource(
				label,
				agentId,
				source,
			).catch(() => {});
      await revealSecondaryWindow(existing);
      return;
    }
		const uncertain = uncertainSessionWindows.get(label);
		if (uncertain && uncertain.expiresAt > Date.now()) {
			const recovered = await waitForSecondaryWindowCreation(
				uncertain.window,
				() => WebviewWindow.getByLabel(label),
			);
			uncertainSessionWindows.delete(label);
			void publishAgentSessionSource(
				label,
				agentId,
				source,
			).catch(() => {});
			await revealSecondaryWindow(recovered);
			return;
		}
		uncertainSessionWindows.delete(label);
		const sourcePaneQuery = source.paneOwnerId
			? `&sourcePane=${encodeURIComponent(source.paneOwnerId)}`
			: "";
    const w = new WebviewWindow(label, {
      ...(await webviewStorageOptions()),
      url: `index.html?sessionWindow=${encodeURIComponent(agentId)}&sourceWindow=${encodeURIComponent(source.windowLabel)}${sourcePaneQuery}`,
      title: title ? `Dure — ${title}` : "Dure",
      width: 1180,
      height: 880,
      minWidth: 720,
      minHeight: 480,
      titleBarStyle: "overlay",
      hiddenTitle: true,
      dragDropEnabled: false,
      ...GLASS_WINDOW_NATIVE_OPTIONS,
      focus: true,
      backgroundThrottling: "disabled" as BackgroundThrottlingPolicy,
    });
		let created: CreatedSecondaryWindow;
		try {
			created = await waitForSecondaryWindowCreation(w, () =>
				WebviewWindow.getByLabel(label),
			);
		} catch (error) {
			if (error instanceof SecondaryWindowOperationTimeout) {
				uncertainSessionWindows.set(label, {
					window: w,
					expiresAt: Date.now() + UNCERTAIN_SESSION_WINDOW_TTL_MS,
				});
			}
			throw error;
		}
		uncertainSessionWindows.delete(label);
    await revealSecondaryWindow(created);
  } catch (e) {
    console.error("Failed to open the session window:", e);
  } finally {
    openingSecondaryWindows.delete(label);
  }
}

/** pane 분리(popout) 경량 창 — 사이드바·데스크탑 바 없이 그 데스크탑의
 *  pane들만 렌더한다(diff/소스 제어 창과 같은 bare-root 문법, 사용자 요청).
 *  label이 desktopId로 안정적이라 같은 popout을 다시 열면 기존 창을 포커스한다. */
export async function openPopoutWindow(desktopId: string, title?: string) {
  return openOrFocusSecondaryWindow({
    label: popoutWindowLabel(desktopId),
    url: `index.html?popout=${encodeURIComponent(desktopId)}`,
    title: title || "Dure",
    frame: {
      ...POPOUT_WINDOW_GEOMETRY,
      titleBarStyle: "overlay",
      hiddenTitle: true,
      dragDropEnabled: false,
    },
    failureLog: "Failed to open the popout window:",
  });
}

/** 소스 제어 별도 창 — 사이드바 패널의 미러(단일 창, 이미 있으면 포커스).
 *  DiffWindow와 같은 bare-root 문법(?panel=source-control). */
export async function openSourceControlWindow() {
  await openOrFocusSecondaryWindow({
    label: `${SECONDARY_WINDOW_LABEL_PREFIX}source-control`,
    url: "index.html?panel=source-control",
    title: t("common.sourceControl"),
    frame: {
      // 상세(diff) 영역이 오른쪽 컬럼으로 붙으므로 기본 폭을 넉넉히 (사용자 요청)
      width: 980,
      height: 720,
      minWidth: 320,
      minHeight: 400,
    },
    failureLog: "Failed to open the source control window:",
  });
}

/** macOS(WKWebView) — 런타임에 만든 창은 WKWebView가 first responder가 되지
 *  않아 키보드 입력이 창 전체에서 하나도 들어오지 않는다(창 안을 클릭해도
 *  복구되지 않음). Window.setFocus()는 makeKeyAndOrderFront만 하므로 웹뷰
 *  레벨 포커스를 명시적으로 요청한다(=makeFirstResponder). 단, 첫 클릭이 이미
 *  xterm textarea에 DOM 포커스를 준 뒤 늦게 도착한 native focus 이벤트에서 이를
 *  다시 호출하면 그 textarea를 덮어써 두 번째 클릭이 필요해진다. 호출 시작과
 *  동적 import 완료 뒤 모두 document focus를 확인해, 웹뷰가 아직 focus를 받지
 *  못한 경우에만 복구한다. */
export function startWebviewKeyboardFocus(): () => void {
  const recovery = new WebviewKeyboardFocusRecovery({
    hasDomFocus: () => document.hasFocus(),
    loadTarget: async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      return getCurrentWebview();
    },
    // Reuse the WebView-wide native authority already consumed by terminals;
    // one extra Tauri listener per focus concern only creates ordering races.
    subscribeNativeFocus: async (listener) =>
      subscribeCurrentWindowFocus(listener),
  });
  recovery.start();
  return () => recovery.dispose();
}

/** Re-read authoritative durable state after another WebView commits it.
 * activeSpaceId remains window-local because it is not persisted. */
export function startWindowSync() {
	const rehydration = new DurableRehydrationCoordinator(
		async () => {
			await recoverCurrentDurableStoreProjection();
		},
	);
  const stopAgentSessionCommands = subscribeAgentSessionWindowCommands(
    executeAgentSessionWindowCommand,
  );
  const stopRuntimeState = subscribeAgentSessionRuntimeState(
    (sessionId, state) =>
      useStore.getState().setSessionAgentRuntimeState(sessionId, state),
  );
  const onStorage = (event: StorageEvent) => {
		if (event.key !== DURABLE_APP_STORE_NAME) return;
		rehydration.request();
  };
  window.addEventListener("storage", onStorage);
  // Tauri WebViews do not share browser storage events. The native event carries
  // no state; subscribe first, then read the one durable authority.
  const stopDurableStore = subscribeDurableStoreChanged(
    DURABLE_APP_STORE_NAME,
    () => rehydration.request(),
  );
  // A delayed receipt may describe a superseded Host. Reuse the durable read;
  // its post-commit invalidation also covers hints delivered before persistence.
  const stopManagedRehost = listenWhenReady(
    MANAGED_AGENT_REHOSTED_EVENT,
    () => rehydration.request(),
  ).catch((error) => {
    console.warn("[window-sync] managed rehost subscription failed", error);
    return () => {};
  });
  return () => {
    window.removeEventListener("storage", onStorage);
		rehydration.dispose();
    stopAgentSessionCommands();
    stopRuntimeState();
    stopDurableStore();
    void stopManagedRehost.then((stop) => stop());
  };
}
