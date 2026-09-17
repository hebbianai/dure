import type { TerminalQaBufferState } from "@/lib/terminal/terminalViewContracts";
import type {
	TerminalQaInputReceipt,
	TerminalWindowFocusProbe,
	TerminalWindowFocusProbeSurface,
} from "@/lib/terminal/terminalWindowFocusProbe";

const STRUCTURED_SURFACE_TIMEOUT_MS = 30_000;

export interface StructuredTerminalQaInputObservation {
	readonly receipt: TerminalQaInputReceipt;
	readonly projection: TerminalQaBufferState;
	readonly markerCounts: {
		readonly painted: number;
		readonly projection: number | null;
	};
}

export interface StructuredTerminalQaProbeLifecycle {
	onConnected(): () => void;
	onFocused(): void;
	onHydrationChange(hydrating: boolean): void;
	onSynchronized(): void;
	onPresented(state: TerminalQaBufferState): void;
	onError(error: unknown): void;
}

interface PendingObservation {
	readonly marker: string;
	readonly surface: TerminalWindowFocusProbeSurface;
	readonly onProjection: (state: TerminalQaBufferState) => void;
	readonly resolve: (state: TerminalQaBufferState) => void;
	readonly rejectProjection: (error: Error) => void;
	readonly cancel: (error: Error) => void;
	readonly timeout: ReturnType<typeof setTimeout>;
	projected: boolean;
}

interface ProbeConnection {
	readonly token: symbol;
	readonly surface: TerminalWindowFocusProbeSurface;
	readonly release: () => void;
}

interface PendingRetirement {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
	readonly timeout: ReturnType<typeof setTimeout>;
}

/**
 * Adapts a structured terminal's semantic QA surface into a receipt plus
 * painted-projection observation. One probe follows one mounted surface; a
 * reconnect replaces the connection and rejects any operation still pending
 * on the retired attachment.
 */
export class StructuredTerminalQaProbe implements TerminalWindowFocusProbe {
	private connection: ProbeConnection | undefined;
	private readonly pendingObservations = new Set<PendingObservation>();
	private lastPresentation: TerminalQaBufferState | undefined;
	private hydrating = true;
	private synchronized = false;
	private disposed = false;
	private readonly pendingRetirements = new Map<string, PendingRetirement>();
	private currentAttachmentId: string | undefined;
	private readonly reportedRetirements = new Map<string, Promise<void>>();
	private retirementTail: Promise<void> = Promise.resolve();
	private readonly retirementFailures: Error[] = [];

	constructor(
		private readonly surfaceId: string,
		private readonly lifecycle: StructuredTerminalQaProbeLifecycle,
		private readonly timeoutMs = STRUCTURED_SURFACE_TIMEOUT_MS,
	) {}

	get connected() {
		return (
			this.connection !== undefined &&
			!this.disposed &&
			!this.hydrating &&
			this.synchronized &&
			this.lastPresentation !== undefined
		);
	}

	get hasSurfaceAttachment() {
		return this.currentAttachmentId !== undefined && !this.disposed;
	}

	connect(surface: TerminalWindowFocusProbeSurface): () => void {
		if (this.disposed) return () => {};
		this.disconnectCurrent("structured terminal QA surface replaced");
		this.resetAttachmentReadiness();
		const token = Symbol(this.surfaceId);
		const release = this.lifecycle.onConnected();
		this.connection = { token, surface, release };
		return () => {
			if (this.connection?.token !== token) return;
			this.disconnectCurrent("structured terminal QA surface disconnected");
		};
	}

	async focus(): Promise<void> {
		const connection = this.requireConnection();
		await this.withDeadline(
			connection.surface.focus(),
			`timed out waiting for structured terminal focus: ${this.surfaceId}`,
		);
		if (this.connection?.token !== connection.token) {
			throw new Error("structured terminal QA surface changed during focus");
		}
		this.lifecycle.onFocused();
	}

