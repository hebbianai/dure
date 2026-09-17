import {
	getAllWebviewWindows,
	getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import type { CliHmuxPaneActivationDependencies } from "@/lib/cli/cliHmuxPaneActivation";
import { waitForExactHmuxPaneAttachmentAcrossWindows } from "@/lib/hmux/hmuxPaneAttachment";
import { hmux } from "@/lib/ipc";
import { isDesktopWorkspaceWindowLabel } from "@/lib/workspace/desktop/desktopVisibilityLease";

async function liveWindowLabels(): Promise<readonly [string, ...string[]]> {
	const current = getCurrentWebviewWindow().label;
	const windows = await getAllWebviewWindows();
	const otherLabels = [
		...new Set(windows.map((window) => window.label)),
	].filter(
		(label) => label !== current && isDesktopWorkspaceWindowLabel(label),
	);
	return [current, ...otherLabels];
}

export const cliHmuxPaneActivationDependencies: CliHmuxPaneActivationDependencies =
	{
		windowLabels: liveWindowLabels,
		waitForAnyExact: waitForExactHmuxPaneAttachmentAcrossWindows,
		attachmentStatus: ({ ownerId, sessionId, workspaceId }) =>
			hmux.paneAttachmentStatus(ownerId, sessionId, workspaceId),
	};
