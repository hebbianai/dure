import type { HmuxManagedIdleReplacementGuardV1 } from "@/lib/ipc";
import type { AutomaticManagedRehostCandidate } from "@/lib/sessions/managed/automaticManagedRehostPolicy";

export interface AutomaticManagedRehostInspectionFence {
	agentId: string;
	desktopId: string;
	panelId: string;
	sourceBinding: {
		sessionId: string;
		workspaceId: string;
	};
}

interface AutomaticManagedRehostExecutionOptions {
	/** Final asynchronous frontend race fence before the backend journal/stop. */
	beforeStop: () => Promise<HmuxManagedIdleReplacementGuardV1>;
}

export interface AutomaticManagedRehostCoordinatorDependencies<
	Inspection extends
		AutomaticManagedRehostInspectionFence = AutomaticManagedRehostInspectionFence,
	Execution = unknown,
	Payload = unknown,
> {
	now: () => number;
	/** Finish reboot/interrupted journal convergence before considering an
	 * optional healthy-source build replacement. */
	convergeInterrupted?: () => Promise<boolean>;
	findEligible: () => Promise<readonly AutomaticManagedRehostCandidate[]>;
	inspect: (agentId: string, panelId: string) => Promise<Inspection>;
	assertStillEligible: (
		candidate: AutomaticManagedRehostCandidate,
		inspection: Inspection,
	) => Promise<HmuxManagedIdleReplacementGuardV1>;
	execute: (
		inspection: Inspection,
		options: AutomaticManagedRehostExecutionOptions,
	) => Promise<Execution>;
	payload: (inspection: Inspection, execution: Execution) => Payload;
	synchronize: (payload: Payload) => Promise<Payload | null>;
	emit: (payload: Payload) => Promise<void>;
	onError: (
		error: unknown,
		candidate?: AutomaticManagedRehostCandidate,
	) => void;
}

export interface AutomaticManagedRehostCoordinatorOptions {
	eligibilityDwellMs: number;
	failureCooldownMs: number;
}

interface PendingCompletion<Payload> {
	candidate: AutomaticManagedRehostCandidate;
	payload: Payload;
}

let automaticManagedRehostGlobalInFlight: Promise<boolean> | undefined;

/** One main-window coordinator owns unattended replacements. Overlapping timer,
 * focus, and store wakes share the same promise, which makes concurrency one
 * even when a pass crosses multiple async preflight boundaries. */
export class AutomaticManagedRehostCoordinator<
	Inspection extends
		AutomaticManagedRehostInspectionFence = AutomaticManagedRehostInspectionFence,
	Execution = unknown,
	Payload = unknown,
> {
	private readonly eligibleSince = new Map<string, number>();
	private readonly cooldownUntil = new Map<string, number>();
	private inFlight: Promise<boolean> | undefined;
	private pendingCompletion: PendingCompletion<Payload> | undefined;

	constructor(
		private readonly dependencies: AutomaticManagedRehostCoordinatorDependencies<
			Inspection,
			Execution,
			Payload
		>,
		private readonly options: AutomaticManagedRehostCoordinatorOptions,
	) {}

	runPass(): Promise<boolean> {
		if (this.inFlight) return this.inFlight;
		if (automaticManagedRehostGlobalInFlight) {
			return automaticManagedRehostGlobalInFlight;
		}
		const operation = this.runPassOnce();
		this.inFlight = operation;
		automaticManagedRehostGlobalInFlight = operation;
		void operation.finally(() => {
			if (this.inFlight === operation) this.inFlight = undefined;
			if (automaticManagedRehostGlobalInFlight === operation) {
				automaticManagedRehostGlobalInFlight = undefined;
			}
		});
		return operation;
	}

	private async finishPendingCompletion(): Promise<boolean> {
		const pending = this.pendingCompletion;
		if (!pending) return false;
		const synchronized = await this.dependencies.synchronize(pending.payload);
		if (!synchronized) {
			throw new Error("automatic_managed_rehost_sync_deferred");
		}
		await this.dependencies.emit(synchronized);
		this.pendingCompletion = undefined;
		this.eligibleSince.delete(pending.candidate.identity);
		this.cooldownUntil.delete(pending.candidate.identity);
		return true;
	}

	private async runPassOnce(): Promise<boolean> {
		if (this.pendingCompletion) {
			try {
				return await this.finishPendingCompletion();
			} catch (error) {
				this.dependencies.onError(error, this.pendingCompletion?.candidate);
				return false;
			}
		}
		if (this.dependencies.convergeInterrupted) {
			try {
				if (await this.dependencies.convergeInterrupted()) return true;
			} catch (error) {
				this.dependencies.onError(error);
				return false;
			}
		}

		let candidates: readonly AutomaticManagedRehostCandidate[];
		try {
			candidates = await this.dependencies.findEligible();
		} catch (error) {
			this.dependencies.onError(error);
			return false;
		}
		const now = this.dependencies.now();
		const currentIdentities = new Set(
			candidates.map((candidate) => candidate.identity),
		);
		for (const identity of this.eligibleSince.keys()) {
			if (!currentIdentities.has(identity)) this.eligibleSince.delete(identity);
		}
		for (const candidate of candidates) {
			if (!this.eligibleSince.has(candidate.identity)) {
				this.eligibleSince.set(candidate.identity, now);
			}
		}
		const candidate = [...candidates]
			.sort((left, right) => left.identity.localeCompare(right.identity))
			.find((entry) => {
				const eligibleSince = this.eligibleSince.get(entry.identity);
				return (
					eligibleSince !== undefined &&
					now - eligibleSince >= this.options.eligibilityDwellMs &&
					(this.cooldownUntil.get(entry.identity) ?? 0) <= now
				);
			});
		if (!candidate) return false;

		try {
			const inspection = await this.dependencies.inspect(
				candidate.agentId,
				candidate.panelId,
			);
			if (
				inspection.agentId !== candidate.agentId ||
				inspection.desktopId !== candidate.desktopId ||
				inspection.panelId !== candidate.panelId
			) {
				throw new Error("automatic_managed_rehost_inspection_changed");
			}
			const execution = await this.dependencies.execute(inspection, {
				beforeStop: () =>
					this.dependencies.assertStillEligible(candidate, inspection),
			});
			const payload = this.dependencies.payload(inspection, execution);
			// Preserve the validated receipt before attempting the frontend CAS.
			// A failed CAS retries this payload and never launches a duplicate.
			this.pendingCompletion = { candidate, payload };
			return await this.finishPendingCompletion();
		} catch (error) {
			this.cooldownUntil.set(
				candidate.identity,
				this.dependencies.now() + this.options.failureCooldownMs,
			);
			this.dependencies.onError(error, candidate);
			return false;
		}
	}
}