	async observeInput(
		marker: string,
		input: string,
		observers: {
			readonly onReceipt: (receipt: TerminalQaInputReceipt) => void;
			readonly onProjection: (state: TerminalQaBufferState) => void;
		},
	): Promise<StructuredTerminalQaInputObservation> {
		const surface = this.requireConnection().surface;
		let pending: PendingObservation | undefined;
		let receivedReceipt: TerminalQaInputReceipt | undefined;
		let cancel!: (error: Error) => void;
		const cancellation = new Promise<never>((_resolve, reject) => {
			cancel = reject;
		});
		const projection = new Promise<TerminalQaBufferState>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (pending) this.pendingObservations.delete(pending);
				const error = new Error(
					`timed out waiting for structured terminal receipt and projection: ${this.surfaceId}; ${JSON.stringify(
						{
							receipt: receivedReceipt?.state ?? null,
							paintedMarkerCount: surface.markerCounts()[marker] ?? 0,
							projectionMarkerCount:
								surface.projectionMarkerCounts?.()[marker] ?? null,
							connected: this.connected,
							attachmentCurrent: pending?.surface === this.connection?.surface,
						},
					)}`,
				);
				pending?.rejectProjection(error);
				cancel(error);
			}, this.timeoutMs);
			pending = {
				marker,
				surface,
				onProjection: observers.onProjection,
				resolve,
				rejectProjection: reject,
				cancel,
				timeout,
				projected: false,
			};
			this.pendingObservations.add(pending);
		});
		try {
			const receipt = surface.writeMarker(marker, input).then((value) => {
				receivedReceipt = value;
				if (pending && this.pendingObservations.has(pending)) {
					observers.onReceipt(value);
				}
				return value;
			});
			const [observedReceipt, paintedProjection] = await Promise.race([
				Promise.all([receipt, projection]),
				cancellation,
			]);
			return {
				receipt: observedReceipt,
				projection: paintedProjection,
				markerCounts: {
					painted: surface.markerCounts()[marker] ?? 0,
					projection: surface.projectionMarkerCounts?.()[marker] ?? null,
				},
			};
		} finally {
			if (pending) this.removePending(pending);
		}
	}

	bufferState(logicalMarker?: string): TerminalQaBufferState | undefined {
		return (
			this.connection?.surface.bufferState(logicalMarker) ??
			this.lastPresentation
		);
	}

	onLargeViewReturnPrepared(): void {}

	onSurfaceAttachmentStarted(attachmentId: string): void {
		if (this.disposed) return;
		this.currentAttachmentId = attachmentId;
		this.resetAttachmentReadiness();
		this.retirePending("structured terminal attachment changed");
	}

	onSurfaceRetirement(attachmentId: string, retirement: Promise<void>): void {
		if (this.disposed) {
			void retirement.catch(() => {});
			return;
		}
		const reported = this.withDeadline(
			retirement,
			`timed out waiting for structured terminal retirement: ${this.surfaceId}`,
		).then(
			() => {
				this.settleRetirement(attachmentId);
			},
			(error) => {
				this.recordRetirementFailure(asError(error));
				this.settleRetirement(attachmentId);
			},
		);
		this.reportedRetirements.set(attachmentId, reported);
		this.retirementTail = Promise.all([this.retirementTail, reported]).then(
			() => undefined,
		);
	}

	waitForSurfaceRetirement(): Promise<void> {
		if (this.disposed) {
			return Promise.reject(new Error("structured terminal QA probe disposed"));
		}
		return this.drainSurfaceRetirements();
	}

	private waitForAttachmentRetirement(attachmentId: string): Promise<void> {
		const reported = this.reportedRetirements.get(attachmentId);
		if (reported) return reported;
		const existing = this.pendingRetirements.get(attachmentId);
		if (existing) return existing.promise;
		let resolve!: () => void;
		const promise = new Promise<void>((settle) => {
			resolve = settle;
		});
		const pending: PendingRetirement = {
			promise,
			resolve,
			timeout: setTimeout(() => {
				if (this.pendingRetirements.get(attachmentId) !== pending) return;
				this.recordRetirementFailure(
					new Error(
						`timed out waiting for structured terminal retirement: ${this.surfaceId}`,
					),
				);
				this.settleRetirement(attachmentId);
			}, this.timeoutMs),
		};
		this.pendingRetirements.set(attachmentId, pending);
		return promise;
	}

	private async drainSurfaceRetirements(): Promise<void> {
		while (true) {
			const attachmentId = this.currentAttachmentId;
			if (!attachmentId) {
				throw new Error(
					"structured terminal QA attachment identity is missing",
				);
			}
			await this.waitForAttachmentRetirement(attachmentId);
			const retirementTail = this.retirementTail;
			await retirementTail;
			if (this.disposed) {
				throw new Error("structured terminal QA probe disposed");
			}
			if (
				attachmentId !== this.currentAttachmentId ||
				retirementTail !== this.retirementTail
			) {
				continue;
			}
			if (this.retirementFailures.length > 0) {
				throw new Error(
					`structured terminal retirement failed: ${this.retirementFailures
						.map((error) => error.message)
						.join("; ")}`,
				);
			}
			return;
		}
	}

	onHydrationChange(hydrating: boolean): void {
		if (this.disposed) return;
		this.hydrating = hydrating;
		if (hydrating) {
			this.resetAttachmentReadiness();
			this.retirePending("structured terminal attachment changed");
		}
		this.lifecycle.onHydrationChange(hydrating);
	}

	onSynchronized(): void {
		if (this.disposed) return;
		this.synchronized = true;
		this.lifecycle.onSynchronized();
	}

	onPresented(state: TerminalQaBufferState): void {
		if (this.disposed) return;
		this.lastPresentation = state;
		this.lifecycle.onPresented(state);
		const connection = this.connection;
		if (!connection) return;
		for (const pending of [...this.pendingObservations]) {
			if (pending.projected || pending.surface !== connection.surface) continue;
			const projection = pending.surface.bufferState(pending.marker);
			if (projection.logicalScrollbackMarkerPresent !== true) continue;
			pending.projected = true;
			try {
				pending.onProjection(projection);
				pending.resolve(projection);
			} catch (error) {
				pending.rejectProjection(asError(error));
			}
		}
	}

	onError(error: unknown): void {
		if (this.disposed) return;
		this.lifecycle.onError(error);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.disconnectCurrent("structured terminal QA probe disposed");
		for (const attachmentId of this.pendingRetirements.keys()) {
			this.settleRetirement(attachmentId);
		}
		this.currentAttachmentId = undefined;
		this.reportedRetirements.clear();
	}

	private requireConnection(): ProbeConnection {
		const connection = this.connection;
		if (!connection || !this.connected) {
			throw new Error(
				`structured terminal QA surface is missing: ${this.surfaceId}`,
			);
		}
		return connection;
	}

	private disconnectCurrent(reason: string) {
		const connection = this.connection;
		this.connection = undefined;
		connection?.release();
		this.retirePending(reason);
	}

	private resetAttachmentReadiness() {
		this.hydrating = true;
		this.synchronized = false;
		this.lastPresentation = undefined;
	}

	private retirePending(reason: string) {
		for (const pending of [...this.pendingObservations]) {
			const error = new Error(reason);
			this.removePending(pending);
			pending.rejectProjection(error);
			pending.cancel(error);
		}
	}

	private removePending(pending: PendingObservation) {
		clearTimeout(pending.timeout);
		this.pendingObservations.delete(pending);
	}

	private settleRetirement(attachmentId: string) {
		const pending = this.pendingRetirements.get(attachmentId);
		if (!pending) return;
		clearTimeout(pending.timeout);
		this.pendingRetirements.delete(attachmentId);
		pending.resolve();
	}

	private recordRetirementFailure(error: Error) {
		this.retirementFailures.push(error);
		if (!this.disposed) this.lifecycle.onError(error);
	}

	private async withDeadline<T>(
		operation: Promise<T>,
		message: string,
	): Promise<T> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				operation,
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() => reject(new Error(message)),
						this.timeoutMs,
					);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
