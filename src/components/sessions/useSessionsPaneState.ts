// SessionsPane's designated store-wiring point. The pane owns presentation
// controls while the persisted preference boundary owns normalization.
import { useCallback } from "react";
import type { SessionsViewOptions } from "@/lib/sessions/sessionsViewOptions";
import { DEFAULT_UI_PREFS, useStore } from "@/store";

export function useSessionsPaneState() {
	const sessionsViewOptions = useStore(
		(state) =>
			state.uiPrefs?.sessionsViewOptions ??
			DEFAULT_UI_PREFS.sessionsViewOptions,
	);
	const setUiPrefs = useStore((state) => state.setUiPrefs);
	const setSessionsViewOptions = useCallback(
		(value: SessionsViewOptions) => setUiPrefs({ sessionsViewOptions: value }),
		[setUiPrefs],
	);

	return { sessionsViewOptions, setSessionsViewOptions };
}
