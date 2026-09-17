import {
	type ClientViewAuthorityV1,
	type ClientViewGenerationAdvanceRequestV1,
	type ClientViewIdentityV1,
	type ClientViewNamespaceV1,
	type ClientViewPresentationField,
	type ClientViewPresentationV1,
	type ClientViewRecordV1,
	type ClientViewStateTransport,
	type ClientViewTransportError,
	type ClientViewWriteRequestV1,
	cloneClientViewNamespace as cloneNamespace,
	cloneClientViewPresentation as clonePresentation,
	EMPTY_CLIENT_VIEW_PRESENTATION_V1,
	clientViewIdentitiesEqual as identitiesEqual,
	mergeClientViewPresentations as mergePresentations,
	clientViewNamespacesEqual as namespacesEqual,
	clientViewPresentationsEqual as presentationsEqual,
} from "@/lib/workspace/clientViewState";

interface ClientViewConflict {
	reason: "overlapping_changes" | "retry_budget_exhausted";
	fields: ClientViewPresentationField[];
	local: ClientViewPresentationV1;
	remote: ClientViewPresentationV1;
	remoteRevision: number;
}

export type ClientViewSyncPhase =
	| "idle"
	| "loading"
	| "ready"
	| "saving"
	| "offline"
	| "conflict"
	| "fenced"
	| "fatal"
	| "closed";

export interface ClientViewSyncSnapshot {
	phase: ClientViewSyncPhase;
	presentation: ClientViewPresentationV1;
	revision: number;
	dirty: boolean;
	automaticRetryCount: number;
	conflict?: ClientViewConflict;
	lastError?: ClientViewTransportError;
}

type ClientViewSyncResult =
	| { status: "synced"; revision: number }
	| {
			status: "deferred";
			reason: "transport" | "coalesced";
			retryScheduled: boolean;
	  }
	| { status: "conflict"; conflict: ClientViewConflict }
	| { status: "fenced"; authority: ClientViewAuthorityV1 }
	| { status: "fatal"; error: ClientViewTransportError }
	| { status: "closed" };

interface ClientViewSyncScheduler {
	schedule(callback: () => void, delayMs: number): unknown;
	cancel(handle: unknown): void;
}

export interface ClientViewStateSyncOptions {
	namespace: ClientViewNamespaceV1;
	viewId: string;
	clientInstanceId: string;
	initialPresentation: ClientViewPresentationV1;
	transport: ClientViewStateTransport;
	debounceMs?: number;
	maxAutomaticRetries?: number;
	maxConflictReconciles?: number;
	maxWritesPerFlush?: number;
	retryDelayMs?: (attempt: number) => number;
	makeIdempotencyKey?: () => string;
	scheduler?: ClientViewSyncScheduler;
}

export interface ClientViewStateSync {
	start(): Promise<ClientViewSyncResult>;
	getSnapshot(): ClientViewSyncSnapshot;
	subscribe(listener: (snapshot: ClientViewSyncSnapshot) => void): () => void;
	update(
		update:
			| ClientViewPresentationV1
			| ((current: ClientViewPresentationV1) => ClientViewPresentationV1),
	): boolean;
	flush(): Promise<ClientViewSyncResult>;
	retry(): Promise<ClientViewSyncResult>;
	resolveConflict(presentation: ClientViewPresentationV1): boolean;
	shutdown(options?: { flush?: boolean }): Promise<ClientViewSyncResult>;
}

