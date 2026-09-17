import { PROVIDER_IDS } from "@/lib/agents/providers";
import { isRetryDirective } from "@/lib/hmux/failure/structuredTerminalAttachFailure";
import {
	requireRemoteHmuxAttachGeneration,
	resolveRemoteHmuxAttachFence,
} from "@/lib/hmux/remote/remoteHmuxAttachGeneration";
import { resolveRemoteHmuxStandaloneController } from "@/lib/hmux/remote/remoteHmuxControllerResolution";
import {
	type HmuxAgentIdentity,
	type HmuxAgentRuntimeState,
	type HmuxStructuredTerminalAccess,
	type HmuxStructuredTerminalAttachReceipt,
	type HmuxWorkingDirectory,
	hmux,
} from "@/lib/ipc";
import { TERMINAL_STATE_MAX_VIEWPORT_FRAME_PARTS } from "@/lib/terminal/protocol/terminalStateLimits";
import { hasTerminalStateEnvelopeMagic } from "@/lib/terminal/protocol/terminalStateProtocol";
import { createTerminalViewportMultipartAssembler } from "@/lib/terminal/protocol/terminalViewportMultipartAssembler";
import {
	isStructuredTerminalAttachmentRetired,
	StructuredTerminalAttachRetiredError,
} from "@/lib/terminal/structuredTerminalAttachPreparation";
import {
	type HmuxPaneBindingV1,
	isRemoteHmuxPaneBinding,
} from "@/lib/terminal/terminalBinding";
import type { SshHostConfig } from "@/types";
import { terminalInputLatency } from "./interaction/terminalInputLatency";
import { readTimedTerminalRecord } from "./qa/terminalDeliveryTiming";
import type {
	StructuredTerminalAdapterRecord,
	StructuredTerminalCarrierRecord,
} from "./structuredTerminalRecord";

export type { StructuredTerminalCarrierRecord } from "./structuredTerminalRecord";

export interface StructuredTerminalRecordAttachRequest {
	readonly observerId: string;
	readonly surfaceId: string;
	readonly access: HmuxStructuredTerminalAccess;
	readonly binding: HmuxPaneBindingV1;
	readonly sshHosts: readonly SshHostConfig[];
	readonly prepareAttach?: () => Promise<unknown>;
	/** Native attach API call, after adapter preparation and generation checks. */
	readonly onNativeAttachStarted?: () => void;
	/** Runs synchronously after the exact Hmux attach receipt is available. */
	readonly onAttachReceipt?: (
		receipt: HmuxStructuredTerminalAttachReceipt,
	) => void;
	/** A retained recovery attach must include one complete viewport frame in
	 * the Host's ordered initial-delivery batch. */
	readonly requireInitialViewportFrame?: boolean;
	readonly signal?: AbortSignal;
	readonly isCurrent?: () => boolean;
}

export const STRUCTURED_TERMINAL_INITIAL_DELIVERY_TIMEOUT_MS = 10_000;
const MAX_INITIAL_DELIVERY_RECORDS =
	TERMINAL_STATE_MAX_VIEWPORT_FRAME_PARTS + 2;

export class StructuredTerminalAttachInitialFrameError extends Error {
	readonly code = "structured_terminal_attach_missing_initial_frame";

	constructor() {
		super(
			"structured_terminal_attach_missing_initial_frame: attach receipt did not seed a complete viewport frame",
		);
		this.name = "StructuredTerminalAttachInitialFrameError";
	}
}

class StructuredTerminalAttachInitialDeliveryTimeoutError extends Error {
	readonly code = "structured_terminal_attach_initial_delivery_timeout";

	constructor(expectedRecordCount: number, observedRecordCount: number) {
		super(
			`structured_terminal_attach_initial_delivery_timeout: received ${observedRecordCount} of ${expectedRecordCount} initial delivery records`,
		);
		this.name = "StructuredTerminalAttachInitialDeliveryTimeoutError";
	}
}

