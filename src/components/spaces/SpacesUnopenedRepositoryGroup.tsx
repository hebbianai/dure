// One repository's unopened agents: the shared repository fold
// (SpacesRepositoryFold) around the queue's rows, folded on the section's own
// key. Memoised the way the open-list groups are — an attention event
// recomputes the whole unopened list, so rows are compared by what the row
// draws, not by identity, and an unrelated update leaves this subtree alone.
import { type ComponentProps, memo } from "react";
import { cn } from "@/lib/utils";
import type { SpacesGroupLevel } from "@/components/spaces/SpacesGroupHeader";
import { SpacesRepositoryFold } from "@/components/spaces/SpacesRepositoryFold";
import { UnopenedAgentRow } from "@/components/spaces/SpacesRows";
import type {
	RepositorySpaceRow,
	SpaceRepositoryGroup,
} from "@/lib/spaces/spaceRepositoryGroups";
import { unopenedFoldKey } from "@/lib/spaces/unopenedAgentGroups";
import type { Project, SshHostConfig } from "@/types";

type RowProps = ComponentProps<typeof UnopenedAgentRow>;

/** An unopened agent as a repository-group row: the grouping identity plus
 *  everything UnopenedAgentRow draws. */
interface UnopenedAgentGroupRow extends RepositorySpaceRow {
	readonly key: string;
	readonly cwd?: string;
	readonly agent: RowProps["agent"];
	readonly state: RowProps["displayState"];
	readonly unread: boolean;
	readonly detail: string;
	readonly conversation: RowProps["conversation"];
}

type RowHandlers = Pick<
	RowProps,
	"onOpen" | "onViewDiff" | "onFork" | "onHide" | "onKill"
>;

interface SpacesUnopenedRepositoryGroupProps extends RowHandlers {
	group: SpaceRepositoryGroup<UnopenedAgentGroupRow>;
	/** The size the open list draws its repository rows at, so the two lists
	 *  read as one: `group` (13px, 16px column) under the repository-first
	 *  hierarchy, `sub` (11px, 21px column) under the space-first one. */
	level: SpacesGroupLevel;
	isFirst: boolean;
	/** Id of the section heading — the fold's landmark names both. */
	sectionHeadingId: string;
	projects: readonly Project[];
	sshHosts: readonly SshHostConfig[];
}

const sameRow = (a: UnopenedAgentGroupRow, b: UnopenedAgentGroupRow) =>
	a.agent === b.agent &&
	a.state === b.state &&
	a.unread === b.unread &&
	a.detail === b.detail &&
	a.projectName === b.projectName &&
	a.conversation === b.conversation;

function propsEqual(
	prev: SpacesUnopenedRepositoryGroupProps,
	next: SpacesUnopenedRepositoryGroupProps,
): boolean {
	return (
		prev.group.key === next.group.key &&
		prev.group.label === next.group.label &&
		prev.group.spaces.length === next.group.spaces.length &&
		prev.group.spaces.every((row, index) =>
			sameRow(row, next.group.spaces[index]),
		) &&
		prev.level === next.level &&
		prev.isFirst === next.isFirst &&
		prev.sectionHeadingId === next.sectionHeadingId &&
		prev.projects === next.projects &&
		prev.sshHosts === next.sshHosts &&
		prev.onOpen === next.onOpen &&
		prev.onViewDiff === next.onViewDiff &&
		prev.onFork === next.onFork &&
		prev.onHide === next.onHide &&
		prev.onKill === next.onKill
	);
}

export const SpacesUnopenedRepositoryGroup = memo(
	function SpacesUnopenedRepositoryGroup({
		group,
		level,
		isFirst,
		sectionHeadingId,
		projects,
		sshHosts,
		onOpen,
		onViewDiff,
		onFork,
		onHide,
		onKill,
	}: SpacesUnopenedRepositoryGroupProps) {
		return (
			// The head row only names the repository: no quick-add rail here —
			// "add a terminal" among agents not yet opened read as a mistake
			// (owner report 2026-09-03).
			<SpacesRepositoryFold
				group={group}
				foldKey={unopenedFoldKey(group.key)}
				level={level}
				heading="h4"
				isFirst={isFirst}
				labelledBy={sectionHeadingId}
				projects={projects}
				sshHosts={sshHosts}
				quickAdd={false}
			>
				{/* The rows touch, like session rows everywhere, and step one rung
				    in under the folder that holds them: the card 8 in so the glyph
				    stands at 24 against the folder's 16, and nothing above — a row
				    directly under a folder, with no label between, sits the way
				    the Sessions tab's do, its own 8px of card padding the whole
				    gap. The 6px a label leaves above its rows is for labels; here
				    it made this folder's rows sit 6 lower than an empty
				    repository's "No sessions yet" (owner report 2026-09-14). At
				    the sub level the fold's own content box brings the step. */}
				<div className={cn("flex flex-col", level === "group" && "pl-2")}>
					{group.spaces.map((row) => (
						<UnopenedAgentRow
							key={row.agent.id}
							agent={row.agent}
							displayState={row.state}
							unread={row.unread}
							projectName={row.projectName}
							remote={projects.some(
								(project) =>
									project.id === row.agent.projectId && project.kind === "ssh",
							)}
							detail={row.detail}
							conversation={row.conversation}
							onOpen={onOpen}
							onViewDiff={onViewDiff}
							onFork={onFork}
							onHide={onHide}
							onKill={onKill}
						/>
					))}
				</div>
			</SpacesRepositoryFold>
		);
	},
	propsEqual,
);
