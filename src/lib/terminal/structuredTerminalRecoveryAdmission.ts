import type { TerminalPresentationRole } from "./presentation/terminalPresentationRoleStore";
import type { TerminalRecoveryAdmissionEvent } from "./terminalRecoveryPerformance";

interface RecoveryWaiter {
	readonly signal: AbortSignal;
	readonly readRole: () => TerminalPresentationRole;
	readonly operation: () => unknown;
	readonly resolve: (value: unknown) => void;
	readonly reject: (cause: unknown) => void;
	readonly onAbort: () => void;
	readonly onState?: (event: TerminalRecoveryAdmissionEvent) => void;
}

export interface TerminalRecoveryAdmissionRequest<T> {
	readonly signal: AbortSignal;
	readonly readRole: () => TerminalPresentationRole;
	readonly operation: () => T | Promise<T>;
	readonly onState?: (event: TerminalRecoveryAdmissionEvent) => void;
}

/**
 * Bounds the recovery attach phase through its counted initial delivery in one
 * workspace. Observer streams remain pane-owned after that phase settles.
 */
export class StructuredTerminalRecoveryAdmission {
	private active = 0;
	private readonly queued: RecoveryWaiter[] = [];

	constructor(private readonly concurrency = 4) {}

	run<T>(request: TerminalRecoveryAdmissionRequest<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const waiter: RecoveryWaiter = {
				...request,
				resolve: resolve as (value: unknown) => void,
				reject,
				onAbort: () => {
					const index = this.queued.indexOf(waiter);
					if (index < 0) return;
					this.queued.splice(index, 1);
					request.onState?.({ state: "cancelled" });
					reject(request.signal.reason);
				},
			};
			if (request.signal.aborted) {
				reject(request.signal.reason);
				return;
			}
			if (this.active < this.concurrency) {
				this.start(waiter);
				return;
			}
			request.signal.addEventListener("abort", waiter.onAbort, { once: true });
			this.queued.push(waiter);
			request.onState?.({ state: "queued", role: request.readRole() });
		});
	}

	private start(waiter: RecoveryWaiter, waited = false) {
		waiter.signal.removeEventListener("abort", waiter.onAbort);
		if (waiter.signal.aborted) {
			waiter.reject(waiter.signal.reason);
			this.pump();
			return;
		}
		this.active += 1;
		waiter.onState?.({ state: "admitted", role: waiter.readRole(), waited });
		let operation: Promise<unknown>;
		try {
			operation = Promise.resolve(waiter.operation());
		} catch (cause) {
			operation = Promise.reject(cause);
		}
		void operation.then(
			(value) => {
				this.release();
				waiter.resolve(value);
			},
			(cause) => {
				this.release();
				waiter.reject(cause);
			},
		);
	}

	private release() {
		this.active -= 1;
		this.pump();
	}

	private pump() {
		while (this.active < this.concurrency && this.queued.length > 0) {
			const foreground = this.queued.findIndex(
				(waiter) => waiter.readRole() === "foreground",
			);
			const visible =
				foreground < 0
					? this.queued.findIndex(
							(waiter) => waiter.readRole() !== "background",
						)
					: foreground;
			const [next] = this.queued.splice(visible < 0 ? 0 : visible, 1);
			if (next) this.start(next, true);
		}
	}
}