export interface StructuredTerminalRecordAttachment
	extends HmuxStructuredTerminalAttachReceipt {
	/** Installs the typed receipt before exposing its ordered initial records. */
	startDelivery(): readonly StructuredTerminalCarrierRecord[];
	/** Pulls exactly one decoded transition. Multipart records remain contiguous. */
	readRecord(): Promise<StructuredTerminalCarrierRecord>;
}

/** Resolves only the carrier. Both carriers decode once into the same bounded,
 * typed terminal-state stream before attach delivery can begin. */
export async function attachStructuredTerminalRecords(
	request: StructuredTerminalRecordAttachRequest,
): Promise<StructuredTerminalRecordAttachment> {
	const prepareResult = await request.prepareAttach?.();
	if (isStructuredTerminalAttachmentRetired(prepareResult)) {
		throw new StructuredTerminalAttachRetiredError(prepareResult.reason);
	}
	requireCurrentAttachment(request);
	const decoder = createStructuredTerminalCarrierDecoder();
	let deliveryStarted = false;
	let receipt: HmuxStructuredTerminalAttachReceipt;
	if (!isRemoteHmuxPaneBinding(request.binding)) {
		request.onNativeAttachStarted?.();
		receipt = await hmux.attachStructuredTerminal({
			observerId: request.observerId,
			surfaceId: request.surfaceId,
			sessionId: request.binding.sessionId,
			workspaceId: request.binding.workspaceId,
			access: request.access,
		});
	} else {
		const remote = await resolveRemoteHmuxStandaloneController(
			request.sshHosts,
			request.binding,
		);
		requireCurrentAttachment(request);
		const expectedFence = resolveRemoteHmuxAttachFence(
			prepareResult,
			request.binding.runtime === "hmux_managed_v1"
				? request.binding.stopFence
				: undefined,
		);
		requireRemoteHmuxAttachGeneration(remote.session, expectedFence);
		request.onNativeAttachStarted?.();
		receipt = await hmux.attachRemoteStructuredTerminal({
			observerId: request.observerId,
			surfaceId: request.surfaceId,
			access: request.access,
			target: remote.target,
			session: remote.session,
		});
	}
	// An earlier cancellation can reach native before its attach reservation.
	// Confirm retirement again after that invocation settles, before departure.
	if (request.signal?.aborted || request.isCurrent?.() === false) {
		await hmux.detachStructuredTerminal(request.observerId);
	}
	requireCurrentAttachment(request);
	request.onAttachReceipt?.(receipt);
	const initialDeliveryRecordCount = receipt.initialDeliveryRecordCount;
	if (
		!Number.isSafeInteger(initialDeliveryRecordCount) ||
		initialDeliveryRecordCount < 0 ||
		initialDeliveryRecordCount > MAX_INITIAL_DELIVERY_RECORDS
	) {
		throw new Error(
			"structured_terminal_attach_initial_delivery_count_invalid",
		);
	}
	const initialRecords: StructuredTerminalCarrierRecord[] = [];
	const initialDeadline =
		Date.now() + STRUCTURED_TERMINAL_INITIAL_DELIVERY_TIMEOUT_MS;
	for (let index = 0; index < initialDeliveryRecordCount; index += 1) {
		const raw = await pullStructuredTerminalRecord(
			request,
			Math.max(0, initialDeadline - Date.now()),
			initialDeliveryRecordCount,
			index,
		);
		const decoded = decoder.push(raw);
		if (decoded) initialRecords.push(decoded);
	}
	requireCurrentAttachment(request);
	return {
		...receipt,
		startDelivery: () => {
			if (deliveryStarted) return [];
			requireCurrentAttachment(request);
			const pending = initialRecords.splice(0, initialRecords.length);
			deliveryStarted = true;
			if (
				request.requireInitialViewportFrame &&
				!pending.some(isTerminalAttachFailureRecord) &&
				!pending.some(
					(record) =>
						record.kind === "terminal" &&
						record.decoded.record.body.case === "viewportFrame",
				)
			) {
				throw new StructuredTerminalAttachInitialFrameError();
			}
			return pending;
		},
		readRecord: async () => {
			if (!deliveryStarted) {
				throw new Error("structured_terminal_delivery_not_started");
			}
			if (import.meta.env.MODE === "perf") {
				return readTimedTerminalRecord({
					pull: (onResolved) =>
						pullStructuredTerminalRecord(request, undefined, 0, 0, onResolved),
					decode: (raw) => decoder.push(raw),
					sampleSequence: () =>
						terminalInputLatency.deliverySampleSequence(request.surfaceId),
					now: () => performance.now(),
				});
			}
			for (;;) {
				const decoded = decoder.push(
					await pullStructuredTerminalRecord(request),
				);
				if (decoded) return decoded;
			}
		},
	};
}

