import { useLayoutEffect } from "react";
import { schedulePostPaint } from "@/lib/scheduling/postPaint";
import { markWindowContentPainted } from "@/lib/workspace/boot/windowBootState";

/** Ends this window's boot at its root's first paint. main.tsx renders it
 *  beside every root that is not the workspace window's App — the session,
 *  diff, source-control and popout windows and the entry failure screen —
 *  outside the root's error boundary, so a root that fails still ends it.
 *  Without it the boot splash keeps redrawing its dot field every frame
 *  behind that window's content for as long as the window is open. */
export function WindowContentPainted(): null {
	useLayoutEffect(
		() => schedulePostPaint(window, markWindowContentPainted),
		[],
	);
	return null;
}
