// ThemeSchemePicker's designated store-wiring point (cluster wiring hook).
// Every global-store subscription the scheme gallery needs lives here; the
// components consume the returned values and keep rendering only. Each
// selector stays its own useStore subscription so rerender semantics match
// the previous inline wiring exactly.
import { useCallback } from "react";
import type { ThemeDefinition } from "@/lib/theme/themeDefinition";
import type { SchemeMode } from "@/lib/theme/themeSchemeDisclosure";
import { DEFAULT_UI_PREFS, useStore } from "@/store";

/** Store wiring for one dark/light SchemeSlot. */
export function useSchemeSlotState(mode: SchemeMode) {
  const selectedId = useStore((s) => s.uiPrefs?.themeScheme?.[mode]);
  const customThemes = useStore((s) => s.customThemes);
  const setUi = useStore((s) => s.setUiPrefs);
  const removeCustomTheme = useStore((s) => s.removeCustomTheme);
  const pick = useCallback(
    (id: string | undefined) => {
      const current = useStore.getState().uiPrefs?.themeScheme;
      setUi({ themeScheme: { ...current, [mode]: id } });
    },
    [mode, setUi],
  );
  return { selectedId, customThemes, removeCustomTheme, pick };
}

/** Store wiring for the picker shell (disclosure derives from the theme). */
export function useThemeSchemePickerState() {
  const theme = useStore((s) => s.uiPrefs?.theme) ?? DEFAULT_UI_PREFS.theme;
  return { theme };
}

/** Store access for the module-level custom-theme import flow. Rethrows the
 *  store's ThemeIdCollisionError untouched so the caller's dialog handling
 *  keeps working. */
export function addCustomThemeToStore(theme: ThemeDefinition) {
  useStore.getState().addCustomTheme(theme);
}