async function pullStructuredTerminalRecord(
	request: StructuredTerminalRecordAttachRequest,
	timeoutMs?: number,
	expectedInitialRecords = 0,
	observedInitialRecords = 0,
	onResolved?: () => void,
): Promise<ArrayBuffer> {
	requireCurrentAttachment(request);
	return new Promise<ArrayBuffer>((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = (record?: ArrayBuffer, cause?: unknown) => {
			if (settled) return;
			settled = true;
			if (timeout !== undefined) clearTimeout(timeout);
			request.signal?.removeEventListener("abort", onAbort);
			if (cause !== undefined) reject(cause);
			else if (record !== undefined) resolve(record);
		};
		const onAbort = () =>
			finish(undefined, new StructuredTerminalAttachRetiredError());
		if (request.signal?.aborted || request.isCurrent?.() === false) {
			onAbort();
			return;
		}
		request.signal?.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs !== undefined) {
			timeout = setTimeout(
				() =>
					finish(
						undefined,
						new StructuredTerminalAttachInitialDeliveryTimeoutError(
							expectedInitialRecords,
							observedInitialRecords,
						),
					),
				timeoutMs,
			);
		}
		void hmux.nextStructuredTerminalRecord(request.observerId).then(
			(record) => {
				if (import.meta.env.MODE === "perf" && !settled) onResolved?.();
				finish(record);
			},
			(cause) => finish(undefined, cause),
		);
	});
}

function isTerminalAttachFailureRecord(
	record: StructuredTerminalCarrierRecord,
): boolean {
	return (
		record.kind === "failure" ||
		(record.kind === "adapter" &&
			(record.record.kind === "closed" ||
				(record.record.kind === "control" &&
					(record.record.body?.kind === "error" ||
						record.record.body?.kind === "exit"))))
	);
}

function createStructuredTerminalCarrierDecoder(): {
	push(record: ArrayBuffer): StructuredTerminalCarrierRecord | undefined;
} {
	const multipart = createTerminalViewportMultipartAssembler();
	const textDecoder = new TextDecoder();
	return {
		push(record) {
			const bytes = new Uint8Array(record);
			if (hasTerminalStateEnvelopeMagic(bytes)) {
				const assembly = multipart.push(bytes);
				if (assembly.status === "pending") return undefined;
				if (assembly.status === "resync_required") {
					return {
						kind: "failure",
						reason: assembly.reason,
						encodedByteLength: 0,
					};
				}
				return {
					kind: "terminal",
					decoded: assembly.decoded,
					encodedByteLength: record.byteLength,
				};
			}
			if (multipart.discardIncomplete()) {
				return {
					kind: "failure",
					reason:
						"viewport frame batch was interrupted by a control record",
					encodedByteLength: 0,
				};
			}
			try {
				return {
					kind: "adapter",
					record: validateAdapterRecord(
						JSON.parse(textDecoder.decode(bytes)),
					),
					encodedByteLength: record.byteLength,
				};
			} catch {
				return {
					kind: "failure",
					reason:
						"structured terminal adapter sent an invalid control record",
					encodedByteLength: 0,
				};
			}
		},
	};
}

