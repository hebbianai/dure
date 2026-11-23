import { Expand } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";
import { Titled } from "@/components/ui/tooltip";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import { t } from "@/lib/i18n";
import {
	agentSessionSourceIsOpen,
	subscribeAgentSessionSourcePresence,
} from "@/lib/workspace/window/agentSessionWindowSource";
import { openAgentSessionWindow } from "@/lib/workspace/window/windows";

/** The Agent a pane presents and the window that owns the pane. */
export interface AgentLargeViewSource {
	readonly agentId: string;
	readonly sourceWindowLabel: string;
}

export interface AgentLargeViewSourceProxyTarget {
	readonly agentId: string;
	readonly sourcePaneOwnerId: string;
}

/** The Agent's large window, while it presents this exact pane's Agent. The
 * pane keeps owning the runtime; only its presentation hands over, so one
 * Agent never has two live surfaces (a terminal renderer or a composer) in
 * two windows. Terminal and Chat panes read the same presence. */
export function useAgentLargeViewSource(
	source: AgentLargeViewSource | undefined,
	paneId: string | undefined,
): AgentLargeViewSourceProxyTarget | undefined {
	const desktopId = useWorkspaceRuntimeDesktopId();
	const agentId = source?.agentId;
	const sourceWindowLabel = source?.sourceWindowLabel;
	const sourcePaneOwnerId =
		agentId && desktopId && paneId ? `${desktopId}:${paneId}` : undefined;
	const subscribe = useCallback(
		(listener: () => void) =>
			agentId
				? subscribeAgentSessionSourcePresence(agentId, listener)
				: () => {},
		[agentId],
	);
	const read = useCallback(
		() =>
			Boolean(
				agentId &&
					sourcePaneOwnerId &&
					sourceWindowLabel &&
					agentSessionSourceIsOpen(agentId, {
						windowLabel: sourceWindowLabel,
						paneOwnerId: sourcePaneOwnerId,
					}),
			),
		[agentId, sourceWindowLabel, sourcePaneOwnerId],
	);
	const active = useSyncExternalStore(subscribe, read, () => false);
	return active && agentId && sourcePaneOwnerId
		? { agentId, sourcePaneOwnerId }
		: undefined;
}

/** What the source pane shows while its Agent's large window presents it. */
export function AgentLargeViewSourceProxy({
	agentId,
	sourcePaneOwnerId,
}: AgentLargeViewSourceProxyTarget) {
	const label = t("terminal.largeView.bringToFront");
	return (
		<Titled title={label}>
			<button
				type="button"
				className="flex h-full w-full cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:inset-ring-1 focus-visible:inset-ring-ring"
				data-agent-session-window-proxy=""
				aria-label={label}
				onClick={() =>
					void openAgentSessionWindow(agentId, undefined, sourcePaneOwnerId)
				}
			>
				<span className="flex items-center gap-2 text-xs">
					<Expand className="size-3.5" />
					{t("terminal.largeView.openNotice")}
				</span>
			</button>
		</Titled>
	);
}
