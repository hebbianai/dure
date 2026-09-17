import { DEFAULT_UI_PREFS } from "@/lib/settings/uiPrefs";
import { normalizeAutoSaveDelay } from "@/lib/settings/autoSave";
import { useStore } from "@/store";

/** Subscribe to rendered preferences; document drafts live with their file owner. */
export function useFileViewerPanelState() {
  return {
    autoSaveDelayMs: useStore((state) => normalizeAutoSaveDelay(state.uiPrefs?.autoSaveDelayMs, DEFAULT_UI_PREFS.autoSaveDelayMs)),
    autoSaveEnabled: useStore((state) => state.uiPrefs?.autoSaveFiles ?? DEFAULT_UI_PREFS.autoSaveFiles),
    minimap: useStore((state) => state.uiPrefs?.minimap ?? DEFAULT_UI_PREFS.minimap),
  };
}
