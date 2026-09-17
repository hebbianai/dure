import { type RefObject, useEffect, useRef } from "react";
import { restoreScroll, scrollMemory } from "@/lib/ui/scrollMemory";

/** Bring a sidebar list back to where it was scrolled the last time this
 * `key` was on screen, and keep remembering as it scrolls. Sidebar tabs
 * unmount when another tab is chosen, so without this every return starts
 * at the top; the Files tree had it, the Spaces list did not, and the two
 * scrolled differently (owner report 2026-09-14).
 *
 * `key` null means "do not remember" — a search in progress, whose list is
 * not the list the position belongs to. `ready` gates the restore until the
 * list has drawn (a truthy token; a changing one restores again, so a tree
 * whose folders fill in asynchronously catches up). Recording waits for the
 * restore so an empty list's scrollTop 0 never overwrites the saved spot. */
export function useSidebarScrollMemory(
	rootRef: RefObject<HTMLElement | null>,
	key: string | null,
	ready: unknown,
): void {
	const recording = useRef(false);
	useEffect(() => {
		recording.current = false;
	}, [key]);

	useEffect(() => {
		if (!ready || key === null) return;
		const viewport = rootRef.current?.querySelector<HTMLElement>(
			'[data-slot="scroll-area-viewport"]',
		);
		if (!viewport) return;
		restoreScroll(viewport, scrollMemory.get(key) ?? 0, performance.now() + 600);
		recording.current = true;
	}, [rootRef, key, ready]);

	useEffect(() => {
		const viewport = rootRef.current?.querySelector<HTMLElement>(
			'[data-slot="scroll-area-viewport"]',
		);
		if (!viewport || key === null) return;
		const remember = () => {
			if (recording.current) scrollMemory.set(key, viewport.scrollTop);
		};
		viewport.addEventListener("scroll", remember, { passive: true });
		return () => viewport.removeEventListener("scroll", remember);
	}, [rootRef, key]);
}
