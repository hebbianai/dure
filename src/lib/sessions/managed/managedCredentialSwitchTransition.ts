import { useCallback, useSyncExternalStore } from "react";
import type { HmuxPaneHealthState } from "@/lib/terminal/terminalHealth";
import type { DeferredCredentialSwitchIntentV1 } from "@/types";

type CredentialSwitchCheckpoint = Pick<
	DeferredCredentialSwitchIntentV1,
	"completionRuntimeRevision" | "completionTurnCompletedCount" | "lastError"
>;

const activeTransitions = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

function publish(agentId: string): void {
	for (const listener of listeners.get(agentId) ?? []) listener();
}

/** Presentation-only signal for the source-stop -> replacement-binding gap. */
export function beginManagedCredentialSwitchTransition(
	agentId: string,
): () => void {
	const previousCount = activeTransitions.get(agentId) ?? 0;
	activeTransitions.set(agentId, previousCount + 1);
	if (previousCount === 0) publish(agentId);

	let ended = false;
	return () => {
		if (ended) return;
		ended = true;
		const currentCount = activeTransitions.get(agentId) ?? 0;
		if (currentCount <= 1) {
			activeTransitions.delete(agentId);
			publish(agentId);
			return;
		}
		activeTransitions.set(agentId, currentCount - 1);
	};
}

export function subscribeManagedCredentialSwitchTransition(
	agentId: string,
	listener: () => void,
): () => void {
	const agentListeners = listeners.get(agentId) ?? new Set();
	agentListeners.add(listener);
	listeners.set(agentId, agentListeners);
	return () => {
		agentListeners.delete(listener);
		if (agentListeners.size === 0) listeners.delete(agentId);
	};
}

export function getManagedCredentialSwitchTransition(agentId: string): boolean {
	return (activeTransitions.get(agentId) ?? 0) > 0;
}

/**
 * A durable completion checkpoint covers the reload-sized gap before the
 * runtime watcher resumes execution. A merely scheduled or failed intent does
 * not suppress a real connection failure.
 */
export function shouldPresentManagedCredentialSwitchTransition(
	activelyReplacing: boolean,
	intent?: CredentialSwitchCheckpoint,
): boolean {
	if (activelyReplacing) return true;
	return Boolean(
		intent &&
			intent.lastError === undefined &&
			intent.completionRuntimeRevision !== undefined &&
			intent.completionTurnCompletedCount !== undefined,
	);
}

export function useManagedCredentialSwitchTransition(
	agentId: string | undefined,
	intent?: CredentialSwitchCheckpoint,
): boolean {
	const subscribe = useCallback(
		(listener: () => void) =>
			agentId
				? subscribeManagedCredentialSwitchTransition(agentId, listener)
				: () => {},
		[agentId],
	);
	const read = useCallback(
		() => (agentId ? getManagedCredentialSwitchTransition(agentId) : false),
		[agentId],
	);
	const activelyReplacing = useSyncExternalStore(subscribe, read, read);
	return shouldPresentManagedCredentialSwitchTransition(
		activelyReplacing,
		intent,
	);
}

export function presentManagedCredentialSwitchHealthState(
	observed: HmuxPaneHealthState,
	credentialSwitchTransition: boolean,
): HmuxPaneHealthState {
	return credentialSwitchTransition &&
		(observed === "error" || observed === "stale")
		? "connecting"
		: observed;
}

export function useManagedCredentialSwitchHealthState(
	agentId: string | undefined,
	intent: CredentialSwitchCheckpoint | undefined,
	healthState: HmuxPaneHealthState | undefined,
): HmuxPaneHealthState {
	const credentialSwitchTransition = useManagedCredentialSwitchTransition(
		agentId,
		intent,
	);
	// The mounted transport owns pane connectivity. A catalog probe describes
	// session inventory and must not override an already attached surface.
	const observed = healthState ?? "connecting";
	return presentManagedCredentialSwitchHealthState(
		observed,
		credentialSwitchTransition,
	);
}

export async function withManagedCredentialSwitchTransition<T>(
	agentId: string,
	action: () => Promise<T>,
): Promise<T> {
	const end = beginManagedCredentialSwitchTransition(agentId);
	try {
		return await action();
	} finally {
		end();
	}
}
