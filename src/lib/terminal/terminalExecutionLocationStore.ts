import { useSyncExternalStore } from "react";

import type { TerminalExecutionLocation } from "@/lib/terminal/terminalExecutionLocation";

const LOCAL: TerminalExecutionLocation = Object.freeze({ kind: "local" });
const locations = new Map<string, TerminalExecutionLocation>();
const observedSessions = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
const globalListeners = new Set<() => void>();
let revision = 0;

export function getTerminalExecutionLocation(
	sessionId: string,
): TerminalExecutionLocation {
	return locations.get(sessionId) ?? LOCAL;
}

export function hasTerminalExecutionLocationObservation(
	sessionId: string,
): boolean {
	return observedSessions.has(sessionId);
}

export function publishTerminalExecutionLocation(
	sessionId: string,
	location: TerminalExecutionLocation,
): void {
	const current = getTerminalExecutionLocation(sessionId);
	if (
		observedSessions.has(sessionId) &&
		current.kind === location.kind &&
		(current.kind !== "ssh" ||
			(location.kind === "ssh" && current.target === location.target))
	) {
		return;
	}
	observedSessions.add(sessionId);
	if (location.kind === "local") locations.delete(sessionId);
	else locations.set(sessionId, location);
	revision += 1;
	for (const listener of listeners.get(sessionId) ?? []) listener();
	for (const listener of globalListeners) listener();
}

function subscribeTerminalExecutionLocation(
	sessionId: string,
	listener: () => void,
): () => void {
	let sessionListeners = listeners.get(sessionId);
	if (!sessionListeners) {
		sessionListeners = new Set();
		listeners.set(sessionId, sessionListeners);
	}
	sessionListeners.add(listener);
	return () => {
		sessionListeners?.delete(listener);
		if (sessionListeners?.size === 0) listeners.delete(sessionId);
	};
}

export function subscribeTerminalExecutionLocations(
	listener: () => void,
): () => void {
	globalListeners.add(listener);
	return () => globalListeners.delete(listener);
}

export function getTerminalExecutionLocationRevision(): number {
	return revision;
}

export function useTerminalExecutionLocation(
	sessionId: string,
): TerminalExecutionLocation {
	return useSyncExternalStore(
		(listener) => subscribeTerminalExecutionLocation(sessionId, listener),
		() => getTerminalExecutionLocation(sessionId),
		() => getTerminalExecutionLocation(sessionId),
	);
}

export function useTerminalExecutionLocationObservation(
	sessionId: string,
): boolean {
	return useSyncExternalStore(
		(listener) => subscribeTerminalExecutionLocation(sessionId, listener),
		() => hasTerminalExecutionLocationObservation(sessionId),
		() => hasTerminalExecutionLocationObservation(sessionId),
	);
}
