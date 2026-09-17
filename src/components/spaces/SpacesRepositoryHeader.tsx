// Repository head row — the folder line of a repository group. One component
// serves both hierarchies: as the top level of the project-first list
// (`level="group"`, 13px label) and as the sub-group under a space in the
// space-first list (`level="sub"`, 11px label). The folder glyph, name and
// disclosure chevron share a fold toggle: clicking them collapses or expands
// the group (motion belongs to useFoldMotion). The folder icon reflects the
// fold state, which is remembered per repository
// (lib/spaces/spacesCollapsedGroupsStore).
//
// The heading wraps one native toggle for the label, metadata and chevron.
// Explicit names keep the heading and section named by the repository alone;
// the toggle describes its SSH badge, fold count and attention rollup separately.
//
// Width-dependent quick-add buttons measure the `@container/space-open-rows`
// container, so the head row must render inside one — both callers do.
import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import { Folder, FolderOpen, Pin, PinOff, Trash2 } from "lucide-react";
import {
	type ComponentType,
	memo,
	type ReactNode,
	useCallback,
	useMemo,
	useState,
} from "react";
import { sidebarSectionLabelTone } from "@/components/sidebar/SidebarItems";
import { Titled } from "@/components/ui/tooltip";
import {
	SpacesAttentionRollup,
	type SpacesGroupLevel,
} from "@/components/spaces/SpacesGroupHeader";
import { SpacesRepositoryActions } from "@/components/spaces/SpacesRepositoryActions";
import {
	readActiveDesktopId,
	useProjectPin,
} from "@/components/spaces/useSpacesPaneState";
import { Badge } from "@/components/ui/badge";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { DialogActionFooter } from "@/components/common/DialogActionFooter";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	executeProjectRemoval,
	planProjectRemoval,
	type ProjectRemovalPlan,
} from "@/lib/agents/resourceLifecycle";
import { t } from "@/lib/i18n";
import {
	type RepositoryQuickAddTarget,
	repositoryQuickAddTarget,
} from "@/lib/spaces/repositoryQuickAdd";
import {
	type SpaceRepositoryGroup as RepositoryGroup,
	type RepositorySpaceRow,
	repositoryRemoteHostId,
} from "@/lib/spaces/spaceRepositoryGroups";
import { cn } from "@/lib/utils";
import type { Project, Provider, SshHostConfig } from "@/types";

/** Quick-add actions, taken by the desktop the group is rendered under —
 *  the pane owns them so the head row stays rendering-only. */
export interface SpacesRepositoryAddActions {
	onAddRepositoryTerminal(
		desktopId: string,
		target: RepositoryQuickAddTarget,
	): void;
	onAddRepositoryAgent(
		desktopId: string,
		target: RepositoryQuickAddTarget,
		provider: Provider,
	): Promise<void>;
	onAddRepositoryAgentWithOptions(
		desktopId: string,
		target: RepositoryQuickAddTarget,
	): void;
}

/** The quick-add rail: every list that can start a session in the repository
 *  offers it and supplies the handlers; a list that only names the repository
 *  (the unopened queue) turns it off and supplies none. */
export type SpacesRepositoryQuickAddProps =
	| ({ readonly quickAdd?: true } & SpacesRepositoryAddActions)
	| ({ readonly quickAdd: false } & Partial<SpacesRepositoryAddActions>);

interface SpacesRepositoryHeaderBaseProps {
	group: RepositoryGroup<RepositorySpaceRow & { readonly cwd?: string }>;
	/** Heading element id — the enclosing section labels itself with it. */
	headingId: string;
	level: SpacesGroupLevel;
	/** Heading element when it must not follow `level` — a group drawn at the
	 *  top level's size but nested under a section heading is an h4. */
	heading?: "h3" | "h4";
	collapsed: boolean;
	onToggleCollapsed: () => void;
	/** Panes behind the fold while collapsed — the focused pane's row stays
	 *  visible, so this can be one less than the group. Zero draws no count. */
	/** Desktop a quick-added pane opens in. Omit when the group spans several
	 *  spaces (project-first): the active space is then read at click time, so
	 *  a space switch does not re-render every repository section. */
	desktopId?: string;
	/** Remote determination reads the project record, so the registry rides
	 *  along instead of a pre-resolved flag. */
	projects: readonly Project[];
	sshHosts: readonly SshHostConfig[];
	/** Sessions in this repository that need a human — drawn only when > 0. */
	attentionCount?: number;
}

type SpacesRepositoryHeaderProps = SpacesRepositoryHeaderBaseProps &
	SpacesRepositoryQuickAddProps;

