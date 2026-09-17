// A repository at the top of the project-first Spaces list: the folder head
// row, then one space section per space holding panes of this repository,
// each with its rows. Folding the repository hides everything under it; the
// fold is remembered per repository across hierarchies and restarts.
import { memo } from "react";
import {
	SpacesDesktopSection,
	type SpacesDesktopSectionProps,
} from "@/components/spaces/SpacesDesktopSection";
import {
	rowListBindingsEqual,
	SpacesOpenRowList,
	type SpacesRowListBindings,
} from "@/components/spaces/SpacesOpenRowList";
import { SpacesRepositoryFold } from "@/components/spaces/SpacesRepositoryFold";
import type { SpacesRepositoryAddActions } from "@/components/spaces/SpacesRepositoryHeader";
import type { SpaceRow } from "@/components/spaces/useSpaces";
import { useFocusedRowIn } from "@/components/spaces/useSpacesPaneState";
import { t } from "@/lib/i18n";
import type { RepositoryFirstGroup } from "@/lib/spaces/spaceRepositoryGroups";
import type { Desktop, Project, SshHostConfig } from "@/types";

/** Drop-highlight identity of one space section inside a repository. */
function repositorySectionDropKey(
	instanceKey: string,
	desktopId: string,
): string {
	return `${instanceKey} ${desktopId}`;
}

/** Whether a drop key names a section inside the given repository. */
export function dropKeyInRepository(
	dropKey: string | null,
	instanceKey: string,
): boolean {
	return Boolean(dropKey?.startsWith(`${instanceKey} `));
}

export interface SpacesRepositorySectionProps
	extends SpacesRepositoryAddActions,
		SpacesRowListBindings {
	group: RepositoryFirstGroup<SpaceRow, Desktop>;
	/** Render-instance namespace. Facet views can show one repository in more
	 * than one bucket while its persistent fold still uses the repository key. */
	instanceKey?: string;
	isFirst: boolean;
	/** Semantic level when a runtime facet wraps this repository. */
	heading?: "h3" | "h4";
	/** Optional parent heading for nested landmark context. */
	labelledBy?: string;
	/** Sessions of this repository that need a human, across every space. */
	attentionCount: number;
	canCloseDesktop: boolean;
	/** Drop-target key narrowed to this repository (null: the hover is elsewhere). */
	dropTargetKey: string | null;
	projects: readonly Project[];
	sshHosts: readonly SshHostConfig[];
	onActivateDesktop: (desktopId: string) => void;
	onAddAgent: (desktopId: string) => void;
	onAddTerminal: (desktopId: string) => void;
	onDragEnterSection: (sectionKey: string) => void;
	onDragLeaveSection: (sectionKey: string) => void;
	onDropOnDesktop: SpacesDesktopSectionProps["onDropOnDesktop"];
	/** The line shown when no row is listed; defaults to "No sessions yet".
	 *  A search passes its own "no matches" so an empty pinned repository
	 *  does not claim to be idle. */
	emptyLabel?: string;
}

/** The pane re-renders on every subscribed store event; a repository's rows
 *  change far less often. Rows are compared by identity (useSpaces reuses row
 *  objects whose fields did not change) and buckets by their desktop record,
 *  so an unrelated re-render — or another repository's update — skips this
 *  whole subtree. The active space is deliberately not a prop: the headings
 *  read it themselves and quick-add resolves it at click time, so a space
 *  switch leaves every section's memo intact. */
function propsEqual(
	prev: SpacesRepositorySectionProps,
	next: SpacesRepositorySectionProps,
): boolean {
	return (
		prev.emptyLabel === next.emptyLabel &&
		prev.group.key === next.group.key &&
		prev.instanceKey === next.instanceKey &&
		prev.heading === next.heading &&
		prev.labelledBy === next.labelledBy &&
		prev.group.label === next.group.label &&
		prev.group.spaces.length === next.group.spaces.length &&
		prev.group.spaces.every((row, index) => row === next.group.spaces[index]) &&
		prev.group.desktops.length === next.group.desktops.length &&
		prev.group.desktops.every(
			(bucket, index) =>
				bucket.desktop === next.group.desktops[index]?.desktop &&
				bucket.spaces.length === next.group.desktops[index]?.spaces.length,
		) &&
		prev.isFirst === next.isFirst &&
		prev.attentionCount === next.attentionCount &&
		prev.canCloseDesktop === next.canCloseDesktop &&
		prev.dropTargetKey === next.dropTargetKey &&
		prev.projects === next.projects &&
		prev.sshHosts === next.sshHosts &&
		prev.onActivateDesktop === next.onActivateDesktop &&
		prev.onAddAgent === next.onAddAgent &&
		prev.onAddTerminal === next.onAddTerminal &&
		prev.onDragEnterSection === next.onDragEnterSection &&
		prev.onDragLeaveSection === next.onDragLeaveSection &&
		prev.onDropOnDesktop === next.onDropOnDesktop &&
		prev.onAddRepositoryTerminal === next.onAddRepositoryTerminal &&
		prev.onAddRepositoryAgent === next.onAddRepositoryAgent &&
		prev.onAddRepositoryAgentWithOptions ===
			next.onAddRepositoryAgentWithOptions &&
		rowListBindingsEqual(prev, next)
	);
}

