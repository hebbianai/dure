import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import {
	FILE_PRESENTATION_CHANGED_EVENT,
	type FilePresentation,
	fileBaseName,
	presenterAgentIdForSession,
	storeFilePresentation,
} from "@/lib/files/filePresentation";
import { emitWhenReady } from "@/lib/platform/tauriBridge";
import {
	FILE_PRESENTATION_WINDOW_LABEL,
	openFilePresentationWindow,
} from "@/lib/workspace/window/windows";
import { useStore } from "@/store";
import { localFilePanePath } from "../../../cli/lib/contracts/local-file-pane.mjs";

let presenting: Promise<unknown> = Promise.resolve();

/**
 * Put one local file in front of the person in the presentation window. The
 * record is stored and announced before the window is revealed, so an open
 * window switches to it and a new window reads it as it loads. Presentations
 * run one at a time, so the second one reuses the window the first opened.
 * The receipt confirms the window, not that the file could be read; read
 * errors show in the viewer as they do in a pane.
 */
export function presentLocalFile(path: string, presenterSessionId?: string) {
	const run = presenting.then(
		() => present(path, presenterSessionId),
		() => present(path, presenterSessionId),
	);
	presenting = run.catch(() => undefined);
	return run;
}

async function present(path: string, presenterSessionId: string | undefined) {
	const { agents } = useStore.getState();
	const presenterAgentId = presenterAgentIdForSession(
		agents,
		presenterSessionId,
	);
	const presenter = agents.find((agent) => agent.id === presenterAgentId);
	const presentation: FilePresentation = {
		id: crypto.randomUUID(),
		file: { source: "local", path: localFilePanePath(path, { absolute: true }) },
		...(presenter ? { presenterAgentId: presenter.id } : {}),
	};
	storeFilePresentation(presentation);
	// The stored record covers a window that misses this announcement.
	await emitWhenReady(FILE_PRESENTATION_CHANGED_EVENT, presentation).catch(
		() => undefined,
	);
	const opening = await openFilePresentationWindow(
		fileBaseName(presentation.file.path),
	);
	return {
		label: FILE_PRESENTATION_WINDOW_LABEL,
		file: presentation.file,
		reused: opening === "revealed",
		...(presenter
			? {
					presenter: {
						agentId: presenter.id,
						name: agentDisplayName(presenter),
					},
				}
			: {}),
	};
}
