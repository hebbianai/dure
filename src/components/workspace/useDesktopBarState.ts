// DesktopBar's designated store-wiring point (cluster wiring hook). Every
// global-store subscription the desktop tab strip needs lives here; the
// component consumes the returned values and keeps rendering only. Each
// selector stays its own useStore subscription so rerender semantics match
// the previous inline wiring exactly.
import { DEFAULT_UI_PREFS } from "@/lib/settings/uiPrefs";
import { useStore } from "@/store";

export function useDesktopBarState() {
  const spaces = useStore((s) => s.spaces);
  const activeSpaceId = useStore((s) => s.activeSpaceId);
  const setActiveSpace = useStore((s) => s.setActiveSpace);
  const addSpace = useStore((s) => s.addSpace);
  const renameSpace = useStore((s) => s.renameSpace);
  const reorderSpace = useStore((s) => s.reorderSpace);
  const sshHosts = useStore((s) => s.sshHosts);
  // 설정 › 일반 › 탐색 › 탭 순서. '가장 최근'이면 마지막으로 머문 탭이 앞으로
  // 오고, 그 동안 끌어다 놓기는 다음 전환에 덮어써지므로 손잡이를 내린다.
  const tabOrder = useStore((s) => s.uiPrefs?.tabOrder ?? DEFAULT_UI_PREFS.tabOrder);
  const spaceVisits = useStore((s) => s.spaceVisits);
  return {
    spaces,
    activeSpaceId,
    setActiveSpace,
    addSpace,
    renameSpace,
    reorderSpace,
    sshHosts,
    tabOrder,
    spaceVisits,
  };
}

/** Font-size wiring for the bar's terminal font control (⌘+/⌘- 와 동일 값). */
export function useFontSizeControlState() {
  const size = useStore((s) => s.terminalFontSize);
  const setSize = useStore((s) => s.setTerminalFontSize);
  return { size, setSize };
}


/** Deferred read used inside the keydown handler — reads the store at call
 *  time exactly like the previous inline useStore.getState() call. */
export function readShortcutOverrides() {
  return useStore.getState().shortcutOverrides;
}

/** Deferred read for the ⌘1..9 handler — the same tab-order inputs the
 *  visible strip subscribes to, sampled at keypress time. */
export function readDesktopTabOrderState() {
  const state = useStore.getState();
  return {
    spaces: state.spaces,
    tabOrder: state.uiPrefs?.tabOrder ?? DEFAULT_UI_PREFS.tabOrder,
    spaceVisits: state.spaceVisits,
  };
}