function validateAdapterRecord(
	value: unknown,
): StructuredTerminalAdapterRecord {
	if (!isObject(value) || typeof value.kind !== "string") {
		throw new Error("adapter record kind is missing");
	}
	if (value.kind === "agent_identity") {
		return {
			kind: "agent_identity",
			identity: validateAgentIdentity(value.identity),
		};
	}
	if (value.kind === "agent_runtime_state") {
		return {
			kind: "agent_runtime_state",
			state: validateAgentRuntimeState(value.state),
		};
	}
	if (value.kind === "working_directory") {
		return {
			kind: "working_directory",
			workingDirectory: validateWorkingDirectory(value.workingDirectory),
		};
	}
	if (value.kind === "provider_conversation_identity") {
		if (!isObject(value.identity)) throw new Error("identity is missing");
		for (const field of [
			"sessionId",
			"workspaceId",
			"runnerPrincipal",
			"runnerInstance",
			"channelEpoch",
			"hostInstanceId",
			"terminalEpoch",
			"revision",
			"observedThroughOutputSeq",
			"providerId",
			"conversationId",
		]) {
			if (typeof value.identity[field] !== "string" || !value.identity[field]) {
				throw new Error(`identity ${field} is invalid`);
			}
		}
		if (
			value.identity.source !== "launch_request" &&
			value.identity.source !== "provider_event"
		) {
			throw new Error("identity source is invalid");
		}
		return value as StructuredTerminalAdapterRecord;
	}
	if (value.kind === "closed") {
		if (typeof value.code !== "string" || !value.code) {
			throw new Error("closed code is invalid");
		}
		if (typeof value.message !== "string" || !value.message) {
			throw new Error("closed message is invalid");
		}
		// Required, not defaulted: a missing posture means the adapter and this
		// bundle disagree, and guessing "permanent" would hide that behind a
		// plausible-looking pane error.
		if (!isRetryDirective(value.retryDirective)) {
			throw new Error("closed retry directive is invalid");
		}
		return value as StructuredTerminalAdapterRecord;
	}
	if (value.kind === "control") {
		if (!isObject(value.body)) throw new Error("control body is invalid");
		if (typeof value.body.kind !== "string" || !value.body.kind) {
			throw new Error("control kind is invalid");
		}
		if (
			value.body.message !== undefined &&
			typeof value.body.message !== "string"
		) {
			throw new Error("control message is invalid");
		}
		return value as StructuredTerminalAdapterRecord;
	}
	throw new Error("adapter record kind is unsupported");
}

const DECIMAL_U64 = /^(?:0|[1-9]\d*)$/;
const NONZERO_DECIMAL_U64 = /^[1-9]\d*$/;

function validateAgentIdentity(value: unknown): HmuxAgentIdentity {
	if (!isObject(value)) throw new Error("agent identity is missing");
	if (typeof value.terminalEpoch !== "string" || !value.terminalEpoch) {
		throw new Error("agent identity terminal epoch is invalid");
	}
	if (
		typeof value.observedThroughOutputSeq !== "string" ||
		!DECIMAL_U64.test(value.observedThroughOutputSeq)
	) {
		throw new Error("agent identity output sequence is invalid");
	}
	const agent =
		value.agent === null
			? null
			: PROVIDER_IDS.find((provider) => provider === value.agent);
	if (agent === undefined) {
		throw new Error("agent identity provider is invalid");
	}
	if (value.source !== "process_inspection") {
		throw new Error("agent identity source is invalid");
	}
	return {
		terminalEpoch: value.terminalEpoch,
		observedThroughOutputSeq: value.observedThroughOutputSeq,
		agent,
		source: value.source,
	};
}

function validateWorkingDirectory(value: unknown): HmuxWorkingDirectory {
	if (!isObject(value)) throw new Error("working directory is missing");
	if (typeof value.terminalEpoch !== "string" || !value.terminalEpoch) {
		throw new Error("working directory terminal epoch is invalid");
	}
	if (
		typeof value.observedThroughOutputSeq !== "string" ||
		!DECIMAL_U64.test(value.observedThroughOutputSeq)
	) {
		throw new Error("working directory output sequence is invalid");
	}
	if (typeof value.path !== "string" || !value.path) {
		throw new Error("working directory path is invalid");
	}
	if (
		value.source !== "launch_fallback" &&
		value.source !== "osc7" &&
		value.source !== "process_inspection"
	) {
		throw new Error("working directory source is invalid");
	}
	return {
		terminalEpoch: value.terminalEpoch,
		observedThroughOutputSeq: value.observedThroughOutputSeq,
		path: value.path,
		source: value.source,
	};
}

