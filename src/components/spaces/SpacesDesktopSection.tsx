// One space's section of the Spaces list: the space heading plus whatever the
// caller nests under it — repository groups in the space-first hierarchy, a
// repository's rows in the project-first one, hidden file panes in either.
// The whole section, not just its heading, accepts a Spaces row drag or a
// dockview pane-tab drag and moves the panes to this space (사용자 요청). It is
// the one drop target: the heading inside it handles no drag events of its
// own, so a drop lands exactly once.
//
// The drop highlight is keyed by `sectionKey`, not by the desktop: in the
// project-first list the same space appears under several repositories and
// only the section under the pointer should light up.
import type { ReactNode } from "react";
import {
	SpacesGroupHeader,
	type SpacesGroupLevel,
} from "@/components/spaces/SpacesGroupHeader";
import {
	FOLD_REVEAL_CLASS,
	useFoldMotion,
} from "@/components/spaces/useFoldMotion";
import {
	currentSpacesRowDrag,
	parseSpacesDragPayload,
	type SpacesDragItem,
} from "@/lib/spaces/spacesDrag";
import { cn } from "@/lib/utils";
import { movePanelToDesktop } from "@/lib/workspace/dock";
import { getDragState } from "@/lib/workspace/pane/paneDragState";
import type { Desktop } from "@/types";

export interface SpacesDesktopSectionProps {
	desktop: Desktop;
	/** Top of the list (`group`) or nested under a repository (`sub`). */
	level: SpacesGroupLevel;
	/** Semantic level when this section is nested below a runtime facet. */
	heading?: "h3" | "h4" | "h5";
	/** Identity of this section for the drop highlight. */
	sectionKey: string;
	attentionCount: number;
	/** Rows inside, for the folded heading to report. */
	canClose: boolean;
	isDropTarget: boolean;
	/** Sub-level sections after the first take a small top gap. */
	isFirst?: boolean;
	onActivate: (desktopId: string) => void;
	onAddAgent: (desktopId: string) => void;
	onAddTerminal: (desktopId: string) => void;
	onDragEnterSection: (sectionKey: string) => void;
	onDragLeaveSection: (sectionKey: string) => void;
	/** Row-drag drop — the payload is the truth about what moves. */
	onDropOnDesktop: (desktopId: string, items: readonly SpacesDragItem[]) => void;
	children: ReactNode;
}

