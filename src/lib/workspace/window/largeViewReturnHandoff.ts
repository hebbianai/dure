import { emitTo } from "@tauri-apps/api/event";
import { nonEmptyString } from "@/lib/payloadGuards";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import {
	SECONDARY_WINDOW_CLOSE_TIMEOUT_MS,
	withSecondaryWindowTimeout,
} from "./secondaryWindowOperation";

const LARGE_VIEW_RETURN_PREPARE_EVENT = "dure://large-view-return/prepare";
const LARGE_VIEW_RETURN_READY_EVENT = "dure://large-view-return/ready";
const LARGE_VIEW_RETURN_RETIRED_EVENT = "dure://large-view-return/retired";
const LARGE_VIEW_RETURN_PREPARE_TIMEOUT_MS = SECONDARY_WINDOW_CLOSE_TIMEOUT_MS;

export interface LargeViewReturnIdentity {
	workspaceId: string;
	sessionId: string;
	sourcePaneOwnerId?: string;
}

interface LargeViewReturnPreparePayload extends LargeViewReturnIdentity {
	generation: string;
	replyWindowLabel: string;
	expiresAtMs: number;
}

export interface LargeViewReturnPreparationRequest
	extends LargeViewReturnIdentity {
	generation: string;
	expiresAtMs: number;
}

export type LargeViewReturnPreparationResult = boolean | (() => void);

interface LargeViewReturnReadyPayload extends LargeViewReturnIdentity {
	generation: string;
}

export interface LargeViewReturnRetirementRequest
	extends LargeViewReturnIdentity {
	generation: string;
}

export interface LargeViewReturnRequestBackend {
	listenReady(listener: (payload: unknown) => void): Promise<() => void>;
	emitPrepare(
		targetWindowLabel: string,
		payload: LargeViewReturnPreparePayload,
	): Promise<void>;
}

export interface LargeViewReturnLifecycleRequestBackend
	extends LargeViewReturnRequestBackend {
	emitRetired(
		targetWindowLabel: string,
		payload: LargeViewReturnRetirementRequest,
	): Promise<void>;
}

export interface LargeViewReturnSourceBackend {
	listenPrepare(listener: (payload: unknown) => void): Promise<() => void>;
	emitReady(
		windowLabel: string,
		payload: LargeViewReturnReadyPayload,
	): Promise<void>;
}

export interface LargeViewReturnLifecycleSourceBackend
	extends LargeViewReturnSourceBackend {
	listenRetired(listener: (payload: unknown) => void): Promise<() => void>;
}

const requestBackend: LargeViewReturnLifecycleRequestBackend = {
	listenReady: (listener) =>
		listenWhenReady<unknown>(LARGE_VIEW_RETURN_READY_EVENT, (event) =>
			listener(event.payload),
		),
	emitPrepare: (targetWindowLabel, payload) =>
		emitTo(
			{ kind: "WebviewWindow", label: targetWindowLabel },
			LARGE_VIEW_RETURN_PREPARE_EVENT,
			payload,
		),
	emitRetired: (targetWindowLabel, payload) =>
		emitTo(
			{ kind: "WebviewWindow", label: targetWindowLabel },
			LARGE_VIEW_RETURN_RETIRED_EVENT,
			payload,
		),
};

const sourceBackend: LargeViewReturnLifecycleSourceBackend = {
	listenPrepare: (listener) =>
		listenWhenReady<unknown>(LARGE_VIEW_RETURN_PREPARE_EVENT, (event) =>
			listener(event.payload),
		),
	emitReady: (windowLabel, payload) =>
		emitTo(
			{ kind: "WebviewWindow", label: windowLabel },
			LARGE_VIEW_RETURN_READY_EVENT,
			payload,
		),
	listenRetired: (listener) =>
		listenWhenReady<unknown>(LARGE_VIEW_RETURN_RETIRED_EVENT, (event) =>
			listener(event.payload),
		),
};

function parsePreparePayload(
	value: unknown,
): LargeViewReturnPreparePayload | undefined {
	if (!value || typeof value !== "object") return undefined;
	const payload = value as Record<string, unknown>;
	if (
		!nonEmptyString(payload.workspaceId) ||
		!nonEmptyString(payload.sessionId) ||
		!nonEmptyString(payload.generation) ||
		!nonEmptyString(payload.replyWindowLabel) ||
		typeof payload.expiresAtMs !== "number" ||
		!Number.isFinite(payload.expiresAtMs) ||
		("sourcePaneOwnerId" in payload &&
			!nonEmptyString(payload.sourcePaneOwnerId))
	) {
		return undefined;
	}
	return {
		workspaceId: payload.workspaceId,
		sessionId: payload.sessionId,
		generation: payload.generation,
		replyWindowLabel: payload.replyWindowLabel,
		expiresAtMs: payload.expiresAtMs,
		...(nonEmptyString(payload.sourcePaneOwnerId)
			? { sourcePaneOwnerId: payload.sourcePaneOwnerId }
			: {}),
	};
}

