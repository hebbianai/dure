import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
	Copy,
	Folder,
	FolderOpen,
	GitBranch,
	MessageSquareText,
	Play,
	RotateCcw,
	Settings2,
	Trash2,
} from "lucide-react";
import {
	Fragment,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { AgentActivityGlyph } from "@/components/agents/AgentActivityGlyph";
import { SidebarInlineDetails } from "@/components/common/SidebarInlineDetails";
import { EmptyHint } from "@/components/common/StatusBlocks";
import { ProviderConversationHistory } from "@/components/sessions/ProviderConversationHistory";
import {
	type SessionListRowStatusTone,
	SessionStatusBadge,
} from "@/components/sessions/SessionListRow";
import type { RecentSessionsList } from "@/components/sessions/useRecentSessionsList";
import { useRecentWorkSectionState } from "@/components/sessions/useRecentWorkSectionState";
import {
	SectionHeaderRow,
	sidebarSectionLabelTone,
} from "@/components/sidebar/SidebarItems";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { IconButton } from "@/components/ui/icon-button";
import { t } from "@/lib/i18n";
import { copyTextToClipboard } from "@/lib/platform/clipboardWrite";
import { encodeDureDragPayload } from "@/lib/platform/productDragPayload";
import { launchRecentSessionPane } from "@/lib/sessions/launch/recentSessionPaneLaunch";
import { managedConversationLaunchFailureMessage } from "@/lib/sessions/managed/managedConversationLaunch";
import { recentSessionDragPayload } from "@/lib/sessions/recentSessionDrag";
import { recentSessionGroupOpen } from "@/lib/sessions/recentSessionsViewProjection";
import { useRecentSessionVisibilityStore } from "@/lib/sessions/recentSessionVisibilityStore";
import type { SessionsViewOptions } from "@/lib/sessions/sessionsViewOptions";
import type {
	RecentSessionRegistrationDecision,
	RecentWorkItem,
	RecentWorkProjection,
} from "@/lib/sessions/recentWork";
import { showToast } from "@/lib/toast";
import { formatRelativeAge } from "@/lib/ui/relativeAge";
import { cn } from "@/lib/utils";
import { setPaneDragImage } from "@/lib/workspace/pane/paneDragImage";
import { cwdName } from "@/lib/workspace/pane/paneTitle";
import { PROVIDERS, type SshHostConfig } from "@/types";

/** Where a remote session runs. Local is the default and says nothing, so
 *  the card only names a host. */
function sessionHost(item: RecentWorkItem): string {
	return item.hostId ?? "SSH";
}


function RecentWorkGroupSection({
	group,
	expanded,
	forceExpanded,
	onToggle,
	children,
}: {
	group: RecentWorkProjection["groups"][number];
	expanded: boolean;
	forceExpanded: boolean;
	onToggle(): void;
	children: ReactNode;
}) {
	const headingId = useId();
	const visible = forceExpanded || expanded;
	// Match Spaces repository rows: folder state, name, and a hover chevron.
	const FolderGlyph = visible ? FolderOpen : Folder;
	const rowClass =
		"group/label flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left";
	const content = (
		<>
			<FolderGlyph
				aria-hidden="true"
				className="size-3.5 shrink-0 text-sidebar-foreground/70"
			/>
			<OverflowRevealText
				id={headingId}
				text={group.name}
				className={cn(
					// Offset the fade padding so the chevron sits 8px after the name.
					"-mr-4 min-w-0 text-xs font-medium leading-[18px]",
					sidebarSectionLabelTone(),
				)}
			/>
			<DisclosureChevron hint open={visible} />
		</>
	);
	return (
		<section aria-labelledby={headingId}>
			<h3 className="contents">
				{forceExpanded ? (
					// A search keeps every matching group open; the heading is a
					// label, not a toggle, while it does.
					<div className={rowClass}>
						{content}
					</div>
				) : (
					<button
						type="button"
						aria-expanded={visible}
						className={cn(
							rowClass,
							// No hover fill: the spaces folder head has none, and this row is the
							// same row (owner call 2026-09-10, "match the spaces tab").
							"focus-visible:inset-ring-1 focus-visible:inset-ring-ring focus-visible:outline-none",
						)}
						onClick={onToggle}
					>
						{content}
					</button>
				)}
			</h3>
			{/* One 8px step for the rows a folder holds, the way the spaces tab
			    ladders its levels — and the step is the card's, not the text's:
			    the card stands at 16 with the folder glyph above it and keeps
			    its 8px inside, the same call the spaces tab made once its rows'
			    cards had 24px of nothing down their left (owner call
			    2026-09-14). Ungrouped, the rows stand on their own 8. */}
			{visible ? <div className="pb-1 pl-2">{children}</div> : null}
		</section>
	);
}

function RecentSessionHistoryCard({
	item,
	showFolder = false,
	status,
	statusTone,
	actionLabel,
	busy,
	opening,
	shownInPane,
	sshHosts,
	onActivate,
	onRemove,
}: {
	item: RecentWorkItem;
	/** Off when the heading above already names this row's folder. The flat
	 *  list has no heading, and a linked worktree under a repository heading
	 *  lives in a folder of its own — both keep the chip. */
	showFolder?: boolean;
	status?: string;
	statusTone: SessionListRowStatusTone;
	actionLabel: string;
	busy: boolean;
	/** This card's own action is in flight. */
	opening: boolean;
	/** The session is showing in a pane right now. */
	shownInPane: boolean;
	sshHosts: readonly SshHostConfig[];
	onActivate(): void;
	onRemove(): void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [dragging, setDragging] = useState(false);
	const detailsId = useId();
	// "Did it open?" has to be answered by the card itself: the button spins
	// while the pane is on its way, and the details fold the moment the pane
	// is showing, so the row's "shown in pane" status is what remains. Dimming
	// the whole card for the wait read as disabled, not busy (owner report
	// 2026-09-08). The fold applies only to an open this card started — a
	// session already showing elsewhere stays as the reader left it.
	const askedToOpen = useRef(false);
	useEffect(() => {
		if (opening) askedToOpen.current = true;
	}, [opening]);
	useEffect(() => {
		if (shownInPane && askedToOpen.current) {
			askedToOpen.current = false;
			setExpanded(false);
		}
	}, [shownInPane]);
	const latestTurn = item.recentTurns[item.recentTurns.length - 1];
	const providerLabel = PROVIDERS[item.provider].label;
	// A named branch earns a slot on the info line; "HEAD" — git's word for a
	// detached checkout — is not a name and says nothing worth the room. Model
	// and effort left with the details' metadata block: they do not decide
	// whether to continue, and the provider restores them on resume. The
	// workspace root went the same way; the folder chip below already says
	// when a session lives outside its group (owner decision 2026-09-09,
	// option B of the metadata comparison).
	const branchName =
		item.branch && item.branch !== "HEAD" ? item.branch : undefined;
	// The info line: time first, then host, branch, status, folder, a dot
	// between parts. The time was tried at the end of the title line to save
	// the line; a mono stamp beside a 13px title read as a second column no
	// other row has, and long titles lost width to it (owner call 2026-09-09).
	const infoParts: ReactNode[] = [];
	const addInfo = (key: string, part: ReactNode) => {
		if (infoParts.length > 0) {
			infoParts.push(
				<span key={`${key}-dot`} aria-hidden="true">
					·
				</span>,
			);
		}
		infoParts.push(part);
	};
	addInfo(
		"time",
		<span key="time" className="shrink-0">
			{formatRelativeAge(item.mtime * 1000)}
		</span>,
	);
	if (item.executionLocation !== "local") {
		addInfo(
			"host",
			<OverflowRevealText key="host" text={sessionHost(item)} />,
		);
	}
	if (branchName) {
		addInfo(
			"branch",
			<span key="branch" className="flex min-w-0 items-center gap-1">
				<GitBranch className="size-3 shrink-0" />
				<OverflowRevealText text={branchName} />
			</span>,
		);
	}
	if (status) {
		addInfo(
			"status",
			<SessionStatusBadge key="status" status={status} tone={statusTone} />,
		);
	}
	if (showFolder) {
		addInfo(
			"folder",
			<span key="folder" className="flex min-w-0 items-center gap-1">
				<Folder className="size-3 shrink-0" />
				<OverflowRevealText text={cwdName(item.cwd) ?? ""} />
			</span>,
		);
	}
	const detailsLabel = t("common.details");
	const reviewsSshSetup = item.action.kind === "needs_registration_decision";
	const dragPayload = recentSessionDragPayload(item);
	const canDrag = Boolean(dragPayload) && !busy;
	const ActionIcon = reviewsSshSetup ? Settings2 : Play;
	const actionButton = (
		<Button
			type="button"
			variant="glass"
			className="w-full text-xs"
			aria-label={`${actionLabel}: ${item.title}`}
			disabled={busy}
			onClick={onActivate}
		>
			{/* No spinner here while opening: the row's leading glyph already
			    spins, and two spinners on one card said the same thing twice
			    (owner report 2026-09-09). The button only disables. */}
			<ActionIcon
				data-icon="inline-start"
				className={reviewsSshSetup ? undefined : "fill-current"}
			/>
			{actionLabel}
		</Button>
	);

	const trigger = (
		<article
			// The row's accessible name is its title. It used to be the `title`
			// attribute (with a drag hint), which the OS drew as a tooltip over
			// text the row already shows (owner report 2026-09-09).
			aria-label={item.title}
			className={cn(
				// A multi-line row is a card that shows its surface only when touched:
				// flat on the glass at rest, the hover tint under the pointer, the
				// selected tint when open — the same three states the GitHub rows and
				// the spaces rows use, with the same tokens. Trial (owner request
				// 2026-09-09) against the previous form, which painted every card with a
				// faint tint at rest (bg-foreground/[0.035], hover [0.07]); the reference
				// apps checked that day do either, and neither parts rows with rules.
				//
				// Geometry: 8px sides — the files tab's row inset (owner call 2026-09-10,
				// "match the files tab"; until then the spaces row's 12px, comp
				// 3419:88033) — and 8px top and bottom, rows stacked with no gap, the leading
				// glyph on the 13px title line and the info line 6px under it. The
				// row wraps so the open details take the full width beneath, 8px
				// above their rule (owner call 2026-09-09 — "the same spacing and
				// system as the spaces tab"). Inside the details, two steps only:
				// 4px between the lines of one section, 8px between sections and
				// around a rule.
				"flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0 rounded-md px-2 py-2 transition-colors duration-150 ease-out hover:bg-glass-tint-hover active:bg-glass-tint-hover focus-within:bg-glass-tint-hover data-[state=open]:bg-glass-tint-selected",
				canDrag && "cursor-grab active:cursor-grabbing",
				expanded && "bg-glass-tint-selected",
				dragging && "bg-glass-tint-hover opacity-55",
				busy && "pointer-events-none",
			)}
			data-session-key={item.key}
			data-pane-dragging={dragging ? "" : undefined}
			draggable={canDrag}
			aria-disabled={busy || undefined}
			onDragStart={(event) => {
				if (!dragPayload || busy) {
					event.preventDefault();
					return;
				}
				setDragging(true);
				setPaneDragImage(event.dataTransfer, { title: item.title });
				event.dataTransfer.setData(
					"text/plain",
					encodeDureDragPayload(dragPayload),
				);
				event.dataTransfer.effectAllowed = "copyMove";
			}}
			onDragEnd={() => setDragging(false)}
		>
			<button
				type="button"
				className={cn(
					"flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
					canDrag && "cursor-grab active:cursor-grabbing",
				)}
				aria-expanded={expanded}
				aria-controls={detailsId}
				aria-label={`${detailsLabel}: ${item.title}`}
				disabled={busy}
				onClick={() => setExpanded((current) => !current)}
			>
				{/* No chevron: the whole row is the toggle, and the details
				    appearing under it are the state. Every other heading in this
				    sidebar folds from its own click with no marker, and this was
				    the last one left carrying one (owner request 2026-09-08). */}
				{/* The leading slot is who the session is and whether it is busy —
				    AgentActivityGlyph, the same rule as the spaces rows and the pane
				    header. "Opening" is the one busy state a saved session has, so
				    it spins here and the action button below keeps its label. */}
				<span
					role="img"
					aria-label={providerLabel}
					// A 13px box like the title line's, centring the 12px glyph: the
					// two centres coincide at 6.5px instead of a whole-pixel offset
					// landing high (1px) or low (2px) against the title's ink (owner
					// reports 2026-09-09).
					className="flex h-3.5 items-center self-start"
				>
					<AgentActivityGlyph
						size={14}
						provider={item.provider}
						activity={opening ? "working" : undefined}
					/>
				</span>
				{/* 6px between the lines (3419:88033). The title is 13px regular
				    like every row title in the sidebar; the info line is mono at
				    /70, the spaces row's second line. Between them the last turn,
				    which the owner kept when the row moved onto the spaces anatomy
				    (2026-09-09): it is what tells two sessions of one title apart. */}
				<span className="flex min-w-[80px] flex-1 flex-col gap-1.5">
					<span className="flex h-[13px] w-full min-w-0 items-center gap-2">
						<OverflowRevealText text={item.title}
							className="flex-1 text-xs font-normal text-sidebar-foreground" />
					</span>
					{latestTurn && !expanded && (
						<span className="line-clamp-2 text-meta leading-4 text-muted-foreground">
							{/* The way a messages list reads: the other side's words carry
							    no prefix, only ours do. */}
							{latestTurn.role === "user" && (
								<>
									<span className="font-medium text-sidebar-foreground/75">
										{t("sessions.preview.you")}:
									</span>{" "}
								</>
							)}
							{latestTurn.text}
						</span>
					)}
					<span className="flex h-[15px] w-full min-w-0 items-center gap-1 font-mono text-meta text-sidebar-foreground/70">
						{infoParts}
					</span>
				</span>
			</button>

			{expanded && (
				<SidebarInlineDetails
					id={detailsId}
					data-session-details=""
					aria-label={`${detailsLabel}: ${item.title}`}
				>
					{/* The details open on the conversation: what this session was,
					    not how it was configured (owner decision 2026-09-09). */}
					<ProviderConversationHistory
						provider={item.provider}
						conversationId={item.conversationId}
						executionLocation={item.executionLocation}
						hostId={item.hostId}
						recentTurns={item.recentTurns}
						subagentCount={item.subagentCount}
						sshHosts={sshHosts}
					/>
					<div className="mt-2 border-t border-glass-hairline pt-2">
						{actionButton}
					</div>
				</SidebarInlineDetails>
			)}
		</article>
	);

	return (
		<ContextMenu modal={false}>
			<ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
			<ContextMenuContent className="w-56">
				<ContextMenuLabel className="max-w-52 truncate">
					{item.title}
				</ContextMenuLabel>
				<ContextMenuItem disabled={busy} onSelect={onActivate}>
					<ActionIcon
						className={cn("size-3", !reviewsSshSetup && "fill-current")}
					/>
					{actionLabel}
				</ContextMenuItem>
				<ContextMenuItem onSelect={() => setExpanded((current) => !current)}>
					<MessageSquareText />
					{expanded ? t("common.hideDetails") : t("common.showDetails")}
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem
					onSelect={() => void copyTextToClipboard(item.conversationId)}
				>
					<Copy />
					{t("sessions.actions.copyConversationId")}
				</ContextMenuItem>
				<ContextMenuItem onSelect={() => void copyTextToClipboard(item.cwd)}>
					<Copy />
					{t("sessions.actions.copyWorkingDirectory")}
				</ContextMenuItem>
				{item.executionLocation === "local" && (
					<>
						<ContextMenuSeparator />
						<ContextMenuItem onSelect={() => void openPath(item.cwd)}>
							<FolderOpen />
							{t("sessions.actions.openWorkingDirectory")}
						</ContextMenuItem>
					</>
				)}
				<ContextMenuSeparator />
				<ContextMenuItem variant="destructive" onSelect={onRemove}>
					<Trash2 />
					{t("sessions.recent.removeAction")}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

export function RecentWorkSection({
	list,
	query,
	viewOptions,
	openGroups,
	onToggleGroup,
	onRegistrationDecision,
}: {
	list: RecentSessionsList;
	query: string;
	viewOptions: SessionsViewOptions;
	/** The reader's open or folded choice per group; recentSessionGroupOpen
	 *  supplies the default for the rest. */
	openGroups: Readonly<Record<string, boolean>>;
	onToggleGroup(groupId: string, open: boolean): void;
	onRegistrationDecision(decision: RecentSessionRegistrationDecision): void;
}) {
	const { spaces, activeSpaceId } = useRecentWorkSectionState();
	const {
		sshHosts,
		loading,
		failed,
		inventoryTotal,
		projection,
		paneSpaceBySessionKey,
		hiddenCount,
	} = list;
	const removeRecentSession = useRecentSessionVisibilityStore(
		(state) => state.remove,
	);
	const restoreRecentSessions = useRecentSessionVisibilityStore(
		(state) => state.restoreAll,
	);
	const [opening, setOpening] = useState<string | null>(null);
	const forceExpanded = Boolean(query.trim());
	const grouped = viewOptions.groupBy !== "none";

	const openWork = async (item: RecentWorkItem) => {
		if (opening) return;
		setOpening(item.key);
		try {
			if (item.action.kind === "needs_registration_decision") {
				onRegistrationDecision(item.action.decision);
				return;
			}
			const payload = recentSessionDragPayload(item);
			if (!payload) throw new Error("recent_session_is_not_pane_placeable");
			await launchRecentSessionPane(payload, { desktopId: activeSpaceId });
		} catch (error) {
			await messageDialog(managedConversationLaunchFailureMessage(error), {
				title: t("common.conversationResumeFailed"),
				kind: "error",
			});
		} finally {
			setOpening(null);
		}
	};
	const renderCard = (
		item: RecentWorkItem,
		group: RecentWorkProjection["groups"][number] | undefined,
	) => {
		const resuming =
			item.action.kind === "register_and_resume";
		const needsRegistration =
			item.action.kind === "needs_registration_decision";
		// Pane presence is presentation state, separate from managed runtime
		// ownership. Activation still resolves the exact current generation.
		const paneSpaceId = paneSpaceBySessionKey.get(item.key);
		const isOpenInPane = paneSpaceId !== undefined;
		const destinationSpaceId = paneSpaceId ?? activeSpaceId;
		const destinationSpaceName =
			spaces.find((space) => space.id === destinationSpaceId)?.name ??
			t("sessions.placement.thisDesktop");
		const actionLabel = needsRegistration
			? t("sessions.recent.reviewSshAction")
			: isOpenInPane
				? t("sessions.actions.openPaneInDesktop", {
						desktop: destinationSpaceName,
					})
				: item.paneAgentIdCandidate
					? t("sessions.actions.openInNewPane")
					: resuming
						? t("common.continueInNewPane")
						: t("common.open");
		return (
			<Fragment key={item.key}>
				{/* 4px between rows — the ladder's step inside one section. Rows
				    are flat at rest, so the gap only shows when two of them carry a
				    fill: two open sessions side by side read as one block without
				    it (owner report 2026-09-09). 2px on each side keeps the gap
				    symmetric at the list's ends. */}
				<div className="py-0.5">
					<RecentSessionHistoryCard
						item={item}
						showFolder={!group || cwdName(item.cwd) !== group.name}
						status={
							opening === item.key
								? t("common.opening")
								: needsRegistration
									? t("sessions.recent.sshReviewRequired")
									: isOpenInPane
										? t("sessions.recent.shownInPane")
										: undefined
						}
						statusTone={
							needsRegistration
								? "attention"
								: isOpenInPane
									? "muted"
									: "neutral"
						}
						busy={opening !== null}
						opening={opening === item.key}
						shownInPane={isOpenInPane}
						sshHosts={sshHosts}
						actionLabel={actionLabel}
						onActivate={() => void openWork(item)}
						onRemove={() => {
							removeRecentSession({
								provider: item.provider,
								id: item.conversationId,
								mtime: item.mtime,
								executionLocation: item.executionLocation,
								...(item.hostId ? { hostId: item.hostId } : {}),
							});
							showToast(t("sessions.recent.removedToast"));
						}}
					/>
				</div>
			</Fragment>
		);
	};

	return (
		<section
			className="min-w-0 overflow-x-hidden pb-2"
			aria-labelledby="recent-sessions-heading"
		>
			{/* A section label like the files tab's "Recent files" — the same tier
			    External sessions took, so the list reads label → folder → row. It
			    does not fold: this is the pane's main content (owner call
			    2026-09-09). The restore control rides on it. */}
			{/* No mx of its own: like the file tab's "All files" label it sits on
			    the viewport's 8px and its own px-2, text at 16px — level with the
			    rows' glyphs now that the rows lost their doubled inset (owner
			    report 2026-09-13). And 8px above it, the Files tab's rule: a
			    section label carries its own breath, so under the search field
			    (which leaves 8) it stands at 16 — where "Recent file" stands one
			    tab over; it stood at 8 here (owner call 2026-09-14). */}
			<SectionHeaderRow
				size="label"
				className="mt-2"
				chevron="none"
				id="recent-sessions-heading"
				label={t("sessions.recent.heading")}
				actions={
					hiddenCount > 0 && (
						<span className="flex items-center gap-1">
							<IconButton
								title={t("sessions.recent.restoreRemovedCount", {
									count: hiddenCount,
								})}
								onClick={() => {
									restoreRecentSessions();
									showToast(t("sessions.recent.restoredToast"));
								}}
							>
								<RotateCcw />
							</IconButton>
						</span>
					)
				}
			/>
			{failed && (
				<div className="px-2 py-1 text-meta text-status-warn">
					<OverflowRevealText text={t("common.recentSessionsLoadFailed")} />
				</div>
			)}
			{/* The list shares the row geometry of the file and ssh tabs: the
			    pane insets 8px (the SessionsPane viewport's px-2, the same as the
			    file tab's), a row's fill starts there, and its text sits 8px
			    inside the fill (16px from the pane edge). This list used to add
			    mx-3 + px-1 + px-3 on top of each other, so the fill began at 16px
			    and the text at 28px (owner report 2026-09-08); after the viewport
			    took the file tab's 8px, this wrapper's own px-2 still stacked on
			    it — fill at 16, text at 24, again the one tab sitting deeper
			    (owner report 2026-09-13). The wrappers carry no inset of their
			    own; the viewport is the inset. */}
			{projection.total > 0 && grouped && (
				<div className="min-w-0">
					{projection.groups.map((group, index) => {
						const expanded = recentSessionGroupOpen(openGroups, group.id, index);
						return (
							<RecentWorkGroupSection
								key={group.id}
								group={group}
								expanded={expanded}
								forceExpanded={forceExpanded}
								onToggle={() => onToggleGroup(group.id, !expanded)}
							>
								{group.items.map((item) => renderCard(item, group))}
							</RecentWorkGroupSection>
						);
					})}
				</div>
			)}
			{projection.total > 0 && !grouped && (
				<div className="min-w-0 pb-1">
					{projection.groups[0]?.items.map((item) =>
						renderCard(item, undefined),
					)}
				</div>
			)}
			{!loading &&
				!failed &&
				viewOptions.paneFilter !== "all" &&
				inventoryTotal > 0 &&
				projection.total === 0 && (
					<EmptyHint className="px-2 py-3">
						{t("sessions.viewOptions.emptyFilter")}
					</EmptyHint>
				)}
		</section>
	);
}
