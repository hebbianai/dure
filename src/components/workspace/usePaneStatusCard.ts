import { useCallback, useRef, useState } from "react";
import { useWorkspaceRuntimeActive } from "@/components/workspace/WorkspaceRuntimeContext";
import { nextPaneStatusCard } from "@/lib/workspace/pane/paneStatusCard";

/** Whether the agent pane whose content box takes the returned ref should
 * show its status card. The size rule is paneStatusCard's; this hook only
 * feeds it the pane's laid-out size. React state changes only when the rule's
 * answer changes, never on every sash move.
 *
 * Observations of a Space that is not on screen are ignored, the same gate
 * structured terminals put on publishing geometry, and no observer runs
 * there. When the Space comes on screen the size is read once, because a
 * resize that happened while it was away may never produce another
 * observation. */
export function usePaneStatusCard<T extends HTMLElement>() {
	const runtimeActive = useWorkspaceRuntimeActive();
	const [shown, setShown] = useState(false);
	const shownRef = useRef(shown);
	const ref = useCallback(
		(element: T | null) => {
			if (!element) return;
			const evaluate = () => {
				const next = nextPaneStatusCard(shownRef.current, {
					width: element.clientWidth,
					height: element.clientHeight,
					runtimeActive,
				});
				if (next === shownRef.current) return;
				shownRef.current = next;
				setShown(next);
			};
			evaluate();
			if (!runtimeActive || typeof ResizeObserver === "undefined") return;
			const observer = new ResizeObserver(evaluate);
			observer.observe(element);
			return () => observer.disconnect();
		},
		[runtimeActive],
	);
	return { ref, shown };
}
