// Fold/unfold motion for a repository group that stays smooth while the main
// thread is busy. The DOM change lands instantly — the rows mount or unmount —
// and two compositor animations carry the eye: rows that appear fade and slide
// in from the head row, and everything below the group glides from where it
// was to where it is now (FLIP, lib/ui/flipSiblings). Nothing animates
// height: a height animation lays the list out on every frame and stutters as
// soon as terminals or React have the thread (owner report 2026-09-03).
import { useCallback, useLayoutEffect, useRef } from "react";
import { useSpacesCollapsedGroups } from "@/lib/spaces/spacesCollapsedGroupsStore";
import {
	type FlipMotion,
	playSiblingFlip,
	type SiblingPositions,
	snapshotFollowingSiblings,
} from "@/lib/ui/flipSiblings";

/** Marks the list whose sections move together — the FLIP root. */
const SPACES_LIST_ATTRIBUTE = "data-spaces-list";

/** 200ms with a soft settle: motion marks the moment of change and stops
 *  (SOUL §5.3) — liquid, not springy. */
const FOLD_MOTION: FlipMotion = {
	durationMs: 200,
	easing: "cubic-bezier(0.32, 0.72, 0, 1)",
};

/** The rows that appear on unfold: fade + 4px slide down from the head row,
 *  compositor only, skipped under reduced motion. Same curve as the glide. */
export const FOLD_REVEAL_CLASS =
	"motion-safe:animate-in fade-in slide-in-from-top-1 duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]";

function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/** Fold state of one repository group plus the toggle that animates it. Put
 *  `sectionRef` on the group's section element. */
export function useFoldMotion(groupKey: string) {
	const sectionRef = useRef<HTMLElement>(null);
	const pending = useRef<SiblingPositions | null>(null);
	const collapsed = useSpacesCollapsedGroups((state) =>
		Boolean(state.collapsed[groupKey]),
	);
	const toggle = useSpacesCollapsedGroups((state) => state.toggle);
	const onToggle = useCallback(() => {
		const section = sectionRef.current;
		if (section && !prefersReducedMotion()) {
			const root =
				section.closest(`[${SPACES_LIST_ATTRIBUTE}]`) ?? section.parentElement;
			if (root) pending.current = snapshotFollowingSiblings(section, root);
		}
		toggle(groupKey);
	}, [groupKey, toggle]);
	// After the commit that applied the fold and before paint: the siblings
	// already stand at their new positions, so the glide starts from the old
	// ones with no visible jump.
	useLayoutEffect(() => {
		const before = pending.current;
		pending.current = null;
		if (before) playSiblingFlip(before, FOLD_MOTION);
	}, [collapsed]);
	return { sectionRef, collapsed, onToggle };
}
