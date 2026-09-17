import { reportPersistenceStatus } from "@/lib/persistence/persistenceStatus";
import {
	applyManagedAgentChainStoppedSync,
	applyManagedAgentStoppedSync,
} from "@/lib/sessions/managed/managedAgentStop";

type ApplyManagedStop = (payload: unknown) => Promise<boolean>;

export interface ManagedAgentStopObserverRuntime {
	readonly applyExact: ApplyManagedStop;
	readonly applyChain: ApplyManagedStop;
	readonly report: (error: unknown) => void;
}

const runtime: ManagedAgentStopObserverRuntime = {
	applyExact: applyManagedAgentStoppedSync,
	applyChain: applyManagedAgentChainStoppedSync,
	report: (error) => reportPersistenceStatus("error", String(error)),
};

/**
 * The event is only a notification; the exact cleanup transaction remains the
 * authority. Retry it once in that writer FIFO, then consume/report any second
 * rejection so Tauri's void event callback never leaks an unhandled promise.
 */
async function applyThroughDurableCleanup(
	payload: unknown,
	apply: ApplyManagedStop,
	report: (error: unknown) => void,
): Promise<void> {
	try {
		await apply(payload);
	} catch (firstError) {
		report(firstError);
		try {
			await apply(payload);
		} catch (retryError) {
			report(retryError);
		}
	}
}

export function createManagedAgentStopObservers(
	deps: ManagedAgentStopObserverRuntime = runtime,
): {
	readonly exact: (payload: unknown) => Promise<void>;
	readonly chain: (payload: unknown) => Promise<void>;
} {
	return {
		exact: (payload) =>
			applyThroughDurableCleanup(payload, deps.applyExact, deps.report),
		chain: (payload) =>
			applyThroughDurableCleanup(payload, deps.applyChain, deps.report),
	};
}
