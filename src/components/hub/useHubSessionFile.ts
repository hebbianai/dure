import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { saveSessionFiles } from "@/lib/files/sessionFileTransfer";
import {
	answerHubSessionFile,
	type HubSessionFileDispatch,
} from "@/lib/hub/sessionFileBridge";
import { hubSessionFileResult } from "@/lib/ipc/system";
import { isMainWindow } from "@/lib/workspace/window/windows";
import { useHubSessionLocations } from "./useHubSessionLocations";

export function useHubSessionFile(): void {
	const locations = useHubSessionLocations();
	useEffect(() => {
		if (!isMainWindow()) return;
		const pending = listen<HubSessionFileDispatch>(
			"hub://session-file",
			(event) => {
				void answerHubSessionFile(event.payload, {
					locate: (id) => locations.current.get(id),
					save: saveSessionFiles,
					report: hubSessionFileResult,
				});
			},
		);
		return () => {
			void pending.then((unlisten) => unlisten());
		};
	}, []);
}
