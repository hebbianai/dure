/** Scroll positions live in memory only: they need no re-render and there
 * is no reason to keep them past an app restart. Keyed by the caller — a
 * file tree root, a Spaces grouping — so each list comes back where it was
 * after the sidebar tab it lives in unmounts and remounts. */
export const scrollMemory = new Map<string, number>();

/** A list that grows after mount (folder children arriving, rows mounting)
 * cannot take its target on the first frame; retry until the position holds
 * or the deadline passes. */
export function restoreScroll(
	el: HTMLElement,
	target: number,
	deadline: number,
): void {
	if (target <= 0) return;
	el.scrollTop = target;
	if (el.scrollTop >= target || performance.now() > deadline) return;
	requestAnimationFrame(() => restoreScroll(el, target, deadline));
}
