type RefreshPhase =
	| "action.start"
	| "resume.prepare"
	| "resume.join"
	| "launch.ready"
	| "capabilities.start"
	| "capabilities.ready"
	| "invoke.start"
	| "invoke.received"
	| "resolution.ready"
	| "projection.start"
	| "projection.ready"
	| "resume.publish"
	| "action.complete";

interface RefreshCheckpoint {
	phase: RefreshPhase;
	elapsedMs: number;
}

export interface ManagedRefreshTiming {
	mark(phase: RefreshPhase): void;
	snapshot(): {
		schemaVersion: 1;
		clock: "webview_monotonic";
		startedAtUnixMs: number;
		totalMs: number;
		checkpoints: RefreshCheckpoint[];
		truncated: boolean;
	};
}

export interface ManagedCreateDiagnostics {
	brokerTiming?: boolean;
	/** Request-local observer. Never serialized into the native launch input. */
	timing?: ManagedRefreshTiming;
}

/** Created only by an opted-in action, never retained in Store or a registry.
 * Closed labels contain no launch arguments, paths, identities or errors. */
export function createManagedRefreshTiming(
	clock = { now: () => performance.now(), unixMs: () => Date.now() },
): ManagedRefreshTiming {
	const startedAtUnixMs = clock.unixMs();
	const started = clock.now();
	const checkpoints: RefreshCheckpoint[] = [
		{ phase: "action.start", elapsedMs: 0 },
	];
	let truncated = false;
	return {
		mark(phase) {
			if (checkpoints.length >= 32) {
				truncated = true;
				return;
			}
			checkpoints.push({ phase, elapsedMs: clock.now() - started });
		},
		snapshot: () => ({
			schemaVersion: 1,
			clock: "webview_monotonic",
			startedAtUnixMs,
			totalMs: clock.now() - started,
			checkpoints: checkpoints.map((checkpoint) => ({ ...checkpoint })),
			truncated,
		}),
	};
}