function parseReadyPayload(
	value: unknown,
): LargeViewReturnReadyPayload | undefined {
	if (!value || typeof value !== "object") return undefined;
	const payload = value as Record<string, unknown>;
	if (
		!nonEmptyString(payload.workspaceId) ||
		!nonEmptyString(payload.sessionId) ||
		!nonEmptyString(payload.generation) ||
		("sourcePaneOwnerId" in payload &&
			!nonEmptyString(payload.sourcePaneOwnerId))
	) {
		return undefined;
	}
	return {
		workspaceId: payload.workspaceId,
		sessionId: payload.sessionId,
		generation: payload.generation,
		...(nonEmptyString(payload.sourcePaneOwnerId)
			? { sourcePaneOwnerId: payload.sourcePaneOwnerId }
			: {}),
	};
}

function sameSession(
	left: LargeViewReturnIdentity,
	right: LargeViewReturnIdentity,
): boolean {
	return (
		left.workspaceId === right.workspaceId && left.sessionId === right.sessionId
	);
}

function sameRequestIdentity(
	left: LargeViewReturnIdentity,
	right: LargeViewReturnIdentity,
): boolean {
	return (
		sameSession(left, right) &&
		left.sourcePaneOwnerId === right.sourcePaneOwnerId
	);
}

function matchesSourcePane(
	subscriber: LargeViewReturnIdentity,
	request: LargeViewReturnIdentity,
): boolean {
	return (
		sameSession(subscriber, request) &&
		(request.sourcePaneOwnerId === undefined ||
			subscriber.sourcePaneOwnerId === request.sourcePaneOwnerId)
	);
}

function createGeneration(): string {
	return (
		globalThis.crypto?.randomUUID?.() ??
		`return-${Date.now()}-${Math.random().toString(16).slice(2)}`
	);
}

async function requestLargeViewReturnGeneration(
	identity: LargeViewReturnIdentity,
	replyWindowLabel: string,
	targetWindowLabel: string,
	backend: LargeViewReturnRequestBackend = requestBackend,
	timeoutMs = LARGE_VIEW_RETURN_PREPARE_TIMEOUT_MS,
): Promise<string | undefined> {
	const generation = createGeneration();
	const expiresAtMs = Date.now() + timeoutMs;
	let disposed = false;
	let stop: (() => void) | undefined;
	let acknowledge: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => {
		acknowledge = resolve;
	});
	const setup = backend
		.listenReady((candidate) => {
			const payload = parseReadyPayload(candidate);
			if (
				payload?.generation === generation &&
				sameRequestIdentity(identity, payload)
			) {
				acknowledge?.();
			}
		})
		.then(async (unlisten) => {
			if (disposed) {
				unlisten();
				return;
			}
			stop = unlisten;
			await backend.emitPrepare(targetWindowLabel, {
				...identity,
				generation,
				replyWindowLabel,
				expiresAtMs,
			});
		});
	try {
		await withSecondaryWindowTimeout(
			"large view return preparation",
			setup.then(() => ready),
			timeoutMs,
		);
		return generation;
	} catch {
		return undefined;
	} finally {
		disposed = true;
		const installedStop = stop;
		stop = undefined;
		installedStop?.();
		void setup
			.then(() => {
				const lateStop = stop;
				stop = undefined;
				lateStop?.();
			})
			.catch(() => {});
	}
}

/** Waits until the exact source terminal has concealed itself before reveal. */
export async function prepareLargeViewReturnToWindow(
	identity: LargeViewReturnIdentity,
	replyWindowLabel: string,
	targetWindowLabel: string,
	backend: LargeViewReturnRequestBackend = requestBackend,
	timeoutMs = LARGE_VIEW_RETURN_PREPARE_TIMEOUT_MS,
): Promise<boolean> {
	return (
		(await requestLargeViewReturnGeneration(
			identity,
			replyWindowLabel,
			targetWindowLabel,
			backend,
			timeoutMs,
		)) !== undefined
	);
}

export interface PreparedLargeViewReturn {
	readonly generation: string;
	markLargeSurfaceRetired(): Promise<void>;
}

/**
 * Prepares the exact source and retains the generation needed to prove that
 * the large structured surface was retired before the source can reveal.
 */
export async function beginLargeViewReturnToWindow(
	identity: LargeViewReturnIdentity,
	replyWindowLabel: string,
	targetWindowLabel: string,
	backend: LargeViewReturnLifecycleRequestBackend = requestBackend,
	timeoutMs = LARGE_VIEW_RETURN_PREPARE_TIMEOUT_MS,
): Promise<PreparedLargeViewReturn | undefined> {
	const generation = await requestLargeViewReturnGeneration(
		identity,
		replyWindowLabel,
		targetWindowLabel,
		backend,
		timeoutMs,
	);
	if (!generation) return undefined;
	return {
		generation,
		markLargeSurfaceRetired: () =>
			backend.emitRetired(targetWindowLabel, {
				...identity,
				generation,
			}),
	};
}

