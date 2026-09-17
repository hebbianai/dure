// AppearancePage's designated store-wiring point (cluster wiring hook). Every
// global-store subscription the settings appearance page needs lives here;
// the component consumes the returned values and keeps rendering only. Each
// selector stays its own useStore subscription so rerender semantics match
// the previous inline wiring exactly.
import { DEFAULT_UI_PREFS, type UiPrefs, useStore } from "@/store";

// Re-exported so the component can reference store defaults (e.g. the
// splitter-size fallback) without a runtime import of "@/store".
export { DEFAULT_UI_PREFS };

export function useAppearancePageState() {
  const fontSize = useStore((s) => s.terminalFontSize);
  const setFontSize = useStore((s) => s.setTerminalFontSize);
  const rawUi = useStore((s) => s.uiPrefs);
  const setUi = useStore((s) => s.setUiPrefs);
  // Closed over store values only, so the defaults merge may live here.
  const ui: UiPrefs = { ...DEFAULT_UI_PREFS, ...rawUi };
  return { fontSize, setFontSize, ui, setUi };
}
