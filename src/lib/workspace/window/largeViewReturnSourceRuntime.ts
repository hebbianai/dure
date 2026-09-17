import { subscribeLargeViewReturnLifecycleRequests } from "./largeViewReturnHandoff";
import {
	LargeViewReturnSourceCoordinator,
	type LargeViewReturnSourceRegistration,
	parseLargeViewSourcePaneOwnerId,
} from "./largeViewReturnSourceCoordinator";
import { LargeViewReturnSourceTransaction } from "./largeViewReturnTransaction";
import { activateLargeViewSourcePane } from "./largeViewSourcePane";

function activateExactSourcePane(paneOwnerId: string): boolean {
	const target = parseLargeViewSourcePaneOwnerId(paneOwnerId);
	return target ? activateLargeViewSourcePane(target) : false;
}

const coordinator = new LargeViewReturnSourceCoordinator(
	activateExactSourcePane,
);
let stopPreparationListener: (() => void) | undefined;

function ensurePreparationListener(): void {
	stopPreparationListener ??= subscribeLargeViewReturnLifecycleRequests({
		prepare: (request) => coordinator.prepare(request),
		retired: (request) => coordinator.retired(request),
	});
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		stopPreparationListener?.();
		coordinator.dispose();
	});
}

/** Registers one terminal with the window-level large-view return router. */
function registerLargeViewReturnSource(
	registration: LargeViewReturnSourceRegistration,
): () => void {
	ensurePreparationListener();
	return coordinator.register(registration);
}

interface BoundLargeViewReturnSourceOptions {
	workspaceId: string;
	sessionId: string;
	sourcePaneOwnerId: string;
	legacyEligible(): boolean;
	prepare?(generation: string): boolean;
	retired?(generation: string): void;
	conceal(): void;
	reveal(): void;
}

/** Couples exact-pane routing to one generation-fenced conceal transaction. */
export function bindLargeViewReturnSource(
	options: BoundLargeViewReturnSourceOptions,
) {
	const transaction = new LargeViewReturnSourceTransaction({
		conceal: options.conceal,
		reveal: options.reveal,
	});
	const unregister = registerLargeViewReturnSource({
		workspaceId: options.workspaceId,
		sessionId: options.sessionId,
		sourcePaneOwnerId: options.sourcePaneOwnerId,
		legacyEligible: options.legacyEligible,
		prepare: (generation) => {
			if (options.prepare?.(generation) === false) return false;
			if (!transaction.prepare(generation)) return false;
			return () => transaction.complete(generation);
		},
		retired: options.retired,
	});
	return {
		currentGeneration: () => transaction.currentGeneration(),
		complete: (generation: string | undefined) =>
			transaction.complete(generation),
		dispose: () => {
			unregister();
			transaction.dispose();
		},
	};
}
