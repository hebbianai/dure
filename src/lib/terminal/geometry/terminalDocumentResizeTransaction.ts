export type TerminalDocumentResizePhase = "idle" | "dragging" | "settling";

export type TerminalDocumentResizeFinishCause =
	| "pointerup"
	| "dblclick"
	| "pointercancel"
	| "lostpointercapture"
	| "contextmenu"
	| "blur"
	| "native_window"
	| "surface_ready";

const TRANSACTION_PROPERTY = "__dureTerminalDocumentResizeTransactionV1";
const RESIZE_PERMIT = Symbol("terminal-document-resize-permit");

interface TerminalCanonicalResizePermit {
	readonly [RESIZE_PERMIT]: true;
	readonly transactionGeneration: number;
	readonly registrationGeneration: number;
	readonly surfaceKey: string;
}

export interface TerminalResizeObservation {
	readonly observationEpoch: number;
	readonly registrationGeneration: number;
	readonly surfaceKey: string;
}

export interface TerminalDocumentResizeSurfaceOptions {
	/** Stable UI surface identity. A replacement view must reuse this key. */
	readonly surfaceKey: string;
	/** Runtime session identity, retained for diagnostics and invariant checks. */
	readonly sessionKey: string;
	/** Whether this exact registration may publish canonical geometry now. */
	canCommit(): boolean;
	/** Measure and synchronously start the final canonical resize request. */
	commit(permit: TerminalCanonicalResizePermit): boolean | Promise<boolean>;
	/** Paint-only preview hook. It must not mutate parser or backend geometry. */
	preview?(transactionGeneration: number): void;
	/** Cancels stale per-view frames when the document transaction changes phase. */
	onPhaseChange?(
		phase: TerminalDocumentResizePhase,
		transactionGeneration: number,
	): void;
}

export interface TerminalDocumentResizeSurfaceRegistration {
	readonly generation: number;
	readonly surfaceKey: string;
	captureObservation(): TerminalResizeObservation;
	/** Returns an observation only when an ordinary commit may be scheduled. */
	noteGeometryChanged(): TerminalResizeObservation | undefined;
	commitOrdinary(observation: TerminalResizeObservation): Promise<boolean>;
	dispose(): void;
}

export interface TerminalDocumentResizeLifecycleListener {
	begin(generation: number): void;
	settle(generation: number): unknown;
}

interface TerminalDocumentResizeSurfaceDiagnostic {
	readonly surfaceKey: string;
	readonly registrationCount: number;
	readonly latestRegistrationGeneration: number;
	readonly canCommit: boolean;
	readonly dirtyRevision: number;
	readonly committedRevision: number;
}

export interface TerminalDocumentResizeDiagnosticSnapshot {
	readonly phase: TerminalDocumentResizePhase;
	readonly generation: number;
	readonly observationEpoch: number;
	readonly targetSurfaceKey: string | null;
	readonly surfaces: readonly TerminalDocumentResizeSurfaceDiagnostic[];
}

interface SurfaceEntry {
	readonly generation: number;
	readonly options: TerminalDocumentResizeSurfaceOptions;
	disposed: boolean;
}

interface DirtySurface {
	revision: number;
	committedRevision: number;
}

interface TransactionState {
	phase: TerminalDocumentResizePhase;
	generation: number;
	targetSurfaceKey: string | undefined;
	observationEpoch: number;
	registrationGeneration: number;
	dirtyRevision: number;
	finishScheduledGeneration: number | undefined;
	readonly surfaces: Map<string, Map<number, SurfaceEntry>>;
	readonly dirtySurfaces: Map<string, DirtySurface>;
	readonly lifecycleListeners: Set<TerminalDocumentResizeLifecycleListener>;
}

type TransactionDocument = Document & {
	[TRANSACTION_PROPERTY]?: TransactionState;
};

