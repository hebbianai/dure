interface WindowCloseRequest {
	preventDefault(): void;
}

export interface DurableWindowCloseRuntime {
	readonly prepare?: () => Promise<void> | void;
	readonly settleDurableState: () => Promise<void>;
	readonly close: () => Promise<void>;
	readonly onFailure?: (error: unknown) => Promise<void> | void;
}

export interface DurableWindowCloseBarrier {
	handle(event: WindowCloseRequest): Promise<void>;
}

/** Coordinates the work that precedes one native window close. */
export function createDurableWindowCloseBarrier(
	runtime: DurableWindowCloseRuntime,
): DurableWindowCloseBarrier {
	let bypass = false;
	let closeAnywayArmed = false;
	let inFlight: Promise<void> | undefined;
	return {
		async handle(event) {
			if (bypass) return;
			event.preventDefault();
			if (inFlight) return inFlight;
			const attempt = (async () => {
				const closeDespitePreCloseFailure = closeAnywayArmed;
				try {
					await runtime.prepare?.();
				} catch (error) {
					if (!closeDespitePreCloseFailure) {
						closeAnywayArmed = true;
						await runtime.onFailure?.(error);
						return;
					}
				}
				try {
					await runtime.settleDurableState();
				} catch (error) {
					if (!closeDespitePreCloseFailure) {
						closeAnywayArmed = true;
						await runtime.onFailure?.(error);
						return;
					}
				}
				closeAnywayArmed = false;
				bypass = true;
				try {
					await runtime.close();
				} catch (error) {
					bypass = false;
					closeAnywayArmed = true;
					await runtime.onFailure?.(error);
				}
			})();
			inFlight = attempt;
			try {
				await attempt;
			} finally {
				if (inFlight === attempt) inFlight = undefined;
			}
		},
	};
}
