// The one file an agent has put in front of the person. The main window's
// presenter writes the record; the presentation window only reads it.
import { containsCliControlCharacter } from "@/lib/cli/cliTextBoundary";
import type { FileTarget } from "@/lib/files/fileTarget";
import { localFilePanePath } from "../../../cli/lib/contracts/local-file-pane.mjs";

const STORAGE_KEY = "dure:file-presentation";
const MAX_ID_LENGTH = 512;

export const FILE_PRESENTATION_CHANGED_EVENT = "dure://file-presentation/changed";

export interface FilePresentation {
	/** New for every presentation, so presenting the same file again reloads it. */
	readonly id: string;
	readonly file: FileTarget & { readonly source: "local" };
	/** The registered Agent whose Session presented the file, when known. */
	readonly presenterAgentId?: string;
}

function identifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_ID_LENGTH &&
		!containsCliControlCharacter(value)
	);
}

/** Parse a record at the storage/event boundary; anything else is no presentation. */
export function parseFilePresentation(
	value: unknown,
): FilePresentation | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const { id, file, presenterAgentId } = value as Record<string, unknown>;
	if (!identifier(id) || !file || typeof file !== "object") return undefined;
	const { source, path } = file as Record<string, unknown>;
	if (source !== "local") return undefined;
	try {
		return {
			id,
			file: { source, path: localFilePanePath(path, { absolute: true }) },
			...(identifier(presenterAgentId) ? { presenterAgentId } : {}),
		};
	} catch {
		return undefined;
	}
}

/** The presenter is named only when exactly one registered Agent runs in the
 * invoking Session; it labels the window and is not an authenticated identity. */
export function presenterAgentIdForSession(
	agents: readonly { id: string; sessionId: string }[],
	sessionId: string | undefined,
): string | undefined {
	if (!sessionId) return undefined;
	const matches = agents.filter((agent) => agent.sessionId === sessionId);
	return matches.length === 1 ? matches[0].id : undefined;
}

export function fileBaseName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

type PresentationStorage = Pick<Storage, "getItem" | "setItem">;

export function readFilePresentation(
	storage: PresentationStorage = localStorage,
): FilePresentation | undefined {
	try {
		const stored = storage.getItem(STORAGE_KEY);
		return stored ? parseFilePresentation(JSON.parse(stored)) : undefined;
	} catch {
		return undefined;
	}
}

/** Store before announcing, so a window that subscribes late still reads the latest record. */
export function storeFilePresentation(
	presentation: FilePresentation,
	storage: PresentationStorage = localStorage,
): void {
	try {
		storage.setItem(STORAGE_KEY, JSON.stringify(presentation));
	} catch {
		// The announcement still reaches an open window.
	}
}

export interface FilePresentationTransport {
	listen(listener: (payload: unknown) => void): Promise<() => void>;
	read(): FilePresentation | undefined;
}

/** Subscribe first, then read the stored record, so a presentation made while
 * the window was still loading cannot fall between the two. */
export function subscribeFilePresentation(
	onPresentation: (presentation: FilePresentation) => void,
	transport: FilePresentationTransport,
): () => void {
	let disposed = false;
	let stop: (() => void) | undefined;
	void transport
		.listen((payload) => {
			const presentation = parseFilePresentation(payload);
			if (presentation && !disposed) onPresentation(presentation);
		})
		.then((unlisten) => {
			if (disposed) {
				unlisten();
				return;
			}
			stop = unlisten;
			const stored = transport.read();
			if (stored) onPresentation(stored);
		})
		.catch(() => {
			const stored = transport.read();
			if (stored && !disposed) onPresentation(stored);
		});
	return () => {
		disposed = true;
		stop?.();
	};
}