function stateFor(doc: Document): TransactionState {
	const transactionDocument = doc as TransactionDocument;
	let state = transactionDocument[TRANSACTION_PROPERTY];
	if (!state) {
		state = {
			phase: "idle",
			generation: 0,
			targetSurfaceKey: undefined,
			observationEpoch: 0,
			registrationGeneration: 0,
			dirtyRevision: 0,
			finishScheduledGeneration: undefined,
			surfaces: new Map(),
			dirtySurfaces: new Map(),
			lifecycleListeners: new Set(),
		};
		Object.defineProperty(transactionDocument, TRANSACTION_PROPERTY, {
			configurable: true,
			value: state,
		});
	}
	return state;
}

function currentEntry(
	state: TransactionState,
	surfaceKey: string,
): SurfaceEntry | undefined {
	const registrations = state.surfaces.get(surfaceKey);
	if (!registrations) return undefined;
	let current: SurfaceEntry | undefined;
	for (const entry of registrations.values()) {
		if (
			entry.disposed ||
			!canCommit(entry) ||
			(current && current.generation > entry.generation)
		) {
			continue;
		}
		current = entry;
	}
	return current;
}

function canCommit(entry: SurfaceEntry): boolean {
	try {
		return entry.options.canCommit();
	} catch {
		return false;
	}
}

function permitFor(
	transactionGeneration: number,
	entry: SurfaceEntry,
): TerminalCanonicalResizePermit {
	return {
		[RESIZE_PERMIT]: true,
		transactionGeneration,
		registrationGeneration: entry.generation,
		surfaceKey: entry.options.surfaceKey,
	};
}

function notifyPhase(state: TransactionState): void {
	for (const registrations of state.surfaces.values()) {
		for (const entry of registrations.values()) {
			if (entry.disposed) continue;
			try {
				entry.options.onPhaseChange?.(state.phase, state.generation);
			} catch {
				// A retired surface cannot strand the document transaction.
			}
		}
	}
}

async function commitEntry(
	state: TransactionState,
	transactionGeneration: number,
	entry: SurfaceEntry,
): Promise<boolean> {
	if (
		entry.disposed ||
		state.generation !== transactionGeneration ||
		!canCommit(entry)
	) {
		return false;
	}
	try {
		return await entry.options.commit(permitFor(transactionGeneration, entry));
	} catch {
		return false;
	}
}

async function drainTransaction(
	state: TransactionState,
	transactionGeneration: number,
): Promise<void> {
	if (
		state.generation !== transactionGeneration ||
		state.phase !== "settling"
	) {
		return;
	}

	const lifecycleSettles = [...state.lifecycleListeners].map((listener) => {
		try {
			return Promise.resolve(listener.settle(transactionGeneration)).catch(
				() => undefined,
			);
		} catch {
			return Promise.resolve(undefined);
		}
	});
	let lifecycleSettled = lifecycleSettles.length === 0;
	let registrationGraceObserved = false;
	const attempted = new Map<
		string,
		{ readonly registrationGeneration: number; readonly revision: number }
	>();

	while (
		state.generation === transactionGeneration &&
		state.phase === "settling"
	) {
		const commits: Array<{
			readonly surfaceKey: string;
			readonly dirty: DirtySurface;
			readonly revision: number;
			readonly entry: SurfaceEntry;
			readonly result: Promise<boolean>;
		}> = [];
		for (const [surfaceKey, dirty] of state.dirtySurfaces) {
			if (dirty.revision <= dirty.committedRevision) continue;
			const entry = currentEntry(state, surfaceKey);
			if (!entry) continue;
			const priorAttempt = attempted.get(surfaceKey);
			if (
				priorAttempt?.registrationGeneration === entry.generation &&
				priorAttempt.revision >= dirty.revision
			) {
				continue;
			}
			const revision = dirty.revision;
			attempted.set(surfaceKey, {
				registrationGeneration: entry.generation,
				revision,
			});
			commits.push({
				surfaceKey,
				dirty,
				revision,
				entry,
				result: commitEntry(state, transactionGeneration, entry),
			});
		}
		if (commits.length > 0) {
			const results = await Promise.all(commits.map((commit) => commit.result));
			if (
				state.generation !== transactionGeneration ||
				state.phase !== "settling"
			) {
				return;
			}
			let madeProgress = false;
			for (const [index, committed] of results.entries()) {
				if (!committed) continue;
				const commit = commits[index];
				if (
					!commit ||
					state.dirtySurfaces.get(commit.surfaceKey) !== commit.dirty ||
					currentEntry(state, commit.surfaceKey) !== commit.entry
				) {
					continue;
				}
				commit.dirty.committedRevision = Math.max(
					commit.dirty.committedRevision,
					commit.revision,
				);
				madeProgress = true;
			}
			if (madeProgress) continue;
		}
		if (!lifecycleSettled) {
			await Promise.all(lifecycleSettles);
			lifecycleSettled = true;
			attempted.clear();
			continue;
		}
		if (
			!registrationGraceObserved &&
			[...state.dirtySurfaces.values()].some(
				(dirty) => dirty.revision > dirty.committedRevision,
			)
		) {
			registrationGraceObserved = true;
			await Promise.resolve();
			continue;
		}
		break;
	}
	if (
		state.generation !== transactionGeneration ||
		state.phase !== "settling"
	) {
		return;
	}
	for (const [surfaceKey, dirty] of state.dirtySurfaces) {
		if (dirty.revision <= dirty.committedRevision) {
			state.dirtySurfaces.delete(surfaceKey);
		}
	}
	state.finishScheduledGeneration = undefined;
	state.observationEpoch += 1;
	state.phase = "idle";
	notifyPhase(state);
	state.targetSurfaceKey = undefined;
}

