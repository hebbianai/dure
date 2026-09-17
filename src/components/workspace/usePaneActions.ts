import { useLayoutEffect, useMemo } from "react";
import {
	type PaneActionEntry,
	registerPaneActions,
} from "@/lib/workspace/pane/paneActionRegistry";

/** Publish only committed handlers. A changed key or remount owns a new recipient. */
export function usePaneActions(
	ownerKey: string | undefined,
	entry: PaneActionEntry | undefined,
): void {
	const owner = useMemo(() => ({ key: ownerKey }), [ownerKey]);
	useLayoutEffect(() => {
		if (owner.key === undefined || !entry) return;
		return registerPaneActions({ ...entry, owner });
	}, [owner, entry]);
}
