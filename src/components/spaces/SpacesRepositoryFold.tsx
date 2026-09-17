// The repository fold every grouped Spaces list shares: the section landmark
// named by its folder head row, the head row itself (SpacesRepositoryHeader),
// the remembered fold with its compositor motion (useFoldMotion), and the 8px
// breath under an open group. Callers say what the fold holds — open rows,
// space sub-sections, unopened agent rows — and what, if anything, stays on
// screen while it is folded (the focused pane's row).
import { type ReactNode, useId } from "react";
import type { SpacesGroupLevel } from "@/components/spaces/SpacesGroupHeader";
import {
	SpacesRepositoryHeader,
	type SpacesRepositoryQuickAddProps,
} from "@/components/spaces/SpacesRepositoryHeader";
import {
	FOLD_REVEAL_CLASS,
	useFoldMotion,
} from "@/components/spaces/useFoldMotion";
import type {
	RepositorySpaceRow,
	SpaceRepositoryGroup,
} from "@/lib/spaces/spaceRepositoryGroups";
import { cn } from "@/lib/utils";
import type { Project, SshHostConfig } from "@/types";

interface SpacesRepositoryFoldBaseProps {
	group: SpaceRepositoryGroup<RepositorySpaceRow & { readonly cwd?: string }>;
	/** Fold key when it must differ from the repository key — a second list
	 *  over the same repositories keeps its own folds. */
	foldKey?: string;
	level: SpacesGroupLevel;
	/** Heading element override — see SpacesRepositoryHeader. */
	heading?: "h3" | "h4";
	isFirst: boolean;
	/** Ids read before the head row in the section's accessible name, so a
	 *  list nested under another heading says both. */
	labelledBy?: string;
	className?: string;
	/** Desktop a quick-added pane opens in; omitted, the active space. */
	desktopId?: string;
	projects: readonly Project[];
	sshHosts: readonly SshHostConfig[];
	attentionCount?: number;
	/** What stays on screen while folded, if anything. */
	foldedContent?: ReactNode;
	children: ReactNode;
}

export type SpacesRepositoryFoldProps = SpacesRepositoryFoldBaseProps &
	SpacesRepositoryQuickAddProps;

export function SpacesRepositoryFold({
	group,
	foldKey = group.key,
	level,
	heading,
	isFirst,
	labelledBy,
	className,
	desktopId,
	projects,
	sshHosts,
	attentionCount,
	foldedContent,
	children,
	...quickAdd
}: SpacesRepositoryFoldProps) {
	const headingId = useId();
	const { sectionRef, collapsed, onToggle } = useFoldMotion(foldKey);
	const content = collapsed ? foldedContent : children;
	return (
		// The fold lands instantly and animates on the compositor (useFoldMotion):
		// what appears fades in, what follows glides. An open group ends with an
		// 8px breath so the next head row does not sit on its last row; the
		// breath folds with the rows.
		<section
			ref={sectionRef}
			aria-labelledby={labelledBy ? `${labelledBy} ${headingId}` : headingId}
			data-space-repository-group={group.key}
			// The air between groups sits under each group and is sized by what
			// that group drew. At the outer tier: 20px under a group with rows —
			// the air the rows gave up when they closed their 2px gaps, spent
			// where it separates one repository from the next (the rhythm the
			// owner took from the Notion sidebar, 2026-09-14) — and 8px under a
			// folded one that drew nothing, so a run of folded groups reads as a
			// list of rows rather than rows scattered 20 apart (owner report,
			// same day). A group only has to know its own state; a top margin
			// would have to know its neighbour's. The last group in a run keeps
			// the 8 either way: what follows it is a rule or the end of the
			// list, not a sibling.
			// Nested under a space, this is the inner tier: 4px under the heading
			// that holds it, 8px between siblings, the same two steps a space
			// heading takes under a repository in the other grouping.
			className={cn(
				level === "group"
					? content
						? "pb-5 last:pb-2"
						: "pb-2"
					: isFirst
						? "mt-1"
						: "mt-2",
				className,
			)}
		>
			<SpacesRepositoryHeader
				group={group}
				headingId={headingId}
				level={level}
				heading={heading}
				collapsed={collapsed}
				onToggleCollapsed={onToggle}
				desktopId={desktopId}
				projects={projects}
				sshHosts={sshHosts}
				attentionCount={attentionCount}
				{...quickAdd}
			/>
			{content ? (
				// No breath of its own: the section above owns the air under the
				// group, sized by whether this content exists at all.
				<div
					className={cn(
						FOLD_REVEAL_CLASS,
						// Nested, this head row names the rows directly below it:
						// 6px of breath under the name, and the rows stand on this
						// heading's own column — card at 16, glyph at 24 where the
						// name starts (SpacesDesktopSection carries the note).
						level === "sub" && "mt-1.5 pl-2",
						// Folded at the top level, the one row left standing is the
						// focused pane, drawn here without the space section that
						// would have stepped it in — so it stood on the folder's own
						// column, and the same row moved 8px when the fold opened
						// (owner report 2026-09-14). It takes the step here.
						level === "group" && collapsed && "pl-2",
					)}
				>
					{content}
				</div>
			) : null}
		</section>
	);
}
