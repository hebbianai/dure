// ShortcutsPage's designated store-wiring point (cluster wiring hook). Every
// global-store subscription the shortcuts page needs lives here; the
// component consumes the returned values and keeps rendering only. Each
// selector stays its own useStore subscription so rerender semantics match
// the previous inline wiring exactly.
import { useStore } from "@/store";

export function useShortcutsPageState() {
  const termFirst = useStore((s) => s.uiPrefs?.shortcutTerminalFirst ?? false);
  const setUi = useStore((s) => s.setUiPrefs);
  const overrides = useStore((s) => s.shortcutOverrides);
  const setShortcutOverride = useStore((s) => s.setShortcutOverride);
  const resetShortcutOverride = useStore((s) => s.resetShortcutOverride);
  return { termFirst, setUi, overrides, setShortcutOverride, resetShortcutOverride };
}
