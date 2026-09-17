/**
 * Answering a phone that tapped one row of a session's changed-file list.
 *
 * The mapping lives in [`answerHubFileDiff`] and the table of sessions in
 * [`useHubSessionLocations`] — the same table the changed-file list resolves
 * against, so a row and its patch can never come from two different
 * repositories. This hook supplies only what needs a running window.
 *
 * # Only the main window
 *
 * Every window hears the event; only one should spend a `git diff` on it. The
 * same scoping, and the same reason, as [`useHubGitStatus`].
 */

import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { useHubSessionLocations } from "@/components/hub/useHubSessionLocations";
import { type HubFileDiffDispatch, answerHubFileDiff } from "@/lib/hub/fileDiffBridge";
import { agentFileDiff } from "@/lib/ipc/diffReview";
import { hubFileDiffResult, hubRemoteFileDiff } from "@/lib/ipc/system";
import { isMainWindow } from "@/lib/workspace/window/windows";

export function useHubFileDiff(): void {
	const current = useHubSessionLocations();

	useEffect(() => {
		if (!isMainWindow()) return;
		let disposed = false;
		const pending = listen<HubFileDiffDispatch>("hub://file-diff", (event) => {
			void answerHubFileDiff(event.payload, {
				locate: (sessionId) => current.current.get(sessionId),
				fileDiff: (worktreePath, path, commit) => agentFileDiff(worktreePath, path, commit),
				remoteFileDiff: (boxId, sessionId, workspaceId, path, commit) =>
					hubRemoteFileDiff(boxId, sessionId, workspaceId, path, commit),
				report: hubFileDiffResult,
			});
		});
		void pending.then((unlisten) => {
			if (disposed) unlisten();
		});
		return () => {
			disposed = true;
			void pending.then((unlisten) => unlisten());
		};
	}, []);
}
