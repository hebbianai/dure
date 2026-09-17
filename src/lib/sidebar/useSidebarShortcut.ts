import { useEffect } from "react";
import { matchesChord, shortcutChord } from "@/lib/settings/shortcutBindings";
import { shouldYieldToTerminal } from "@/lib/settings/shortcutPriority";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { useStore } from "@/store";

export function useSidebarShortcut() {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (
				!matchesChord(
					shortcutChord(
						"toggle-sidebar",
						useStore.getState().shortcutOverrides,
					),
					event,
				)
			)
				return;
			// Preserve the file editor's save command and terminal-first preference.
			if (event.target instanceof Element && event.target.closest(".cm-editor"))
				return;
			if (shouldYieldToTerminal()) return;
			event.preventDefault();
			event.stopPropagation();
			if (!event.repeat) useWindowSidebarStore.getState().toggle();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);
}
