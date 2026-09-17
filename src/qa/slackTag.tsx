import { DockviewReact, type DockviewApi } from "dockview-react";
import { useEffect, useRef } from "react";
import { SharedConversationPanel } from "@/components/agents/chat/SharedConversationPanel";
import { DureTagPane } from "@/components/tag/DureTagPane";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";

const components = { sharedconversation: SharedConversationPanel };

/** Production sidebar, routing, Dockview and conversation in the disposable
 * native QA window. It needs no second agent or copied conversation history. */
export function SlackTagQa() {
	const space = useStore((state) => state.activeSpaceId)!;
	const api = useRef<DockviewApi | undefined>(undefined);
	useEffect(
		() => () => {
			if (api.current) unregisterDockview(space, api.current);
		},
		[space],
	);
	return (
		<div className="flex h-[650px]" data-qa-tag="">
			<div className="flex w-[300px] shrink-0">
				<DureTagPane />
			</div>
			<div className="min-w-0 flex-1">
				<DockviewReact
					components={components}
					onReady={(event) => {
						api.current = event.api;
						registerDockview(space, event.api);
					}}
				/>
			</div>
		</div>
	);
}