export function SpacesDesktopSection({
	desktop,
	level,
	heading,
	sectionKey,
	attentionCount,
	canClose,
	isDropTarget,
	isFirst = true,
	onActivate,
	onAddAgent,
	onAddTerminal,
	onDragEnterSection,
	onDragLeaveSection,
	onDropOnDesktop,
	children,
}: SpacesDesktopSectionProps) {
	// Folded per section, not per desktop: in the project-first list the same
	// space appears under several repositories, and each of those should fold on
	// its own — the same reason the drop highlight is keyed this way.
	const fold = useFoldMotion(sectionKey);
	return (
		<section
			ref={fold.sectionRef}
			className={cn(
				"rounded-md",
				// popout은 원본 아래에 nested로 — 들여쓰기 + 좌측 경계선 (top level
				// only; under a repository a popout is just another space).
				level === "group" &&
					desktop.kind === "popout" &&
					"ml-3 border-l border-glass-hairline",
				// The first space under a repository closes the gap its boxes
				// leave: the head row is a 32px box and this label a 24px one, so
				// with no margin at all between them the two baselines still sit
				// 28px apart and the space reads as detached from the folder that
				// holds it (owner report 2026-09-14). −4px puts the baselines at
				// 24px, the same step the rows below use. Later spaces keep their
				// +4px, since that gap separates two spaces rather than binding a
				// space to its repository.
				// 4px under the repository that holds it, 8px between siblings:
				// the first space belongs to the row above it, the next one is a
				// different space (owner call 2026-09-14).
				// At the top of the space-first list a space is the outer tier and
				// owns the air under itself, sized by what it drew: 20px under an
				// open space, 8px under a folded one that drew nothing, the last
				// in a run keeping the 8 (SpacesRepositoryFold carries the note).
				// An open space that holds nothing still draws a line saying so
				// (SpacesPane), the way an empty repository does, so it ends with
				// the open breath like any group that drew something.
				// 12 under an open space, not the 20 a repository leaves: what
				// follows here is a 20px label with no air of its own, where a
				// repository is followed by a 32px row with 7px inside it, so the
				// same 20 read twice as wide in this list — 32px text to text
				// against 17 between folded labels. Twelve puts it at 24, one step
				// above the folded pair, and still says the group ended (owner
				// call 2026-09-14, on the comp of the three).
				level === "sub"
					? isFirst
						? "mt-1"
						: "mt-2"
					: fold.collapsed
						? "pb-2"
						: "pb-3 last:pb-2",
				isDropTarget && "bg-accent/40 ring-1 ring-ring/30",
			)}
			data-space-desktop-section={desktop.id}
			onDragOver={(event) => {
				const rowItems = currentSpacesRowDrag();
				const paneDrag = rowItems ? null : getDragState();
				const acceptable = rowItems
					? rowItems.some((item) => item.fromDesktopId !== desktop.id)
					: paneDrag !== null && paneDrag.fromDesktopId !== desktop.id;
				if (!acceptable) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				onDragEnterSection(sectionKey);
			}}
			onDragLeave={() => onDragLeaveSection(sectionKey)}
			onDrop={(event) => {
				const raw = event.dataTransfer.getData("text/plain");
				const items = parseSpacesDragPayload(raw);
				if (items !== null) {
					event.preventDefault();
					onDropOnDesktop(desktop.id, items);
					return;
				}
				// Invalid row data only spends the drag. Its paired pane-tab
				// identity must never turn a rejected payload into a move.
				if (raw || currentSpacesRowDrag()) {
					onDropOnDesktop(desktop.id, []);
					return;
				}
				const paneDrag = getDragState();
				if (!paneDrag || paneDrag.fromDesktopId === desktop.id) return;
				event.preventDefault();
				onDragLeaveSection(sectionKey);
				// Spends the drag before moving, so the next native drag over a
				// section is not mistaken for a pane move.
				movePanelToDesktop(desktop.id);
			}}
		>
			<SpacesGroupHeader
				desktop={desktop}
				level={level}
				heading={heading}
				attentionCount={attentionCount}
				canClose={canClose}
				isDropTarget={isDropTarget}
				onActivate={onActivate}
				onAddAgent={onAddAgent}
				onAddTerminal={onAddTerminal}
				collapsed={fold.collapsed}
				onToggleCollapsed={fold.onToggle}
			/>
			{!fold.collapsed && (
				// Under a repository the tab holds three levels, and two of them
				// stood on the same column: the space label moved to 16 to leave
				// the orphan 12, which is where the session rows already keep
				// their glyph, so the step that said "these rows are inside this
				// space" disappeared (owner report 2026-09-14). The rows take one
				// more step here — 8 for the repository, 16 for the space, 24 for
				// its rows. At the top level a space has no repository above it,
				// so its rows stay at 16 and the ladder is two rungs, as it reads.
				// 6px under the label before its rows. The rows carry 8px of their
				// own padding, so the text already stood clear and this looked
				// unnecessary — until a row is hovered or selected and its card
				// edge appears, which lands against the label (owner report
				// 2026-09-14).
				<div
					className={cn(
						FOLD_REVEAL_CLASS,
						// Only where the children are rows. Under a space the
						// children are repository folds, which bring their own 4px
						// — stacking both put the first folder 10px under the name
						// that holds it (owner report 2026-09-14).
						level === "sub" && "mt-1.5",
						// The rows stand on the heading's own column: 8 here on top
						// of the section's 8 puts the card at 16 — the repository's
						// column — and its glyph, 8 inside, at 24, where the label
						// above it starts. Three columns eight apart read as stairs
						// at rest; the Files tab's rule is that a label stands on
						// the column of the rows it names and the card wraps that
						// block 8 to the left, and this is that rule (owner call
						// 2026-09-14, on the comp of the three).
						level === "sub" && "pl-2",
					)}
				>
					{children}
				</div>
			)}
		</section>
	);
}
