import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { hubTerminalWidths } from "@/lib/ipc/system";
import type { HmuxPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import {
	createHubTerminalWidthStore,
	widthForHubTerminal,
} from "./terminalWidthStore";

const widths = createHubTerminalWidthStore({
	listen: (receive) =>
		listen<unknown>("hub://terminal-widths", ({ payload }) => receive(payload)),
	snapshot: hubTerminalWidths,
});

export function useHubTerminalWidth(
	binding: HmuxPaneBindingV1,
	terminalEpoch: string | null,
): number | undefined {
	const snapshot = useSyncExternalStore(
		widths.subscribe,
		widths.getSnapshot,
		widths.getSnapshot,
	);
	return widthForHubTerminal(snapshot, binding, terminalEpoch);
}
