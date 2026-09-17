import type {
	LargeViewReturnIdentity,
	LargeViewReturnPreparationRequest,
	LargeViewReturnPreparationResult,
	LargeViewReturnRetirementRequest,
} from "./largeViewReturnHandoff";

export interface LargeViewReturnSourceRegistration
	extends LargeViewReturnIdentity {
	sourcePaneOwnerId: string;
	legacyEligible(): boolean;
	prepare(generation: string): LargeViewReturnPreparationResult;
	retired?(generation: string): void;
}

export interface LargeViewReturnSourceCoordinatorClock {
	now(): number;
	setTimer(
		callback: () => void,
		delayMs: number,
	): ReturnType<typeof setTimeout>;
	clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const systemClock: LargeViewReturnSourceCoordinatorClock = {
	now: Date.now,
	setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimer: (timer) => clearTimeout(timer),
};

interface RegistrationEntry {
	token: symbol;
	registration: LargeViewReturnSourceRegistration;
}

interface RegistrationWaiter {
	request: LargeViewReturnPreparationRequest;
	resolve(registration: LargeViewReturnSourceRegistration | undefined): void;
	timer: ReturnType<typeof setTimeout>;
}

function sameSession(
	left: LargeViewReturnIdentity,
	right: LargeViewReturnIdentity,
): boolean {
	return (
		left.workspaceId === right.workspaceId && left.sessionId === right.sessionId
	);
}

function exactRegistration(
	entries: Iterable<RegistrationEntry>,
	request: LargeViewReturnIdentity,
): LargeViewReturnSourceRegistration | undefined {
	const candidates = [...entries];
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const candidate = candidates[index]?.registration;
		if (
			candidate &&
			sameSession(candidate, request) &&
			candidate.sourcePaneOwnerId === request.sourcePaneOwnerId
		) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Routes one window's large-view return requests to terminal registrations.
 * Exact requests activate their source pane first and may wait for a cold
 * desktop to mount. Legacy requests keep the old visible-pane-only fallback.
 */
export class LargeViewReturnSourceCoordinator {
	private readonly registrations = new Map<symbol, RegistrationEntry>();
	private readonly waiters = new Set<RegistrationWaiter>();
	private disposed = false;

	constructor(
		private readonly activateExactPane: (paneOwnerId: string) => boolean,
		private readonly clock: LargeViewReturnSourceCoordinatorClock = systemClock,
	) {}

	register(registration: LargeViewReturnSourceRegistration): () => void {
		if (this.disposed) return () => {};
		const token = Symbol(registration.sourcePaneOwnerId);
		this.registrations.set(token, { token, registration });
		this.releaseMatchingWaiters();
		return () => {
			this.registrations.delete(token);
		};
	}

	async prepare(
		request: LargeViewReturnPreparationRequest,
	): Promise<LargeViewReturnPreparationResult> {
		if (this.disposed || request.expiresAtMs <= this.clock.now()) return false;
		if (!request.sourcePaneOwnerId) {
			const registration = [...this.registrations.values()]
				.map((entry) => entry.registration)
				.find(
					(candidate) =>
						sameSession(candidate, request) && candidate.legacyEligible(),
				);
			if (!registration) return false;
			return registration.prepare(request.generation);
		}

		if (!this.activateExactPane(request.sourcePaneOwnerId)) return false;
		const registration =
			exactRegistration(this.registrations.values(), request) ??
			(await this.waitForRegistration(request));
		if (
			!registration ||
			this.disposed ||
			request.expiresAtMs <= this.clock.now()
		) {
			return false;
		}
		return registration.prepare(request.generation);
	}

	retired(request: LargeViewReturnRetirementRequest): void {
		if (request.sourcePaneOwnerId) {
			exactRegistration(this.registrations.values(), request)?.retired?.(
				request.generation,
			);
			return;
		}
		for (const { registration } of this.registrations.values()) {
			if (sameSession(registration, request)) {
				registration.retired?.(request.generation);
			}
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.registrations.clear();
		for (const waiter of this.waiters) {
			this.clock.clearTimer(waiter.timer);
			waiter.resolve(undefined);
		}
		this.waiters.clear();
	}

	private waitForRegistration(
		request: LargeViewReturnPreparationRequest,
	): Promise<LargeViewReturnSourceRegistration | undefined> {
		const remainingMs = request.expiresAtMs - this.clock.now();
		if (remainingMs <= 0) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			const waiter: RegistrationWaiter = {
				request,
				resolve,
				timer: this.clock.setTimer(() => {
					this.waiters.delete(waiter);
					resolve(undefined);
				}, remainingMs),
			};
			this.waiters.add(waiter);
		});
	}

	private releaseMatchingWaiters(): void {
		for (const waiter of [...this.waiters]) {
			const registration = exactRegistration(
				this.registrations.values(),
				waiter.request,
			);
			if (!registration) continue;
			this.waiters.delete(waiter);
			this.clock.clearTimer(waiter.timer);
			waiter.resolve(registration);
		}
	}
}

export interface LargeViewSourcePaneTarget {
	desktopId: string;
	panelId: string;
}

/** The pane runtime identity is `<desktopId>:<panelId>`; panel ids may contain colons. */
export function parseLargeViewSourcePaneOwnerId(
	value: string,
): LargeViewSourcePaneTarget | undefined {
	const separator = value.indexOf(":");
	if (separator <= 0 || separator === value.length - 1) return undefined;
	return {
		desktopId: value.slice(0, separator),
		panelId: value.slice(separator + 1),
	};
}
