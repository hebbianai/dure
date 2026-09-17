import { History, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { DiscoveryListFooter } from "@/components/spaces/DiscoveryListFooter";
import { DetectedWorktreeRow } from "@/components/spaces/DetectedWorktreeRow";
import { ProjectHeaderRow } from "@/components/sidebar/SidebarItems";
import { IconButton } from "@/components/ui/icon-button";
import type { DetectedWorktreeSession } from "@/lib/spaces/detectedWorktreeSessions";
import { isHiddenDetectedWorktree } from "@/lib/spaces/detectedWorktreeVisibility";
import { useDetectedWorktreeVisibilityStore } from "@/lib/spaces/detectedWorktreeVisibilityStore";
import { visibleDiscoveryItems } from "@/lib/spaces/discoveryList";
import { t } from "@/lib/i18n";
import type { Provider } from "@/types";

export function DetectedWorktreeSessionsSection({
	sessions,
	searchActive,
	onAdopt,
}: {
	readonly sessions: readonly DetectedWorktreeSession[];
	readonly searchActive: boolean;
	readonly onAdopt: (
		candidate: DetectedWorktreeSession,
		provider: Provider,
	) => Promise<void>;
}) {
	const hidden = useDetectedWorktreeVisibilityStore((state) => state.hidden);
	const hide = useDetectedWorktreeVisibilityStore((state) => state.hide);
	const restoreAll = useDetectedWorktreeVisibilityStore(
		(state) => state.restoreAll,
	);
	const [expanded, setExpanded] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const visible = useMemo(
		() =>
			sessions.filter(
				(session) => !isHiddenDetectedWorktree(session, hidden),
			),
		[hidden, sessions],
	);
	const hiddenCount = sessions.length - visible.length;
	const effectivelyExpanded = expanded || searchActive;
	const shown = visibleDiscoveryItems(visible, showAll || searchActive);

	if (sessions.length === 0) return null;
	return (
		<section aria-labelledby="detected-worktree-sessions-heading">
			<ProjectHeaderRow
				id="detected-worktree-sessions-heading"
				icon={<History />}
				name={t("spaces.worktree.historySection")}
				expanded={effectivelyExpanded}
				badge={
					<span className="font-mono text-[10px] tabular-nums text-muted-foreground">
						{visible.length}
						{hiddenCount > 0 ? ` · ${t("common.hidden")} ${hiddenCount}` : ""}
					</span>
				}
				actions={
					hiddenCount > 0 ? (
						<IconButton
							title={t("spaces.worktree.restoreAllHidden")}
							onClick={(event) => {
								event.stopPropagation();
								restoreAll();
							}}
						>
							<RotateCcw />
						</IconButton>
					) : undefined
				}
				onClick={() => {
					if (searchActive) return;
					setExpanded((current) => {
						if (current) setShowAll(false);
						return !current;
					});
				}}
			/>
			{effectivelyExpanded && (
				<div className="px-3">
				{shown.map((candidate) => (
					<DetectedWorktreeRow
						key={`${candidate.projectId}\0${candidate.worktree.path}`}
						candidate={candidate}
						onAdopt={onAdopt}
						onHide={hide}
					/>
				))}
				<DiscoveryListFooter
					shown={shown.length}
					total={visible.length}
					showAll={showAll}
					searchActive={searchActive}
					onShowAll={() => setShowAll(true)}
					className="mt-1"
				/>
				{visible.length === 0 && hiddenCount > 0 && (
					<p className="px-2 py-3 text-center text-[10px] text-muted-foreground">
						{t("spaces.worktree.hiddenReappearNote")}
					</p>
				)}
				</div>
			)}
		</section>
	);
}
