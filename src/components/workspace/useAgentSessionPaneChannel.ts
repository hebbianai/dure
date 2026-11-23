import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
	AgentSessionPaneChannelMirror,
	AgentSessionPaneChannelPublication,
} from "@/lib/workspace/window/agentSessionWindowPaneChannel";

/** Source pane side: publishes a surface this pane owns to the large window
 * that shows the pane, for as long as the pane is mounted and has one. */
export function useAgentSessionPanePublication<Surface>(
	paneId: string,
	surface: Surface | undefined,
	publish: (
		paneId: string,
		initial: Surface,
	) => AgentSessionPaneChannelPublication<Surface>,
): void {
	const surfaceRef = useRef(surface);
	surfaceRef.current = surface;
	const publicationRef =
		useRef<AgentSessionPaneChannelPublication<Surface>>(undefined);
	const published = surface !== undefined;
	useLayoutEffect(() => {
		const initial = surfaceRef.current;
		if (initial === undefined) return;
		const publication = publish(paneId, initial);
		publicationRef.current = publication;
		return () => {
			publicationRef.current = undefined;
			publication.dispose();
		};
	}, [paneId, published, publish]);
	useLayoutEffect(() => {
		if (surface !== undefined) publicationRef.current?.update(surface);
	});
}

/** Large window side: the presentation the source pane publishes, followed
 * for as long as this mirror is current; null until one arrives. */
export function useAgentSessionPaneMirror<Presentation, Command, Outcome>(
	mirror: AgentSessionPaneChannelMirror<Presentation, Command, Outcome> | undefined,
): Presentation | null {
	const [followed, setFollowed] = useState<{
		mirror: typeof mirror;
		presentation: Presentation | null;
	}>();
	useEffect(
		() =>
			mirror?.watch((presentation) => setFollowed({ mirror, presentation })),
		[mirror],
	);
	return followed && followed.mirror === mirror ? followed.presentation : null;
}
