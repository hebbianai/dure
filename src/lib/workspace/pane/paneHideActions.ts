// Preserve grid slots and record anchors for removed floating/stacked views.
import type { FileTarget } from "@/lib/files/fileTarget";
import { removePanelsWithoutSessionTeardown } from "@/lib/workspace/pane/paneCloseCoordinator";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { markFilePaneHidden } from "@/lib/workspace/pane/hiddenFilePanesStore";
import { markPaneHidden } from "@/lib/workspace/pane/hiddenPanesStore";
import { paneHideAnchor } from "@/lib/workspace/pane/paneHideAnchor";
import { hidePanePreservingLayout } from "@/lib/workspace/pane/paneVisibility";

export interface HidePaneTarget {
	desktopId: string;
	panelId: string;
	agentId?: string;
	file?: FileTarget;
}

/** pane을 숨긴 뒤 복귀 기록을 남긴다. 숨김 lifecycle 중 마운트된 pane이 기존
 *  기록을 걷을 수 있으므로 기록이 반드시 마지막 write여야 한다. agent는
 *  agentId 키, 파일 pane은 panelId 키로 기록한다. */
export function hidePaneWithRecord(target: HidePaneTarget): void {
	const anchor = paneHideAnchor(target.desktopId, target.panelId);
	const api = getDockview(target.desktopId);
	if (!api || !hidePanePreservingLayout(api, target.panelId)) {
		removePanelsWithoutSessionTeardown([target.panelId]);
	}
	if (target.agentId) {
		markPaneHidden(target.agentId, target.desktopId, target.panelId, anchor);
	} else if (target.file) {
		const { sessionId: _sessionId, ...file } = target.file;
		markFilePaneHidden(target.panelId, {
			desktopId: target.desktopId,
			file,
			...(anchor ? { anchor } : {}),
		});
	}
}