export const SpacesRepositoryHeader = memo(function SpacesRepositoryHeader({
	group,
	headingId,
	level,
	heading,
	collapsed,
	onToggleCollapsed,
	desktopId,
	projects,
	sshHosts,
	attentionCount = 0,
	quickAdd = true,
	onAddRepositoryTerminal,
	onAddRepositoryAgent,
	onAddRepositoryAgentWithOptions,
}: SpacesRepositoryHeaderProps) {
	// Where a new session on this repository starts: the registered project
	// record when there is one, otherwise an open pane's cwd. A head row that
	// only names the repository has no such place.
	const quickAddTarget = useMemo(
		() => (quickAdd ? repositoryQuickAddTarget(group, projects) : undefined),
		[quickAdd, group, projects],
	);
	// The desktop comes from where this group is rendered — or, for a group
	// spanning several spaces, from the active space at click time. The menu
	// itself only knows the target.
	const quickAddHandlers = useMemo(() => {
		if (
			!onAddRepositoryTerminal ||
			!onAddRepositoryAgent ||
			!onAddRepositoryAgentWithOptions
		) {
			return undefined;
		}
		const desktop = () => desktopId ?? readActiveDesktopId();
		return {
			onAddTerminal: (target: RepositoryQuickAddTarget) =>
				onAddRepositoryTerminal(desktop(), target),
			onAddAgent: (target: RepositoryQuickAddTarget, provider: Provider) =>
				onAddRepositoryAgent(desktop(), target, provider),
			onAddAgentWithOptions: (target: RepositoryQuickAddTarget) =>
				onAddRepositoryAgentWithOptions(desktop(), target),
		};
	}, [
		desktopId,
		onAddRepositoryTerminal,
		onAddRepositoryAgent,
		onAddRepositoryAgentWithOptions,
	]);
	// The project menu — pin, and removal from the list — belongs to a head row
	// that stands for a registered project, in a list that offers actions (the
	// unopened queue names repositories and offers none, the same rule as the
	// quick-add rail). Removal confirms in a dialog (see removalDialog) with the
	// exact plan the location manager uses, so the two entries cannot drift:
	// the same question, the same agents warning, the same "stays on disk" line.
	const project = useMemo(
		() =>
			group.projectId
				? projects.find((candidate) => candidate.id === group.projectId)
				: undefined,
		[group.projectId, projects],
	);
	const menuProject = quickAdd === false ? undefined : project;
	const { pinned, togglePin } = useProjectPin(menuProject?.id);
	const [confirming, setConfirming] = useState<ProjectRemovalPlan | null>(null);
	const [removing, setRemoving] = useState(false);
	const removeProject = useCallback(async (plan: ProjectRemovalPlan) => {
		setRemoving(true);
		try {
			await executeProjectRemoval(plan);
		} catch (error) {
			await messageDialog(
				t("spaces.locations.removeKillFailed", { error: String(error) }),
				{ title: t("spaces.locations.removeFailed"), kind: "error" },
			);
		} finally {
			setConfirming(null);
			setRemoving(false);
		}
	}, []);
	const projectMenuItems = (
		Item: ComponentType<{
			variant?: "default" | "destructive";
			onSelect?: (event: Event) => void;
			children?: ReactNode;
		}>,
		Separator: ComponentType<{ className?: string }>,
	) =>
		menuProject ? (
			<>
				<Item onSelect={() => togglePin(menuProject.id)}>
					{pinned ? (
						<PinOff className="size-3.5" />
					) : (
						<Pin className="size-3.5" />
					)}
					<span className="text-xs">
						{t(pinned ? "spaces.locations.unpin" : "spaces.locations.pinToTop")}
					</span>
				</Item>
				<Separator />
				{/* Danger colour is for destructive actions only (SOUL §5); the
				    confirmation that follows is the removal dialog below. */}
				<Item
					variant="destructive"
					onSelect={() => setConfirming(planProjectRemoval(menuProject.id))}
				>
					<Trash2 className="size-3.5" />
					<span className="text-xs">{t("spaces.locations.remove")}</span>
				</Item>
			</>
		) : null;
	// 원격 판정은 프로젝트 기록이 한다 — 열린 pane으로 판정하면 원격 저장소에
	// 로컬 터미널만 떠 있는 동안 배지가 사라진다. 툴팁도 같은 host id에서
	// 뽑는다.
	const remoteHostId = repositoryRemoteHostId(group, projects);
	const remoteHostLabel = remoteHostId
		? sshHosts.find((host) => host.id === remoteHostId)?.name
		: undefined;
	const FolderGlyph = collapsed ? Folder : FolderOpen;
	const Heading = heading ?? (level === "group" ? "h3" : "h4");
	const headingContent = (
		<>
			<FolderGlyph
				aria-hidden="true"
				className="size-3.5 shrink-0 text-sidebar-foreground/70"
			/>
			<span
				// 13px at either level. Size says what a row *is*, not how deep it
				// sits: the grouping flips between space-first and project-first
				// from the view menu, and with size bound to depth the same
				// repository jumped between 13px and 11px on a reorder — the list
				// looked like it had re-ranked its contents when only the nesting
				// changed. Both comps agree (3419:88033 and 3427:87274 nest the
				// two the opposite way and draw the folder at 13px in each).
				className={cn(
					// −16px for the fading viewport's own trailing padding, so what
					// follows sits 8px from the text rather than 24 (see
					// SpacesGroupHeader).
					"-mr-4 min-w-0 text-xs font-medium leading-[18px]",
					sidebarSectionLabelTone(),
				)}
			>
				{/* Clipped the same way the rows below are: a fade, opening on
				    hover (SpacesGroupHeader carries the same note). */}
				<OverflowRevealText text={group.label} />
			</span>
		</>
	);
	// Removal confirms in a dialog, not in the row: the effect spans surfaces
	// (connected agents and their panes are terminated), which is the case
	// SOUL §6 reserves the dialog for — the same reason agent removal has one
	// (KillAgentDialog). The location manager keeps its inline row because it
	// is already a dialog. Owner call 2026-09-10 after seeing the row version.
	const removalDialog = confirming ? (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !removing) setConfirming(null);
			}}
		>
			<DialogContent
				className="max-w-sm"
				showCloseButton={!removing}
				dismiss={removing ? "none" : "all"}
			>
				<DialogHeader>
					<DialogTitle>
						{t("spaces.locations.removeConfirm", {
							name: confirming.project?.name ?? group.label,
						})}
					</DialogTitle>
					<DialogDescription>
						{[
							confirming.agents.length > 0
								? t("spaces.locations.removeAgentsWarning", {
										n: confirming.agents.length,
									})
								: null,
							t("spaces.locations.removeKeepsDisk"),
						]
							.filter(Boolean)
							.join(" ")}
					</DialogDescription>
				</DialogHeader>
				<DialogActionFooter
					variant="destructive"
					confirmLabel={t("spaces.locations.remove")}
					busyLabel={t("common.removing")}
					busy={removing}
					onCancel={() => setConfirming(null)}
					onConfirm={() => void removeProject(confirming)}
				/>
			</DialogContent>
		</Dialog>
	) : null;
	return (
		// Indentation by level, measured from the panel edge: the rows container
		// already contributes 12px. Top level puts the folder at 16px — the same
		// column the space heading uses in the other hierarchy; the sub level
		// puts it at 21px, between the space heading (16px) and the rows (24px).
		// The row is a fixed 30px (18px line + 6px above and below), not padded:
		// the hover rail's 24px buttons would otherwise grow it to 36px and shove
		// every row below down on each hover (owner report 2026-09-03). They sit
		// centred inside the 30px instead.
		<ContextMenu>
		<ContextMenuTrigger asChild disabled={!menuProject}>
		<div
			// 32px with an 8px gap (Figma 3419:88033). The comp's 16px column is
			// reached with 4px here, not its 8: the rows container already
			// insets 12px (`mx-3`), and stacking the comp's own padding on top
			// of that put the folder 4px too deep and cost the name enough
			// width to truncate beside the action rail (owner report
			// 2026-09-08). The nested level keeps its 9px lead-in.
			className={cn(
				"group/label flex h-8 min-w-0 items-center gap-2 pr-1",
				// Nested under a space: 24, one 8px step under the heading that
				// holds it — the second rung of the same ladder the other
				// grouping builds. The old 9px lead-in put it at 21, between the
				// rows' 16 and nothing else, so the rows it holds stood to its
				// left (owner report 2026-09-14).
				level === "group" ? "pl-2" : "pl-4",
			)}
		>
			<Heading
				id={headingId}
				aria-label={group.label}
				className="flex h-full min-w-0 flex-1 items-center"
			>
				<button
					type="button"
					aria-label={group.label}
					aria-describedby={`${headingId}-details`}
					aria-expanded={!collapsed}
					className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:inset-ring-1 focus-visible:inset-ring-ring focus-visible:outline-none"
					onClick={onToggleCollapsed}
				>
					<span className="flex min-w-0 items-center gap-1.5">
						{headingContent}
					</span>
					<span
						id={`${headingId}-details`}
						className="flex min-w-0 flex-1 items-center gap-2"
					>
						{Boolean(remoteHostId) && (
							<Titled title={remoteHostLabel}>
								<Badge
									variant="outline"
									// py-0: Badge 기본값 py-0.5 + border를 h-[18px] 안에 그대로
									// 두면 내용 상자가 12px인데 줄 상자는 18px이라
									// overflow-hidden에 위아래가 3px씩 물린다.
									className="h-[18px] shrink-0 rounded-md px-2 py-0 text-[10px] leading-[18px] opacity-70"
								>
									SSH
								</Badge>
							</Titled>
						)}
						{/* A fold carries no count (owner call 2026-09-15): the rows say
						    it open, and folded the number was one more thing to read. */}
						<SpacesAttentionRollup count={attentionCount} />
						{/* After the count, shown while the row is hovered (owner call 2026-09-10). */}
						<DisclosureChevron hint open={!collapsed} />
					</span>
				</button>
			</Heading>
			{/* Only groups that know a location get actions — with no folder to
			    start in, every one of them has nothing to do. */}
			{quickAddTarget && quickAddHandlers && (
				<SpacesRepositoryActions
					target={quickAddTarget}
					{...quickAddHandlers}
				/>
			)}
		</div>
		</ContextMenuTrigger>
		{menuProject && (
			<ContextMenuContent className="w-52">
				{projectMenuItems(ContextMenuItem, ContextMenuSeparator)}
			</ContextMenuContent>
		)}
		{removalDialog}
		</ContextMenu>
	);
});