const defaultScheduler: ClientViewSyncScheduler = {
	schedule: (callback, delayMs) => setTimeout(callback, delayMs),
	cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

let defaultIdempotencySequence = 0;

function defaultIdempotencyKey(): string {
	defaultIdempotencySequence += 1;
	return `client-view-${Date.now().toString(36)}-${defaultIdempotencySequence.toString(36)}`;
}

class ClientViewStateSyncController implements ClientViewStateSync {
	private readonly namespace: ClientViewNamespaceV1;
	private readonly viewId: string;
	private readonly clientInstanceId: string;
	private readonly transport: ClientViewStateTransport;
	private readonly debounceMs: number;
	private readonly maxAutomaticRetries: number;
	private readonly maxConflictReconciles: number;
	private readonly maxWritesPerFlush: number;
	private readonly retryDelayMs: (attempt: number) => number;
	private readonly makeIdempotencyKey: () => string;
	private readonly scheduler: ClientViewSyncScheduler;
	private readonly listeners = new Set<
		(snapshot: ClientViewSyncSnapshot) => void
	>();

	private phase: ClientViewSyncPhase = "idle";
	private presentation: ClientViewPresentationV1;
	private basePresentation: ClientViewPresentationV1;
	private revision = 0;
	private dirty = false;
	private localVersion = 0;
	private automaticRetryCount = 0;
	private conflict?: ClientViewConflict;
	private lastError?: ClientViewTransportError;
	private authority?: ClientViewAuthorityV1;
	private initialized = false;
	private initialization?: Promise<ClientViewSyncResult>;
	private activeFlush?: Promise<ClientViewSyncResult>;
	private timer?: unknown;
	private generationIdempotencyKey?: string;
	private pendingWrite?: {
		localVersion: number;
		request: ClientViewWriteRequestV1;
	};
	private closing = false;
	private closed = false;

	constructor(options: ClientViewStateSyncOptions) {
		this.namespace = cloneNamespace(options.namespace);
		this.viewId = options.viewId;
		this.clientInstanceId = options.clientInstanceId;
		this.transport = options.transport;
		this.debounceMs = options.debounceMs ?? 150;
		this.maxAutomaticRetries = options.maxAutomaticRetries ?? 3;
		this.maxConflictReconciles = options.maxConflictReconciles ?? 1;
		this.maxWritesPerFlush = options.maxWritesPerFlush ?? 8;
		this.retryDelayMs =
			options.retryDelayMs ?? ((attempt) => 250 * 2 ** (attempt - 1));
		this.makeIdempotencyKey =
			options.makeIdempotencyKey ?? defaultIdempotencyKey;
		this.scheduler = options.scheduler ?? defaultScheduler;
		this.presentation = clonePresentation(options.initialPresentation);
		this.basePresentation = clonePresentation(options.initialPresentation);
	}

	start(): Promise<ClientViewSyncResult> {
		if (this.closed || this.closing)
			return Promise.resolve({ status: "closed" });
		return this.ensureInitialized();
	}

	getSnapshot(): ClientViewSyncSnapshot {
		return {
			phase: this.phase,
			presentation: clonePresentation(this.presentation),
			revision: this.revision,
			dirty: this.dirty,
			automaticRetryCount: this.automaticRetryCount,
			conflict: this.conflict
				? {
						...this.conflict,
						fields: [...this.conflict.fields],
						local: clonePresentation(this.conflict.local),
						remote: clonePresentation(this.conflict.remote),
					}
				: undefined,
			lastError: this.lastError,
		};
	}

	subscribe(listener: (snapshot: ClientViewSyncSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	update(
		update:
			| ClientViewPresentationV1
			| ((current: ClientViewPresentationV1) => ClientViewPresentationV1),
	): boolean {
		if (this.closed || this.closing) return false;
		const current = clonePresentation(this.presentation);
		const next = clonePresentation(
			typeof update === "function" ? update(current) : update,
		);
		if (presentationsEqual(next, this.presentation)) return true;
		this.presentation = next;
		this.localVersion += 1;
		this.dirty = !presentationsEqual(this.presentation, this.basePresentation);
		this.pendingWrite = undefined;
		this.automaticRetryCount = 0;
		if (this.conflict) {
			this.conflict = {
				...this.conflict,
				local: clonePresentation(next),
			};
			this.phase = "conflict";
			this.emit();
			return true;
		}
		if (this.phase === "fenced" || this.phase === "fatal") {
			this.emit();
			return true;
		}
		if (this.phase === "offline") {
			this.cancelTimer();
			if (!this.activeFlush && !this.initialization) {
				this.schedule(this.debounceMs);
			}
			this.emit();
			return true;
		}
		this.lastError = undefined;
		if (this.phase !== "loading" && this.phase !== "saving") {
			this.phase = this.authority ? "ready" : "idle";
		}
		this.cancelTimer();
		if (!this.activeFlush && !this.initialization) {
			this.schedule(this.debounceMs);
		}
		this.emit();
		return true;
	}

	flush(): Promise<ClientViewSyncResult> {
		if (this.closed) return Promise.resolve({ status: "closed" });
		if (this.activeFlush) return this.activeFlush;
		this.cancelTimer();
		const active = this.runFlush().finally(() => {
			if (this.activeFlush === active) this.activeFlush = undefined;
		});
		this.activeFlush = active;
		return active;
	}

	async retry(): Promise<ClientViewSyncResult> {
		if (this.closed || this.closing) return { status: "closed" };
		if (this.phase === "fenced" || this.phase === "fatal" || this.conflict) {
			return this.currentTerminalResult();
		}
		this.automaticRetryCount = 0;
		this.lastError = undefined;
		return this.flush();
	}

	resolveConflict(presentation: ClientViewPresentationV1): boolean {
		if (!this.conflict || this.closed || this.closing) return false;
		this.presentation = clonePresentation(presentation);
		this.basePresentation = clonePresentation(this.conflict.remote);
		this.revision = this.conflict.remoteRevision;
		this.localVersion += 1;
		this.dirty = !presentationsEqual(this.presentation, this.basePresentation);
		this.conflict = undefined;
		this.lastError = undefined;
		this.phase = "ready";
		this.pendingWrite = undefined;
		this.automaticRetryCount = 0;
		if (this.dirty) this.schedule(this.debounceMs);
		this.emit();
		return true;
	}

	async shutdown(
		options: { flush?: boolean } = {},
	): Promise<ClientViewSyncResult> {
		if (this.closed) return { status: "closed" };
		this.closing = true;
		this.cancelTimer();
		let result: ClientViewSyncResult = { status: "closed" };
		if (this.activeFlush) {
			result = await this.activeFlush;
		} else if (options.flush !== false) {
			result = await this.runFlush();
		} else if (this.initialization) {
			result = await this.initialization;
		}
		this.closed = true;
		this.closing = false;
		this.phase = "closed";
		this.emit();
		this.listeners.clear();
		return result;
	}

	private emit(): void {
		if (this.listeners.size === 0) return;
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) listener(snapshot);
	}

	private cancelTimer(): void {
		if (this.timer === undefined) return;
		this.scheduler.cancel(this.timer);
		this.timer = undefined;
	}

	private schedule(delayMs: number): void {
		if (
			this.timer !== undefined ||
			this.closed ||
			this.closing ||
			this.conflict ||
			this.phase === "fenced" ||
			this.phase === "fatal"
		) {
			return;
		}
		this.timer = this.scheduler.schedule(
			() => {
				this.timer = undefined;
				void this.flush();
			},
			Math.max(0, delayMs),
		);
	}

	private ensureInitialized(): Promise<ClientViewSyncResult> {
		if (this.initialized) return Promise.resolve(this.currentReadyResult());
		if (this.initialization) return this.initialization;
		const initialization = this.initialize().finally(() => {
			if (this.initialization === initialization)
				this.initialization = undefined;
		});
		this.initialization = initialization;
		return initialization;
	}

	private async initialize(): Promise<ClientViewSyncResult> {
		this.phase = "loading";
		this.emit();
		const authorityResult = await this.transport.readAuthority(this.namespace);
		if (!authorityResult.ok) return this.handleError(authorityResult.error);

		let authority = authorityResult.value;
		if (authority && !this.validAuthority(authority)) {
			return this.fail("invalid client view authority");
		}
		if (!authority || authority.clientInstanceId !== this.clientInstanceId) {
			this.generationIdempotencyKey ??= this.makeIdempotencyKey();
			const request: ClientViewGenerationAdvanceRequestV1 = {
				schemaVersion: 1,
				namespace: cloneNamespace(this.namespace),
				idempotencyKey: this.generationIdempotencyKey,
				expectedGeneration: authority?.clientGeneration ?? 0,
				expectedInstanceId: authority?.clientInstanceId,
				nextInstanceId: this.clientInstanceId,
			};
			const advanceResult = await this.transport.advanceGeneration(request);
			if (!advanceResult.ok) {
				if (
					advanceResult.error.kind !== "generation_conflict" &&
					advanceResult.error.kind !== "instance_conflict"
				) {
					return this.handleError(advanceResult.error);
				}
				const observedResult = await this.transport.readAuthority(
					this.namespace,
				);
				if (!observedResult.ok) return this.handleError(observedResult.error);
				const observed = observedResult.value;
				if (!observed || !this.validAuthority(observed)) {
					return this.fail("generation conflict has no valid authority");
				}
				this.generationIdempotencyKey = undefined;
				if (observed.clientInstanceId !== this.clientInstanceId) {
					this.authority = observed;
					this.initialized = true;
					this.phase = "fenced";
					this.lastError = advanceResult.error;
					this.emit();
					return { status: "fenced", authority: observed };
				}
				authority = observed;
			} else {
				if (
					advanceResult.value.idempotencyKey !== request.idempotencyKey ||
					!this.validAuthority(
						advanceResult.value.authority,
						this.clientInstanceId,
					)
				) {
					return this.fail("invalid generation receipt");
				}
				authority = advanceResult.value.authority;
				this.generationIdempotencyKey = undefined;
			}
		}

		this.authority = authority;
		const identity = this.identity();
		const readResult = await this.transport.readView(identity);
		if (!readResult.ok) return this.handleError(readResult.error);
		if (readResult.value && !this.validRecord(readResult.value, identity)) {
			return this.fail("invalid client view record");
		}

		const record = readResult.value;
		const remote = clonePresentation(
			record?.presentation ?? EMPTY_CLIENT_VIEW_PRESENTATION_V1,
		);
		this.revision = record?.revision ?? 0;
		if (record && !this.dirty) {
			this.presentation = clonePresentation(remote);
			this.basePresentation = clonePresentation(remote);
			this.dirty = false;
		} else if (record) {
			const merged = mergePresentations(
				this.basePresentation,
				this.presentation,
				remote,
			);
			this.basePresentation = clonePresentation(remote);
			if (merged.conflictingFields.length > 0) {
				this.initialized = true;
				return this.setConflict(
					"overlapping_changes",
					merged.conflictingFields,
					remote,
					this.revision,
				);
			}
			this.presentation = merged.presentation;
			this.dirty = !presentationsEqual(this.presentation, remote);
		} else {
			this.basePresentation = clonePresentation(remote);
			this.dirty = !presentationsEqual(this.presentation, remote);
		}

		this.initialized = true;
		this.phase = "ready";
		this.lastError = undefined;
		this.automaticRetryCount = 0;
		if (this.dirty) this.schedule(this.debounceMs);
		this.emit();
		return this.currentReadyResult();
	}

	private async runFlush(): Promise<ClientViewSyncResult> {
		const initialized = await this.ensureInitialized();
		if (initialized.status !== "synced") return initialized;
		this.cancelTimer();
		let conflictReconciles = 0;
		let generationRefreshes = 0;
		let writes = 0;

		while (this.dirty) {
			if (writes >= this.maxWritesPerFlush) {
				this.phase = "ready";
				if (!this.closing) this.schedule(this.debounceMs);
				this.emit();
				return {
					status: "deferred",
					reason: "coalesced",
					retryScheduled: !this.closing,
				};
			}
			writes += 1;
			this.phase = "saving";
			this.emit();
			const pending = this.writeRequest();
			const baseBeforeWrite = clonePresentation(this.basePresentation);
			const writeResult = await this.transport.writeView(pending.request);
			if (writeResult.ok) {
				if (
					writeResult.value.idempotencyKey !== pending.request.idempotencyKey ||
					!this.validRecord(
						writeResult.value.record,
						pending.request.identity,
					) ||
					writeResult.value.record.revision <=
						pending.request.expectedRevision ||
					!presentationsEqual(
						writeResult.value.record.presentation,
						pending.request.presentation,
					)
				) {
					return this.fail("invalid client view write receipt");
				}
				this.revision = writeResult.value.record.revision;
				this.basePresentation = clonePresentation(
					writeResult.value.record.presentation,
				);
				this.pendingWrite = undefined;
				this.automaticRetryCount = 0;
				this.lastError = undefined;
				if (pending.localVersion === this.localVersion) {
					this.presentation = clonePresentation(this.basePresentation);
					this.dirty = false;
				} else {
					this.dirty = !presentationsEqual(
						this.presentation,
						this.basePresentation,
					);
				}
				continue;
			}

			if (writeResult.error.kind === "revision_conflict") {
				this.pendingWrite = undefined;
				const reconciliation = await this.reconcileRevision(
					baseBeforeWrite,
					conflictReconciles >= this.maxConflictReconciles,
				);
				if (reconciliation) return reconciliation;
				conflictReconciles += 1;
				continue;
			}

			if (
				writeResult.error.kind === "generation_conflict" ||
				writeResult.error.kind === "instance_conflict"
			) {
				this.pendingWrite = undefined;
				if (generationRefreshes >= 1) {
					return this.fail("client view generation changed repeatedly");
				}
				generationRefreshes += 1;
				const reconciliation = await this.reconcileAuthority(baseBeforeWrite);
				if (reconciliation) return reconciliation;
				continue;
			}

			return this.handleError(writeResult.error);
		}

		this.phase = "ready";
		this.emit();
		return { status: "synced", revision: this.revision };
	}

	private writeRequest(): {
		localVersion: number;
		request: ClientViewWriteRequestV1;
	} {
		if (
			this.pendingWrite &&
			this.pendingWrite.localVersion === this.localVersion &&
			this.pendingWrite.request.expectedRevision === this.revision &&
			identitiesEqual(this.pendingWrite.request.identity, this.identity())
		) {
			return this.pendingWrite;
		}
		this.pendingWrite = {
			localVersion: this.localVersion,
			request: {
				schemaVersion: 1,
				identity: this.identity(),
				idempotencyKey: this.makeIdempotencyKey(),
				expectedRevision: this.revision,
				presentation: clonePresentation(this.presentation),
			},
		};
		return this.pendingWrite;
	}

	private async reconcileRevision(
		base: ClientViewPresentationV1,
		retryBudgetExhausted: boolean,
	): Promise<ClientViewSyncResult | undefined> {
		const identity = this.identity();
		const readResult = await this.transport.readView(identity);
		if (!readResult.ok) return this.handleError(readResult.error);
		if (!readResult.value || !this.validRecord(readResult.value, identity)) {
			return this.fail("revision conflict did not resolve to an exact view");
		}
		const remote = clonePresentation(readResult.value.presentation);
		this.revision = readResult.value.revision;
		const merged = mergePresentations(base, this.presentation, remote);
		this.basePresentation = clonePresentation(remote);
		if (presentationsEqual(this.presentation, remote)) {
			this.presentation = remote;
			this.dirty = false;
			return undefined;
		}
		if (retryBudgetExhausted || merged.conflictingFields.length > 0) {
			return this.setConflict(
				retryBudgetExhausted ? "retry_budget_exhausted" : "overlapping_changes",
				merged.conflictingFields,
				remote,
				this.revision,
			);
		}
		this.presentation = merged.presentation;
		this.localVersion += 1;
		this.dirty = !presentationsEqual(this.presentation, remote);
		return undefined;
	}

	private async reconcileAuthority(
		base: ClientViewPresentationV1,
	): Promise<ClientViewSyncResult | undefined> {
		const authorityResult = await this.transport.readAuthority(this.namespace);
		if (!authorityResult.ok) return this.handleError(authorityResult.error);
		const authority = authorityResult.value;
		if (!authority) return this.fail("client view authority disappeared");
		if (!this.validAuthority(authority)) {
			return this.fail("invalid replacement client view authority");
		}
		if (authority.clientInstanceId !== this.clientInstanceId) {
			this.authority = authority;
			this.phase = "fenced";
			this.lastError = {
				kind: "instance_conflict",
				message: "a newer client instance owns this namespace",
			};
			this.cancelTimer();
			this.emit();
			return { status: "fenced", authority };
		}

		this.authority = authority;
		const identity = this.identity();
		const readResult = await this.transport.readView(identity);
		if (!readResult.ok) return this.handleError(readResult.error);
		if (readResult.value && !this.validRecord(readResult.value, identity)) {
			return this.fail("invalid refreshed client view record");
		}
		const remote = clonePresentation(
			readResult.value?.presentation ?? EMPTY_CLIENT_VIEW_PRESENTATION_V1,
		);
		this.revision = readResult.value?.revision ?? 0;
		const merged = mergePresentations(base, this.presentation, remote);
		this.basePresentation = clonePresentation(remote);
		if (merged.conflictingFields.length > 0) {
			return this.setConflict(
				"overlapping_changes",
				merged.conflictingFields,
				remote,
				this.revision,
			);
		}
		this.presentation = merged.presentation;
		this.localVersion += 1;
		this.dirty = !presentationsEqual(this.presentation, remote);
		return undefined;
	}

	private setConflict(
		reason: ClientViewConflict["reason"],
		fields: ClientViewPresentationField[],
		remote: ClientViewPresentationV1,
		remoteRevision: number,
	): ClientViewSyncResult {
		this.conflict = {
			reason,
			fields: [...fields],
			local: clonePresentation(this.presentation),
			remote: clonePresentation(remote),
			remoteRevision,
		};
		this.dirty = true;
		this.phase = "conflict";
		this.cancelTimer();
		this.emit();
		return { status: "conflict", conflict: this.getSnapshot().conflict! };
	}

	private handleError(error: ClientViewTransportError): ClientViewSyncResult {
		this.lastError = error;
		if (error.kind === "backend_changed") {
			const preserveLocal = this.dirty;
			this.initialized = false;
			this.authority = undefined;
			this.revision = 0;
			this.basePresentation = clonePresentation(
				EMPTY_CLIENT_VIEW_PRESENTATION_V1,
			);
			if (!preserveLocal) {
				this.presentation = clonePresentation(
					EMPTY_CLIENT_VIEW_PRESENTATION_V1,
				);
			}
			this.localVersion += 1;
			this.dirty =
				preserveLocal &&
				!presentationsEqual(
					this.presentation,
					EMPTY_CLIENT_VIEW_PRESENTATION_V1,
				);
			this.conflict = undefined;
			this.pendingWrite = undefined;
			this.generationIdempotencyKey = undefined;
		}
		if (error.kind === "unavailable" || error.kind === "backend_changed") {
			this.phase = "offline";
			this.automaticRetryCount += 1;
			const retryScheduled =
				!this.closing && this.automaticRetryCount <= this.maxAutomaticRetries;
			if (retryScheduled) {
				this.schedule(this.retryDelayMs(this.automaticRetryCount));
			}
			this.emit();
			return { status: "deferred", reason: "transport", retryScheduled };
		}
		this.phase = "fatal";
		this.cancelTimer();
		this.emit();
		return { status: "fatal", error };
	}

	private fail(message: string): ClientViewSyncResult {
		return this.handleError({ kind: "fatal", message });
	}

	private currentReadyResult(): ClientViewSyncResult {
		if (this.conflict) return { status: "conflict", conflict: this.conflict };
		if (this.phase === "fenced" || this.phase === "fatal") {
			return this.currentTerminalResult();
		}
		return { status: "synced", revision: this.revision };
	}

	private currentTerminalResult(): ClientViewSyncResult {
		if (this.conflict) return { status: "conflict", conflict: this.conflict };
		if (this.phase === "fenced" && this.authority) {
			return { status: "fenced", authority: this.authority };
		}
		return {
			status: "fatal",
			error: this.lastError ?? {
				kind: "fatal",
				message: "client view synchronization stopped",
			},
		};
	}

	private identity(): ClientViewIdentityV1 {
		if (!this.authority)
			throw new Error("client view authority is unavailable");
		return {
			namespace: cloneNamespace(this.namespace),
			clientGeneration: this.authority.clientGeneration,
			clientInstanceId: this.clientInstanceId,
			viewId: this.viewId,
		};
	}

	private validAuthority(
		authority: ClientViewAuthorityV1,
		expectedInstanceId?: string,
	): boolean {
		return (
			authority.schemaVersion === 1 &&
			namespacesEqual(authority.namespace, this.namespace) &&
			Number.isSafeInteger(authority.clientGeneration) &&
			authority.clientGeneration > 0 &&
			(!expectedInstanceId || authority.clientInstanceId === expectedInstanceId)
		);
	}

	private validRecord(
		record: ClientViewRecordV1,
		identity: ClientViewIdentityV1,
	): boolean {
		return (
			record.schemaVersion === 1 &&
			identitiesEqual(record.identity, identity) &&
			Number.isSafeInteger(record.revision) &&
			record.revision > 0
		);
	}
}

export function createClientViewStateSync(
	options: ClientViewStateSyncOptions,
): ClientViewStateSync {
	return new ClientViewStateSyncController(options);
}
