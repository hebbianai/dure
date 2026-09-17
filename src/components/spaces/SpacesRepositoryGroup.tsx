import { memo } from "react";
import {
	rowListBindingsEqual,
	SpacesOpenRowList,
	type SpacesRowListBindings,
} from "@/components/spaces/SpacesOpenRowList";
import type { SpacesRepositoryAddActions } from "@/components/spaces/SpacesRepositoryHeader";
import type { SpaceRow } from "@/components/spaces/useSpaces";
import { SpacesRepositoryFold } from "@/components/spaces/SpacesRepositoryFold";
import { useFocusedRowIn } from "@/components/spaces/useSpacesPaneState";
import type { SpaceRepositoryGroup as RepositoryGroup } from "@/lib/spaces/spaceRepositoryGroups";
import type { Project, SshHostConfig } from "@/types";

interface SpacesRepositoryGroupProps
	extends SpacesRepositoryAddActions,
		SpacesRowListBindings {
	/** One derived repository bucket — key/label plus its rows in pane order. */
	group: RepositoryGroup<SpaceRow>;
	/** Desktop this group is listed under — quick-add opens its panes there. */
	desktopId: string;
	isFirst: boolean;
	/** Remote determination reads the project record (see the head row), so
	 *  the registry rides along instead of a pre-resolved flag. */
	projects: readonly Project[];
	sshHosts: readonly SshHostConfig[];
}

/** The pane re-renders on every subscribed store event; group contents change
 *  far less often. Compare the group by its row identities (useSpaces reuses
 *  row objects whose fields did not change), so an unrelated pane re-render —
 *  or another group's row update — skips this whole subtree. */
function spacesRepositoryGroupPropsEqual(
	prev: SpacesRepositoryGroupProps,
	next: SpacesRepositoryGroupProps,
): boolean {
	return (
		prev.group.key === next.group.key &&
		prev.group.label === next.group.label &&
		prev.group.spaces.length === next.group.spaces.length &&
		prev.group.spaces.every((row, index) => row === next.group.spaces[index]) &&
		prev.desktopId === next.desktopId &&
		prev.isFirst === next.isFirst &&
		prev.projects === next.projects &&
		prev.sshHosts === next.sshHosts &&
		prev.onAddRepositoryTerminal === next.onAddRepositoryTerminal &&
		prev.onAddRepositoryAgent === next.onAddRepositoryAgent &&
		prev.onAddRepositoryAgentWithOptions ===
			next.onAddRepositoryAgentWithOptions &&
		rowListBindingsEqual(prev, next)
	);
}

/** Repository sub-group inside one space (space-first hierarchy): the rows of
 *  a space bucketed per repository. SpacesRepositoryFold draws the landmark,
 *  the head row (`level="sub"`) and the remembered fold — shared with the
 *  project-first list by repository key — and SpacesOpenRowList the rows. */
export const SpacesRepositoryGroup = memo(function SpacesRepositoryGroup({
	group,
	desktopId,
	isFirst,
	projects,
	sshHosts,
	onAddRepositoryTerminal,
	onAddRepositoryAgent,
	onAddRepositoryAgentWithOptions,
	...rowList
}: SpacesRepositoryGroupProps) {
	// A folded group still shows the focused pane's row, alone, so the pane
	// with the keyboard is never out of sight (사용자 요청 2026-09-03).
	const focusedRow = useFocusedRowIn(group.spaces);
	return (
		<SpacesRepositoryFold
			group={group}
			level="sub"
			isFirst={isFirst}
			desktopId={desktopId}
			projects={projects}
			sshHosts={sshHosts}
			foldedContent={
				focusedRow && (
					<SpacesOpenRowList spaces={[focusedRow]} spaceHeading {...rowList} />
				)
			}
			onAddRepositoryTerminal={onAddRepositoryTerminal}
			onAddRepositoryAgent={onAddRepositoryAgent}
			onAddRepositoryAgentWithOptions={onAddRepositoryAgentWithOptions}
		>
			<SpacesOpenRowList spaces={group.spaces} spaceHeading {...rowList} />
		</SpacesRepositoryFold>
	);
}, spacesRepositoryGroupPropsEqual);
