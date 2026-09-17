// FLIP for a list whose one section just grew or shrank: everything after
// that section moves, and animating that movement as a transform keeps the
// motion on the compositor. A height animation runs on the main thread —
// layout on every frame, plus whatever the sidebar's scroll area observes —
// and stutters as soon as terminals or React have the thread; a transform
// animation does not.
//
// Snapshot the following siblings at every level between the section and the
// list root before the DOM changes, let the change land instantly, then play
// each moved sibling from its old position to its new one.

export type SiblingPositions = ReadonlyMap<Element, number>;

/** Top edges of every element that will move when `section` changes height:
 *  its following siblings, then its parent's following siblings, up to (not
 *  including) `root`. Nested descendants ride along with their ancestors, so
 *  only these top-level movers are recorded. */
export function snapshotFollowingSiblings(
	section: Element,
	root: Element,
): SiblingPositions {
	const positions = new Map<Element, number>();
	let node: Element | null = section;
	while (node && node !== root) {
		for (
			let sibling = node.nextElementSibling;
			sibling;
			sibling = sibling.nextElementSibling
		) {
			positions.set(sibling, sibling.getBoundingClientRect().top);
		}
		node = node.parentElement;
	}
	return positions;
}

export interface FlipMotion {
	readonly durationMs: number;
	readonly easing: string;
}

/** Play every recorded element from where it was to where it is now. Elements
 *  that left the DOM or did not move are skipped; without Web Animations
 *  (jsdom) nothing plays and the layout simply lands. */
export function playSiblingFlip(
	before: SiblingPositions,
	motion: FlipMotion,
): number {
	let played = 0;
	for (const [element, top] of before) {
		if (!element.isConnected || typeof element.animate !== "function") continue;
		const delta = top - element.getBoundingClientRect().top;
		if (Math.abs(delta) < 0.5) continue;
		element.animate(
			[{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
			{ duration: motion.durationMs, easing: motion.easing },
		);
		played += 1;
	}
	return played;
}