function validateAgentRuntimeState(value: unknown): HmuxAgentRuntimeState {
	if (!isObject(value)) throw new Error("agent runtime state is missing");
	if (typeof value.terminalEpoch !== "string" || !value.terminalEpoch) {
		throw new Error("agent runtime terminal epoch is invalid");
	}
	if (
		typeof value.revision !== "string" ||
		!NONZERO_DECIMAL_U64.test(value.revision)
	) {
		throw new Error("agent runtime revision is invalid");
	}
	if (
		typeof value.observedThroughOutputSeq !== "string" ||
		!DECIMAL_U64.test(value.observedThroughOutputSeq)
	) {
		throw new Error("agent runtime output sequence is invalid");
	}
	if (
		value.lifecycle !== "starting" &&
		value.lifecycle !== "running" &&
		value.lifecycle !== "exited"
	) {
		throw new Error("agent runtime lifecycle is invalid");
	}
	if (value.activity !== "working" && value.activity !== "waiting") {
		throw new Error("agent runtime activity is invalid");
	}
	if (
		value.attention !== "none" &&
		value.attention !== "input_required" &&
		value.attention !== "approval_required" &&
		value.attention !== "error"
	) {
		throw new Error("agent runtime attention is invalid");
	}
	if (
		value.source !== "provider_event" &&
		value.source !== "orchestration_event" &&
		value.source !== "controller_input" &&
		value.source !== "process_lifecycle"
	) {
		throw new Error("agent runtime source is invalid");
	}
	if (
		value.turnCompletedCount !== undefined &&
		(typeof value.turnCompletedCount !== "string" ||
			!DECIMAL_U64.test(value.turnCompletedCount))
	) {
		throw new Error("agent runtime completion count is invalid");
	}
	if (value.attention === "none") {
		if (value.attentionId !== undefined && value.attentionId !== null) {
			throw new Error("agent runtime none attention has an id");
		}
	} else if (
		value.activity !== "waiting" ||
		typeof value.attentionId !== "string" ||
		!value.attentionId
	) {
		throw new Error("agent runtime attention episode is invalid");
	}
	if (
		value.lifecycle === "exited" &&
		(value.activity !== "waiting" || value.attention !== "none")
	) {
		throw new Error("agent runtime exited state is invalid");
	}
	return {
		terminalEpoch: value.terminalEpoch,
		revision: value.revision,
		observedThroughOutputSeq: value.observedThroughOutputSeq,
		lifecycle: value.lifecycle,
		activity: value.activity,
		attention: value.attention,
		...(typeof value.attentionId === "string"
			? { attentionId: value.attentionId }
			: {}),
		source: value.source,
		...(typeof value.turnCompletedCount === "string"
			? { turnCompletedCount: value.turnCompletedCount }
			: {}),
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requireCurrentAttachment(
	request: StructuredTerminalRecordAttachRequest,
): void {
	if (request.signal?.aborted || request.isCurrent?.() === false) {
		throw new StructuredTerminalAttachRetiredError();
	}
}

export function structuredTerminalAttachmentKey(
	binding: HmuxPaneBindingV1,
): string {
	const stopFence =
		"stopFence" in binding && binding.stopFence
			? [
					binding.stopFence.runnerPrincipal,
					binding.stopFence.runnerInstance,
					binding.stopFence.channelEpoch,
					binding.stopFence.hostInstanceId,
					binding.stopFence.terminalEpoch,
				].join("\u001f")
			: "";
	return [
		binding.schemaVersion,
		binding.runtime,
		binding.source,
		binding.hostId,
		binding.sessionId,
		"workspaceId" in binding ? binding.workspaceId : "",
		"commandBridgeNonce" in binding ? binding.commandBridgeNonce : "",
		stopFence,
	].join("\u001e");
}