export const SpacesRepositorySection = memo(function SpacesRepositorySection({
	group,
	instanceKey = group.key,
	isFirst,
	heading,
	labelledBy,
	attentionCount,
	canCloseDesktop,
	dropTargetKey,
	projects,
	sshHosts,
	onActivateDesktop,
	onAddAgent,
	onAddTerminal,
	onDragEnterSection,
	onDragLeaveSection,
	onDropOnDesktop,
	onAddRepositoryTerminal,
	onAddRepositoryAgent,
	onAddRepositoryAgentWithOptions,
	emptyLabel,
	...rowList
}: SpacesRepositorySectionProps) {
	// A folded repository still shows the focused pane's row, alone and
	// without its space heading, so the pane with the keyboard is never out
	// of sight (사용자 요청 2026-09-03).
	const focusedRow = useFocusedRowIn(group.spaces);
	return (
		// The section is the rows container: rows get their 12px right margin
		// here, and the head row's width-dependent quick-add buttons measure
		// this box.
		<SpacesRepositoryFold
			group={group}
			level="group"
			heading={heading}
			isFirst={isFirst}
			labelledBy={labelledBy}
			className="@container/space-open-rows mx-2"
			projects={projects}
			sshHosts={sshHosts}
			attentionCount={attentionCount}
			foldedContent={
				focusedRow && (
					<SpacesOpenRowList
						spaces={[focusedRow]}
						spaceHeading={false}
						{...rowList}
					/>
				)
			}
			onAddRepositoryTerminal={onAddRepositoryTerminal}
			onAddRepositoryAgent={onAddRepositoryAgent}
			onAddRepositoryAgentWithOptions={onAddRepositoryAgentWithOptions}
		>
			{group.desktops.length === 0 && (
				// A registered repository with nothing open: one quiet line where
				// the rows would be; the head row's quick add is how to start.
				<p className="pl-4 pt-1.5 pb-1.5 font-mono text-meta text-muted-foreground">
					{emptyLabel ?? t("spaces.repository.noSessions")}
				</p>
			)}
			{!rowList.showSpaces ? (
				// Show › Space off: the space tier folds away and the rows run flat
				// under the repository, in the same desktop-by-desktop order the
				// headings gave them (owner call 2026-09-14). The step in and the
				// 6px under the heading are the ones a space heading's rows take.
				group.desktops.length > 0 && (
					<div className="pt-1.5 pl-2">
						<SpacesOpenRowList
							spaces={group.spaces}
							spaceHeading={false}
							{...rowList}
						/>
					</div>
				)
			) : (
			group.desktops.map(({ desktop, spaces }, index) => {
				const sectionKey = repositorySectionDropKey(instanceKey, desktop.id);
				return (
					<SpacesDesktopSection
						key={desktop.id}
						desktop={desktop}
						level="sub"
						heading={heading === "h4" ? "h5" : undefined}
						sectionKey={sectionKey}
						isFirst={index === 0}
						attentionCount={0}
						canClose={canCloseDesktop}
						isDropTarget={dropTargetKey === sectionKey}
						onActivate={onActivateDesktop}
						onAddAgent={onAddAgent}
						onAddTerminal={onAddTerminal}
						onDragEnterSection={onDragEnterSection}
						onDragLeaveSection={onDragLeaveSection}
						onDropOnDesktop={onDropOnDesktop}
					>
						<SpacesOpenRowList spaces={spaces} spaceHeading {...rowList} />
					</SpacesDesktopSection>
				);
			})
			)}
		</SpacesRepositoryFold>
	);
}, propsEqual);
