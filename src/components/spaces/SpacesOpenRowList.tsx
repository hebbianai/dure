// Open-pane rows in the projected order. Repository/space groups and the flat
// pinned list share selection, promotion counts, and in-place kill confirmation
// through this single renderer.
import { Fragment, type DragEvent, type MouseEvent } from "react";
import {
	OpenSpaceRow,
	type SpaceMenuHandlers,
} from "@/components/spaces/SpacesRows";
import type { SpaceRow } from "@/components/spaces/useSpaces";
import { InlineConfirmRow } from "@/components/ui/inline-confirm";
import { t } from "@/lib/i18n";
import type { DiffReviewCapability } from "@/lib/scm/review/diffReviewCapability";
import { localStandaloneDiffCwd } from "@/lib/scm/review/diffReviewCapability";
import type {
	SpacesGrouping,
	SpacesVisibleField,
} from "@/lib/spaces/spacesViewOptions";

/** In-place kill confirmation owned by useSpacesSelection — when its anchor
 *  is one of the listed rows, that row swaps to the confirm. */
interface SpacesKillConfirm {
	readonly anchorKey: string;
	readonly question: string;
	readonly busy: boolean;
}

/** Everything a row list needs besides the rows themselves. Group components
 *  take these as individual props so their memo equality stays field-wise. */
export interface SpacesRowListBindings {
	visibleFields: readonly SpacesVisibleField[];
	/** The row's actual grouping heading; absent in the flat pinned list. */
	groupBy?: SpacesGrouping;
	/** Show › Space: off hides the space tier and the space on every row. */
	showSpaces: boolean;
	diffCapabilities: ReadonlyMap<string, DiffReviewCapability>;
	selected: ReadonlySet<string>;
	contextMenuKey: string | null;
	conversionBusyKeys: ReadonlySet<string>;
	selectedPromotionEligible: number;
	selectedPromotionDeferred: number;
	onSpaceClick: (event: MouseEvent, key: string, desktopId: string) => void;
	onContextMenuOpenChange: (key: string, open: boolean) => void;
	onRowDragStart: (event: DragEvent, key: string) => void;
	onRowDragEnd: () => void;
	menuHandlers: SpaceMenuHandlers;
	killConfirm: SpacesKillConfirm | null;
	onKillConfirm: () => void;
	onKillCancel: () => void;
}

/** Field-wise equality of the bindings — shared by every memoized group so a
 *  handler rebind, not a row change, is the only thing that can miss. */
export function rowListBindingsEqual(
	prev: SpacesRowListBindings,
	next: SpacesRowListBindings,
): boolean {
	return (
		prev.visibleFields === next.visibleFields &&
		prev.groupBy === next.groupBy &&
		prev.showSpaces === next.showSpaces &&
		prev.diffCapabilities === next.diffCapabilities &&
		prev.selected === next.selected &&
		prev.contextMenuKey === next.contextMenuKey &&
		prev.conversionBusyKeys === next.conversionBusyKeys &&
		prev.selectedPromotionEligible === next.selectedPromotionEligible &&
		prev.selectedPromotionDeferred === next.selectedPromotionDeferred &&
		prev.onSpaceClick === next.onSpaceClick &&
		prev.onContextMenuOpenChange === next.onContextMenuOpenChange &&
		prev.onRowDragStart === next.onRowDragStart &&
		prev.onRowDragEnd === next.onRowDragEnd &&
		prev.menuHandlers === next.menuHandlers &&
		prev.killConfirm === next.killConfirm &&
		prev.onKillConfirm === next.onKillConfirm &&
		prev.onKillCancel === next.onKillCancel
	);
}

/** The rows of one heading. `spaceHeading` is the enclosing section's call —
 *  whether a space heading stands over these rows — not a list binding, since
 *  a folded repository shows its lone focused row without one. */
export function SpacesOpenRowList({
	spaces,
	spaceHeading,
	visibleFields,
	groupBy,
	showSpaces,
	diffCapabilities,
	selected,
	contextMenuKey,
	conversionBusyKeys,
	selectedPromotionEligible,
	selectedPromotionDeferred,
	onSpaceClick,
	onContextMenuOpenChange,
	onRowDragStart,
	onRowDragEnd,
	menuHandlers,
	killConfirm,
	onKillConfirm,
	onKillCancel,
}: SpacesRowListBindings & {
	spaces: readonly SpaceRow[];
	spaceHeading: boolean;
}) {
	return (
		// The rows touch. Two pixels between them made each row its own object
		// and the list a stack of them; with the gap closed the list reads as one
		// block and the air moves to where it separates something — between
		// repositories (owner call 2026-09-14, on the Notion sidebar's rhythm).
		// 2386:41128 "VerticalBorder" kept them 2px apart.
		<div className="flex flex-col">
			{spaces.map((space) => {
				const confirm =
					killConfirm?.anchorKey === space.key ? killConfirm : null;
				return (
					// The row stays while its kill is confirmed, wearing the selected
					// tint, and the question sits under it. Swapping the row for
					// the question left nothing on screen saying which session was
					// about to end (owner report 2026-09-14).
					<Fragment key={space.key}>
					<OpenSpaceRow
						space={space}
						visibleFields={visibleFields}
						groupBy={groupBy}
						spaceHeading={spaceHeading}
						showSpaces={showSpaces}
						canViewDiff={
							space.kind === "agent" ||
							(() => {
								const cwd = localStandaloneDiffCwd(space);
								return Boolean(
									cwd && diffCapabilities.get(cwd)?.status === "available",
								);
							})()
						}
						isSelected={selected.has(space.key) || confirm !== null}
						isContextTarget={contextMenuKey === space.key}
						selectionCount={selected.has(space.key) ? selected.size : 1}
						promotionEligibleCount={
							selected.has(space.key)
								? selectedPromotionEligible
								: space.managedPromotion === "eligible"
									? 1
									: 0
						}
						promotionDeferredCount={
							selected.has(space.key)
								? selectedPromotionDeferred
								: space.managedPromotion !== "hidden" &&
										space.managedPromotion !== "eligible"
									? 1
									: 0
						}
						promotionBusy={conversionBusyKeys.has(space.key)}
						onSpaceClick={onSpaceClick}
						onContextMenuOpenChange={onContextMenuOpenChange}
						onRowDragStart={onRowDragStart}
						onRowDragEnd={onRowDragEnd}
						menuHandlers={menuHandlers}
					/>
					{confirm && (
						<InlineConfirmRow
							className="mt-0.5"
							question={confirm.question}
							confirmLabel={t("spaces.kill.confirmLabel")}
							busy={confirm.busy}
							onConfirm={onKillConfirm}
							onCancel={onKillCancel}
						/>
					)}
					</Fragment>
				);
			})}
		</div>
	);
}
