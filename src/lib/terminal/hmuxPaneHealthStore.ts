import { useCallback, useSyncExternalStore } from "react";
import {
	type HmuxPaneHealth,
	type HmuxPaneHealthObservation,
	observeHmuxPaneHealth,
	sameHmuxPaneHealth,
} from "@/lib/terminal/terminalHealth";

export interface HmuxPaneHealthPresentation {
	readonly state: HmuxPaneHealth["state"];
	readonly reason: HmuxPaneHealth["reason"];
	readonly terminalEpoch: HmuxPaneHealth["terminalEpoch"];
	readonly receivedSequence: HmuxPaneHealth["receivedSequence"];
	readonly presentedSequence: HmuxPaneHealth["presentedSequence"];
}

interface HmuxPaneHealthEntry {
	readonly exact: HmuxPaneHealth;
	readonly presentation: HmuxPaneHealthPresentation;
}

const paneHealth = new Map<string, HmuxPaneHealthEntry>();
const presentationListeners = new Map<string, Set<() => void>>();

function projectPresentation(
	health: HmuxPaneHealth,
): HmuxPaneHealthPresentation {
	return {
		state: health.state,
		reason: health.reason,
		terminalEpoch: health.terminalEpoch,
		receivedSequence:
			health.state === "live" ? undefined : health.receivedSequence,
		presentedSequence:
			health.state === "live" ? undefined : health.presentedSequence,
	};
}

function samePresentation(
	left: HmuxPaneHealthPresentation | undefined,
	right: HmuxPaneHealthPresentation,
): boolean {
	return (
		left?.state === right.state &&
		left.reason === right.reason &&
		left.terminalEpoch === right.terminalEpoch &&
		left.receivedSequence === right.receivedSequence &&
		left.presentedSequence === right.presentedSequence
	);
}

function notifyPresentation(paneHealthId: string): void {
	for (const listener of presentationListeners.get(paneHealthId) ?? []) {
		listener();
	}
}

function subscribePresentation(
	paneHealthId: string,
	listener: () => void,
): () => void {
	let listeners = presentationListeners.get(paneHealthId);
	if (!listeners) {
		listeners = new Set();
		presentationListeners.set(paneHealthId, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners?.delete(listener);
		if (listeners?.size === 0) presentationListeners.delete(paneHealthId);
	};
}

export function getHmuxPaneHealth(
	paneHealthId: string,
): HmuxPaneHealth | undefined {
	return paneHealth.get(paneHealthId)?.exact;
}

function getHmuxPaneHealthPresentation(
	paneHealthId: string,
): HmuxPaneHealthPresentation | undefined {
	return paneHealth.get(paneHealthId)?.presentation;
}

/** Reduce one exact terminal observation into the pane-owned runtime fact. */
export function publishHmuxPaneHealthObservation(
	paneHealthId: string,
	observation: HmuxPaneHealthObservation,
	updatedAt = Date.now(),
): HmuxPaneHealth {
	const previousEntry = paneHealth.get(paneHealthId);
	const previous = previousEntry?.exact;
	const next = observeHmuxPaneHealth(previous, observation, updatedAt);
	if (sameHmuxPaneHealth(previous, next)) return previous ?? next;

	const nextPresentation = projectPresentation(next);
	if (samePresentation(previousEntry?.presentation, nextPresentation)) {
		paneHealth.set(paneHealthId, {
			exact: next,
			presentation: previousEntry?.presentation ?? nextPresentation,
		});
		return next;
	}

	paneHealth.set(paneHealthId, {
		exact: next,
		presentation: nextPresentation,
	});
	notifyPresentation(paneHealthId);
	return next;
}

/** Retire the complete exact record only with its pane owner. */
export function clearHmuxPaneHealth(paneHealthId: string): void {
	if (!paneHealth.delete(paneHealthId)) return;
	notifyPresentation(paneHealthId);
}

export function useHmuxPaneHealthPresentation(
	paneHealthId: string,
): HmuxPaneHealthPresentation | undefined {
	const subscribe = useCallback(
		(listener: () => void) => subscribePresentation(paneHealthId, listener),
		[paneHealthId],
	);
	const getSnapshot = useCallback(
		() => getHmuxPaneHealthPresentation(paneHealthId),
		[paneHealthId],
	);
	return useSyncExternalStore(
		subscribe,
		getSnapshot,
		getSnapshot,
	);
}
