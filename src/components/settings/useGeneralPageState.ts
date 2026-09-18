// GeneralPage's designated store-wiring point (cluster wiring hook). Every
// global-store subscription the settings general page needs lives here; the
// component consumes the returned values and keeps rendering only. Each
// selector stays its own useStore subscription so rerender semantics match
// the previous inline wiring exactly.
import { DEFAULT_UI_PREFS, type UiPrefs, useStore } from "@/store";

// Re-exported so the component can reference store defaults (e.g. the
// auto-save delay fallback) without a runtime import of "@/store".
export { DEFAULT_UI_PREFS };

export function useGeneralPageState() {
  const language = useStore((s) => s.language);
  const setLanguage = useStore((s) => s.setLanguage);
  const rawUi = useStore((s) => s.uiPrefs);
  const setUi = useStore((s) => s.setUiPrefs);
  // Closed over store values only, so the defaults merge may live here.
  const ui: UiPrefs = { ...DEFAULT_UI_PREFS, ...rawUi };
  return {
    language,
    setLanguage,
    ui,
    setUi,
  };
}