/** Backward-compatible main-window return used by older secondary surfaces. */
export function prepareLargeViewReturn(
	identity: LargeViewReturnIdentity,
	replyWindowLabel: string,
	backend: LargeViewReturnRequestBackend = requestBackend,
	timeoutMs = LARGE_VIEW_RETURN_PREPARE_TIMEOUT_MS,
): Promise<boolean> {
	return prepareLargeViewReturnToWindow(
		identity,
		replyWindowLabel,
		"main",
		backend,
		timeoutMs,
	);
}

function acknowledgePreparedSource(
	payload: LargeViewReturnPreparePayload,
	prepared: LargeViewReturnPreparationResult,
	backend: LargeViewReturnSourceBackend,
	now: () => number,
): void {
	if (!prepared) return;
	const rollback = typeof prepared === "function" ? prepared : undefined;
	if (payload.expiresAtMs <= now()) {
		rollback?.();
		return;
	}
	void backend
		.emitReady(payload.replyWindowLabel, {
			workspaceId: payload.workspaceId,
			sessionId: payload.sessionId,
			generation: payload.generation,
			...(payload.sourcePaneOwnerId
				? { sourcePaneOwnerId: payload.sourcePaneOwnerId }
				: {}),
		})
		.catch(() => rollback?.());
}

/** Installs one window-level source listener and owns acknowledgement delivery. */
function subscribeLargeViewReturnPreparationRequests(
	prepare: (
		request: LargeViewReturnPreparationRequest,
	) =>
		| LargeViewReturnPreparationResult
		| Promise<LargeViewReturnPreparationResult>,
	backend: LargeViewReturnSourceBackend = sourceBackend,
	now: () => number = Date.now,
): () => void {
	let disposed = false;
	let stop: (() => void) | undefined;
	void backend
		.listenPrepare((candidate) => {
			const payload = parsePreparePayload(candidate);
			if (!payload) return;
			if (payload.expiresAtMs <= now()) return;
			const request: LargeViewReturnPreparationRequest = {
				workspaceId: payload.workspaceId,
				sessionId: payload.sessionId,
				generation: payload.generation,
				expiresAtMs: payload.expiresAtMs,
				...(payload.sourcePaneOwnerId
					? { sourcePaneOwnerId: payload.sourcePaneOwnerId }
					: {}),
			};
			try {
				const prepared = prepare(request);
				if (prepared instanceof Promise) {
					void prepared
						.then((result) =>
							acknowledgePreparedSource(payload, result, backend, now),
						)
						.catch(() => {});
				} else {
					acknowledgePreparedSource(payload, prepared, backend, now);
				}
			} catch {
				// A failed source preparation must not acknowledge the return.
			}
		})
		.then((unlisten) => {
			if (disposed) unlisten();
			else stop = unlisten;
		})
		.catch(() => {});
	return () => {
		disposed = true;
		stop?.();
	};
}

/** Owns both source preparation and the exact post-detach generation signal. */
export function subscribeLargeViewReturnLifecycleRequests(
	handlers: {
		prepare(
			request: LargeViewReturnPreparationRequest,
		):
			| LargeViewReturnPreparationResult
			| Promise<LargeViewReturnPreparationResult>;
		retired(request: LargeViewReturnRetirementRequest): void;
	},
	backend: LargeViewReturnLifecycleSourceBackend = sourceBackend,
	now: () => number = Date.now,
): () => void {
	let disposed = false;
	let stopPrepare: (() => void) | undefined;
	let stopRetired: (() => void) | undefined;
	void backend
		.listenRetired((candidate) => {
			const payload = parseReadyPayload(candidate);
			if (payload) handlers.retired(payload);
		})
		.then((unlisten) => {
			if (disposed) {
				unlisten();
				return;
			}
			stopRetired = unlisten;
			stopPrepare = subscribeLargeViewReturnPreparationRequests(
				handlers.prepare,
				backend,
				now,
			);
		})
		.catch(() => {});
	return () => {
		disposed = true;
		stopPrepare?.();
		stopRetired?.();
	};
}

/** Installs one source-side listener and acknowledges only an eligible pane. */
export function subscribeLargeViewReturnPreparation(
	identity: LargeViewReturnIdentity,
	prepare: (generation: string) => LargeViewReturnPreparationResult,
	backend: LargeViewReturnSourceBackend = sourceBackend,
	now: () => number = Date.now,
): () => void {
	return subscribeLargeViewReturnPreparationRequests(
		(request) =>
			matchesSourcePane(identity, request)
				? prepare(request.generation)
				: false,
		backend,
		now,
	);
}
