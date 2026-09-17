import { useId } from "react";
import {
	SectionHeaderRow,
} from "@/components/sidebar/SidebarItems";
import { HiddenFilePaneRows } from "@/components/spaces/HiddenFilePaneRows";
import { spacesFacetLabel } from "@/components/spaces/spacesFacetLabels";
import { SpacesDesktopSection } from "@/components/spaces/SpacesDesktopSection";
import { SpacesAttentionRollup } from "@/components/spaces/SpacesGroupHeader";
import {
	dropKeyInRepository,
	SpacesRepositorySection,
	type SpacesRepositorySectionProps,
} from "@/components/spaces/SpacesRepositorySection";
import {
	FOLD_REVEAL_CLASS,
	useFoldMotion,
} from "@/components/spaces/useFoldMotion";
import type {
	SpacesFacetHierarchyGroup,
	SpacesHierarchy,
} from "@/components/spaces/useSpacesGroups";
import type { SpacesFacetGrouping } from "@/lib/spaces/spacesViewOptions";
import { cn } from "@/lib/utils";

/** What the pane hands every repository section: everything but the fields
 *  that name one section. The pinned band takes the same object. */
export type RepositoryBindings = Omit<
	SpacesRepositorySectionProps,
	| "group"
	| "heading"
	| "instanceKey"
	| "isFirst"
	| "labelledBy"
	| "attentionCount"
	| "dropTargetKey"
>;
type FacetHierarchy = Extract<
	SpacesHierarchy,
	{ readonly groupBy: SpacesFacetGrouping }
>;

/** One dynamic facet bucket. The outer fold owns only the bucket; repository
 * folds below it keep their canonical repository identity across every view. */
function SpacesFacetSection({
	group,
	isFirst,
	dropTargetKey,
	repositoryBindings,
}: {
	group: SpacesFacetHierarchyGroup;
	isFirst: boolean;
	dropTargetKey: string | null;
	repositoryBindings: RepositoryBindings;
}) {
	const headingId = useId();
	const fold = useFoldMotion(group.key);
	const collapsed = fold.collapsed;
	const focusedInstanceKey = group.focusedRepository
		? `${group.key} ${group.focusedRepository.key}`
		: null;
	return (
		<section
			ref={fold.sectionRef}
			aria-labelledby={headingId}
			data-spaces-facet-group={`${group.bucket.axis}:${group.bucket.value}`}
			// 12px above every bucket but the first: the group above ends with
			// its own 8, and the two make the 20 that separates one repository
			// from the next in the repository-grouped list (owner call
			// 2026-09-14). A hairline used to run here; the heading names the
			// bucket, so the rule marked a boundary the label already marks
			// (owner decision 2026-09-08). It is padding and not a margin so the
			// box keeps its shape — the fold glide reads this section's geometry.
			className={cn(!isFirst && "pt-3")}
		>
			<SectionHeaderRow
				id={headingId}
				as="h3"
				// The band marker Pinned and Unopened agents wear: a 32px box, 11px
				// medium at 70%, standing on the 16px column of the repositories it
				// names (mx-2 over its px-2). It was the 13px pane-size row, and
				// its children took an extra 4px step, so a location bucket pushed
				// everything under it one column right of the same list grouped by
				// repository — four levels drawn as three columns. A marker stands
				// on the column of what it names, so the bucket now reads as the
				// repository list with a band over it: two columns, as everywhere
				// else in the tab (owner call 2026-09-14, on the comp of the two).
				size="label"
				className="mx-2"
				label={spacesFacetLabel(group.bucket)}
				expanded={!collapsed}
				onToggle={fold.onToggle}
				weight="medium"
				chevron="trailing"
				actions={
					group.attentionCount > 0 ? (
						<SpacesAttentionRollup count={group.attentionCount} />
					) : undefined
				}
			/>
			{collapsed ? (
				group.focusedRepository ? (
					<div className={FOLD_REVEAL_CLASS}>
						<SpacesRepositorySection
							group={group.focusedRepository}
							heading="h4"
							instanceKey={`${group.key} ${group.focusedRepository.key}`}
							isFirst
							labelledBy={headingId}
							attentionCount={0}
							dropTargetKey={
								focusedInstanceKey &&
								dropKeyInRepository(dropTargetKey, focusedInstanceKey)
									? dropTargetKey
									: null
							}
							{...repositoryBindings}
						/>
					</div>
				) : null
			) : (
				// No inset of its own: the repositories stand where they stand in
				// the repository-grouped list, and the band above names them from
				// the same column.
				<div className={FOLD_REVEAL_CLASS}>
					{group.repositoryGroups.map((repository, index) => {
						const instanceKey = `${group.key} ${repository.key}`;
						return (
							<SpacesRepositorySection
								key={repository.key}
								group={repository}
								heading="h4"
								instanceKey={instanceKey}
								isFirst={index === 0}
								labelledBy={headingId}
								attentionCount={0}
								dropTargetKey={
									dropKeyInRepository(dropTargetKey, instanceKey)
										? dropTargetKey
										: null
								}
								{...repositoryBindings}
							/>
						);
					})}
				</div>
			)}
		</section>
	);
}

/** Render the complete dynamic hierarchy. Non-row surfaces trail the facet
 * buckets because assigning them an Unknown open-row facet would invent data. */
export function SpacesFacetList({
	hierarchy,
	dropTargetKey,
	repositoryBindings,
}: {
	hierarchy: FacetHierarchy;
	dropTargetKey: string | null;
	repositoryBindings: RepositoryBindings;
}) {
	return (
		<>
			{hierarchy.groups.map((group, index) => (
				<SpacesFacetSection
					key={group.key}
					group={group}
					isFirst={index === 0}
					dropTargetKey={dropTargetKey}
					repositoryBindings={repositoryBindings}
				/>
			))}
			{/* Repositories with nothing open follow the buckets with the same
			    20px any group leaves under itself — no rule. The repository-
			    grouped list runs the same rows on without one, and the location
			    band above already marks what a rule here marked when there was no
			    band (owner call 2026-09-14, over the 2026-09-08 rule). */}
			{hierarchy.trailingRepositories.map((repository, index) => (
				<SpacesRepositorySection
					key={repository.key}
					group={repository}
					isFirst={index === 0}
					attentionCount={0}
					dropTargetKey={null}
					{...repositoryBindings}
				/>
			))}
			{hierarchy.hiddenFileDesktops.map((desktop) => {
				const sectionKey = `facet-trailing ${desktop.id}`;
				return (
					<SpacesDesktopSection
						key={desktop.id}
						desktop={desktop}
						level="group"
						sectionKey={sectionKey}
						attentionCount={0}
						canClose={repositoryBindings.canCloseDesktop}
						isDropTarget={dropTargetKey === sectionKey}
						onActivate={repositoryBindings.onActivateDesktop}
						onAddAgent={repositoryBindings.onAddAgent}
						onAddTerminal={repositoryBindings.onAddTerminal}
						onDragEnterSection={repositoryBindings.onDragEnterSection}
						onDragLeaveSection={repositoryBindings.onDragLeaveSection}
						onDropOnDesktop={repositoryBindings.onDropOnDesktop}
					>
						<div className="mx-2 flex flex-col pt-1.5">
							<HiddenFilePaneRows desktopId={desktop.id} />
						</div>
					</SpacesDesktopSection>
				);
			})}
		</>
	);
}
