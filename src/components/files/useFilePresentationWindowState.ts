import { useEffect, useState } from "react";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import {
	FILE_PRESENTATION_CHANGED_EVENT,
	type FilePresentation,
	readFilePresentation,
	subscribeFilePresentation,
} from "@/lib/files/filePresentation";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import { useStore } from "@/store";

/** The presented file and its presenter's current name, read for the window. */
export function useFilePresentationWindowState(): {
	presentation: FilePresentation | undefined;
	presenterName: string | undefined;
} {
	const [presentation, setPresentation] = useState<FilePresentation>();
	useEffect(
		() =>
			subscribeFilePresentation(
				(next) =>
					setPresentation((current) =>
						current?.id === next.id ? current : next,
					),
				{
					listen: (listener) =>
						listenWhenReady<unknown>(FILE_PRESENTATION_CHANGED_EVENT, (event) =>
							listener(event.payload),
						),
					read: () => readFilePresentation(),
				},
			),
		[],
	);
	const presenterAgentId = presentation?.presenterAgentId;
	const presenterName = useStore((state) => {
		const agent = presenterAgentId
			? state.agents.find((candidate) => candidate.id === presenterAgentId)
			: undefined;
		return agent ? agentDisplayName(agent) : undefined;
	});
	return { presentation, presenterName };
}