export function beginTerminalDocumentResize(
	doc: Document,
	targetSurfaceKey?: string,
): number {
	if (targetSurfaceKey !== undefined && targetSurfaceKey.length === 0) {
		throw new Error(
			"terminal resize target surface identity must be non-empty",
		);
	}
	const state = stateFor(doc);
	state.generation += 1;
	state.targetSurfaceKey = targetSurfaceKey;
	state.observationEpoch += 1;
	state.finishScheduledGeneration = undefined;
	state.phase = "dragging";
	notifyPhase(state);
	for (const listener of [...state.lifecycleListeners]) {
		try {
			listener.begin(state.generation);
		} catch {
			// Legacy compatibility listeners cannot block the canonical authority.
		}
	}
	return state.generation;
}

export function finishTerminalDocumentResize(
	doc: Document,
	cause: TerminalDocumentResizeFinishCause,
	expectedGeneration?: number,
): void {
	const state = stateFor(doc);
	if (
		state.phase !== "dragging" ||
		(expectedGeneration !== undefined &&
			expectedGeneration !== state.generation)
	)
		return;
	const generation = state.generation;
	state.phase = "settling";
	state.finishScheduledGeneration = generation;
	notifyPhase(state);
	const settle = () => {
		if (
			state.finishScheduledGeneration !== generation ||
			state.generation !== generation ||
			state.phase !== "settling"
		) {
			return;
		}
		void drainTransaction(state, generation);
	};
	if (cause === "blur" || cause === "lostpointercapture") settle();
	else enqueueDocumentMicrotask(doc, settle);
}

function enqueueDocumentMicrotask(doc: Document, callback: () => void): void {
	if (doc.defaultView) {
		doc.defaultView.queueMicrotask(callback);
		return;
	}
	globalThis.queueMicrotask(callback);
}

export function terminalDocumentResizePhase(
	doc: Document,
): TerminalDocumentResizePhase {
	return stateFor(doc).phase;
}

/** Content-free projection of the one document resize authority. */
export function terminalDocumentResizeDiagnosticSnapshot(
	doc: Document,
): TerminalDocumentResizeDiagnosticSnapshot {
	const state = stateFor(doc);
	const surfaces = [...state.surfaces.entries()]
		.flatMap(([surfaceKey, registrations]) => {
			const live = [...registrations.values()].filter(
				(entry) => !entry.disposed,
			);
			const latest = live.reduce<SurfaceEntry | undefined>(
				(candidate, entry) =>
					!candidate || entry.generation > candidate.generation
						? entry
						: candidate,
				undefined,
			);
			if (!latest) return [];
			const dirty = state.dirtySurfaces.get(surfaceKey);
			return [
				{
					surfaceKey,
					registrationCount: live.length,
					latestRegistrationGeneration: latest.generation,
					canCommit: canCommit(latest),
					dirtyRevision: dirty?.revision ?? 0,
					committedRevision: dirty?.committedRevision ?? 0,
				},
			];
		})
		.sort((left, right) => left.surfaceKey.localeCompare(right.surfaceKey));
	return {
		phase: state.phase,
		generation: state.generation,
		observationEpoch: state.observationEpoch,
		targetSurfaceKey: state.targetSurfaceKey ?? null,
		surfaces,
	};
}

