import { useCallback, useSyncExternalStore } from "react";
import { fileDraftKey, type FileTarget } from "@/lib/files/fileTarget";
import { createBroadcast } from "@/lib/state/broadcast";

/** A 1-based line, and optionally a 1-based column, to show in a file. */
export interface FileRevealPosition {
	readonly line: number;
	readonly column?: number;
}

export interface FileRevealRequest extends FileRevealPosition {
	readonly id: number;
}

// Opening a file at a line asks its viewer to show that line. The request
// waits here until a code editor for the document applies it: a new pane
// mounts, and loads the file, after the open has returned. It is presentation
// intent, never part of the document identity or the saved layout.
const pending = new Map<string, FileRevealRequest>();
const changes = createBroadcast<string>();
let nextRevealId = 0;

export function requestFileReveal(
	target: FileTarget,
	position: FileRevealPosition,
): void {
	const key = fileDraftKey(target);
	nextRevealId += 1;
	pending.set(key, { ...position, id: nextRevealId });
	changes.publish(key);
}

export function readFileReveal(
	target: FileTarget,
): FileRevealRequest | undefined {
	return pending.get(fileDraftKey(target));
}

/** Clears the request once it has been shown, unless a newer one replaced it. */
export function completeFileReveal(target: FileTarget, id: number): void {
	const key = fileDraftKey(target);
	if (pending.get(key)?.id !== id) return;
	pending.delete(key);
	changes.publish(key);
}

export function subscribeFileReveal(
	target: FileTarget,
	listener: () => void,
): () => void {
	const key = fileDraftKey(target);
	return changes.subscribe((changed) => {
		if (changed === key) listener();
	});
}

/** The document's outstanding reveal request, if any. */
export function useFileReveal(
	target: FileTarget,
): FileRevealRequest | undefined {
	const { path, source, hostId } = target;
	const subscribe = useCallback(
		(listener: () => void) =>
			subscribeFileReveal({ path, source, hostId }, listener),
		[path, source, hostId],
	);
	const read = useCallback(
		() => readFileReveal({ path, source, hostId }),
		[path, source, hostId],
	);
	return useSyncExternalStore(subscribe, read, read);
}
