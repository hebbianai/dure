import { useSyncExternalStore } from "react";
import { usePaneActions } from "@/components/workspace/usePaneActions";
import {
	paneActionPending,
	subscribePaneActionProgress,
} from "@/lib/workspace/pane/paneActionRegistry";

export function usePaneActionPending(paneId: string, action: string): boolean {
	return useSyncExternalStore(
		subscribePaneActionProgress,
		() => paneActionPending(paneId, action),
		() => false,
	);
}

/** Gives every transport the exact handler and availability used by a pane's UI. */
export function useNamedPaneAction(
	paneId: string,
	action: string,
	available: boolean,
	run: () => Promise<unknown>,
	ownerKey: string | undefined,
): void {
	usePaneActions(
		ownerKey,
		available ? { paneId, actions: { [action]: run } } : undefined,
	);
}