export function terminalDocumentResizeTargetsSurface(
	doc: Document,
	surfaceKey: string,
): boolean {
	const state = stateFor(doc);
	return state.phase !== "idle" && state.targetSurfaceKey === surfaceKey;
}

export function subscribeTerminalDocumentResizeLifecycle(
	doc: Document,
	listener: TerminalDocumentResizeLifecycleListener,
): () => void {
	const state = stateFor(doc);
	state.lifecycleListeners.add(listener);
	if (state.phase !== "idle") {
		try {
			listener.begin(state.generation);
		} catch {
			// A late compatibility subscriber does not own transaction progress.
		}
	}
	return () => state.lifecycleListeners.delete(listener);
}

export function registerTerminalDocumentResizeSurface(
	doc: Document,
	options: TerminalDocumentResizeSurfaceOptions,
): TerminalDocumentResizeSurfaceRegistration {
	if (!options.surfaceKey || !options.sessionKey) {
		throw new Error("terminal resize surface identity must be non-empty");
	}
	const state = stateFor(doc);
	const generation = ++state.registrationGeneration;
	const entry: SurfaceEntry = { generation, options, disposed: false };
	let registrations = state.surfaces.get(options.surfaceKey);
	if (!registrations) {
		registrations = new Map();
		state.surfaces.set(options.surfaceKey, registrations);
	}
	registrations.set(generation, entry);
	if (state.phase !== "idle") {
		try {
			options.onPhaseChange?.(state.phase, state.generation);
		} catch {
			// Registration remains valid; later phase notifications can recover it.
		}
	}

	const captureObservation = (): TerminalResizeObservation => ({
		observationEpoch: state.observationEpoch,
		registrationGeneration: generation,
		surfaceKey: options.surfaceKey,
	});

	return {
		generation,
		surfaceKey: options.surfaceKey,
		captureObservation,
		noteGeometryChanged: () => {
			const observation = captureObservation();
			if (entry.disposed) return undefined;
			if (state.phase === "idle") return observation;
			const revision = ++state.dirtyRevision;
			const dirty = state.dirtySurfaces.get(options.surfaceKey);
			if (dirty) {
				dirty.revision = revision;
			} else {
				state.dirtySurfaces.set(options.surfaceKey, {
					revision,
					committedRevision: 0,
				});
			}
			options.preview?.(state.generation);
			return undefined;
		},
		commitOrdinary: async (observation) => {
			if (
				entry.disposed ||
				state.phase !== "idle" ||
				state.observationEpoch !== observation.observationEpoch ||
				observation.registrationGeneration !== generation ||
				observation.surfaceKey !== options.surfaceKey ||
				currentEntry(state, options.surfaceKey) !== entry
			) {
				return false;
			}
			const transactionGeneration = state.generation;
			const committed = await commitEntry(state, transactionGeneration, entry);
			if (
				!committed ||
				entry.disposed ||
				state.phase !== "idle" ||
				state.generation !== transactionGeneration ||
				state.observationEpoch !== observation.observationEpoch ||
				currentEntry(state, options.surfaceKey) !== entry
			) {
				return false;
			}
			state.dirtySurfaces.delete(options.surfaceKey);
			return true;
		},
		dispose: () => {
			if (entry.disposed) return;
			entry.disposed = true;
			const currentRegistrations = state.surfaces.get(options.surfaceKey);
			currentRegistrations?.delete(generation);
			if (currentRegistrations?.size === 0) {
				state.surfaces.delete(options.surfaceKey);
			}
		},
	};
}
