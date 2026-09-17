import type { GitHubWorkItemRow } from "@/lib/github/githubResponses";
import { asRecord, nonEmptyString, positiveInteger } from "@/lib/payloadGuards";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import type { SerializedPanelRef } from "@/lib/workspace/layout/layoutLifecycle";

/** The dockview component that shows one issue. */
export const GITHUB_ISSUE_PANE_COMPONENT = "githubissue";

/** Issue identity for view reuse and open markers, never a pane ID. */
export function githubIssueTargetKey(row: {
	repository: { projectId: string };
	number: number;
}): string {
	return JSON.stringify([row.repository.projectId, row.number]);
}

export function githubIssueTargetKeyFromPane(
	pane: Pick<SerializedPanelRef, "component" | "params">,
): string | undefined {
	if (pane.component !== GITHUB_ISSUE_PANE_COMPONENT) return;
	const row = asRecord(pane.params.row);
	const repository = asRecord(row?.repository);
	if (
		row?.kind !== "issue" ||
		!positiveInteger(row.number) ||
		!nonEmptyString(repository?.projectId)
	)
		return;
	return githubIssueTargetKey({
		repository: { projectId: repository.projectId },
		number: row.number,
	});
}

type MountedPane = Parameters<typeof dockPanelReference>[0];

/** The target keys of every issue showing in a mounted pane right now, across
 *  every mounted Dockview. Other pane content contributes nothing. */
export function openGitHubIssueTargetKeys(
	mounted: Iterable<readonly [string, { panels: readonly MountedPane[] }]>,
): Set<string> {
	const keys = new Set<string>();
	for (const [, api] of mounted) {
		for (const panel of api.panels) {
			const key = githubIssueTargetKeyFromPane(dockPanelReference(panel));
			if (key !== undefined) keys.add(key);
		}
	}
	return keys;
}

/** The row a pane may carry in its params. The detail view fetches the
 *  issue's comments itself, and its result flowed back through `onUpdated`
 *  into the params — so the persisted layout held the whole transcript:
 *  five open issues put 1.5 MB into the layout store, every layout change
 *  re-serialised it, and the 2 MB close-intent guard then refused to close
 *  any pane on that desktop (2026-09-09). A pane keeps the row's identity
 *  and summary; the transcript is the detail's to load. */
export function githubIssuePaneRow(row: GitHubWorkItemRow): GitHubWorkItemRow {
	const slim = { ...row } as GitHubWorkItemRow & { comments?: unknown };
	delete slim.comments;
	return slim;
}

type SerializedIssuePanel = {
	contentComponent?: string;
	params?: { row?: GitHubWorkItemRow & { comments?: unknown } };
};

/** Strip transcripts out of a persisted layout's issue panes. Returns the
 *  same object when there is nothing to strip, so callers can compare by
 *  identity the way they do after pruning. */
export function slimGitHubIssueLayout<T>(layout: T): T {
	if (!layout || typeof layout !== "object") return layout;
	const panels = (layout as { panels?: Record<string, SerializedIssuePanel> })
		.panels;
	if (!panels) return layout;
	let changed = false;
	const next: Record<string, SerializedIssuePanel> = {};
	for (const [id, panel] of Object.entries(panels)) {
		const row = panel?.params?.row;
		if (
			panel?.contentComponent === GITHUB_ISSUE_PANE_COMPONENT &&
			row &&
			"comments" in row
		) {
			next[id] = { ...panel, params: { ...panel.params, row: githubIssuePaneRow(row) } };
			changed = true;
		} else {
			next[id] = panel;
		}
	}
	return changed ? ({ ...(layout as object), panels: next } as T) : layout;
}
