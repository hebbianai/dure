import { createHash, randomUUID } from "node:crypto";

const DEFAULT_REPLAY_MAX_EVENTS = 512;
const DEFAULT_REPLAY_MAX_BYTES = 2 * 1024 * 1024;
const REPLAY_PAGE_MAX_EVENTS = 128;
const REPLAY_PAGE_MAX_BYTES = 128 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_INTERACTION_SNAPSHOT_BYTES = 224 * 1024;
const MAX_PENDING_INTERACTIONS_PER_QUERY = 12;
const MAX_QUERY_RECORDS = 128;
const MAX_RETIRED_IDENTITIES = 128;
const MAX_UNCOMMITTED_TURN_RECEIPTS = 128;
const MAX_HISTORY_ITEMS = 2_048;
// The shared turn-failure vocabulary (dure_app::AgentTurnFailureReasonV1).
const TURN_FAILURE_REASONS = new Set([
	"usage_limit",
	"rate_limit",
	"authentication_failed",
	"context_window_exceeded",
	"provider_error",
]);

function turnFailureReasonToken(error) {
	const reason = error && typeof error === "object" ? error.reason : undefined;
	return typeof reason === "string" && TURN_FAILURE_REASONS.has(reason)
		? reason
		: null;
}
const MAX_HISTORY_ITEM_BYTES = 128 * 1024;
const MAX_HISTORY_PAGE_ITEMS = 64;
const MAX_HISTORY_PAGE_BYTES = 192 * 1024;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_LAUNCH_SELECTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function hostContractError(reason) {
	const error = new Error(`dure_claude_sdk_host_${reason}`);
	error.code = "DURE_CLAUDE_SDK_HOST_CONTRACT";
	return error;
}

function token(value, label) {
	if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
		throw hostContractError(`${label}_invalid`);
	}
	return value;
}

function optionalLaunchSelection(value, label) {
	if (value === undefined) return null;
	if (typeof value !== "string" || !SAFE_LAUNCH_SELECTION.test(value)) {
		throw hostContractError(`${label}_invalid`);
	}
	return value;
}

function effortSelection(value) {
	// The provider CLI owns which efforts exist (its catalog changes with the
	// runtime); the host only fences the token shape.
	if (value === undefined) return null;
	if (typeof value !== "string" || !SAFE_LAUNCH_SELECTION.test(value)) {
		throw hostContractError("effort_invalid");
	}
	return value;
}

function permissionMode(value) {
	if (value === undefined) return "default";
	if (value !== "default" && value !== "auto_edit" && value !== "skip_permissions") {
		throw hostContractError("permission_mode_invalid");
	}
	return value;
}

function queryIdentity(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw hostContractError("identity_invalid");
	}
	return Object.freeze({
		runtimeGeneration: token(value.runtimeGeneration, "runtime_generation"),
		queryEpoch: token(value.queryEpoch, "query_epoch"),
		relayId: token(value.relayId, "relay_id"),
	});
}

function sameIdentity(left, right) {
	return (
		left.runtimeGeneration === right.runtimeGeneration &&
		left.queryEpoch === right.queryEpoch &&
		left.relayId === right.relayId
	);
}

function requireDistinctRetirementTarget(source, target) {
	if (
		target !== null &&
		(source.runtimeGeneration === target.runtimeGeneration ||
			source.queryEpoch === target.queryEpoch ||
			source.relayId === target.relayId)
	) {
		throw hostContractError("retirement_authority_invalid");
	}
}

function hostIdentity(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw hostContractError("host_identity_invalid");
	}
	return Object.freeze({
		hostGeneration: token(value.hostGeneration, "host_generation"),
		hostInstanceId: token(value.hostInstanceId, "host_instance_id"),
	});
}

function sameHostIdentity(left, right) {
	return (
		left.hostGeneration === right.hostGeneration &&
		left.hostInstanceId === right.hostInstanceId
	);
}

function providerRetirementAuthority(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw hostContractError("retirement_authority_invalid");
	}
	const source = queryIdentity(value.source);
	const allowedTarget = value.allowedTarget === null ? null : queryIdentity(value.allowedTarget);
	requireDistinctRetirementTarget(source, allowedTarget);
	const sourceHost = hostIdentity(value.sourceHost);
	const targetHost = value.targetHost === null ? null : hostIdentity(value.targetHost);
	if (
		!new Set(["retired", "target_bound", "released"]).has(value.phase) ||
		(value.phase === "retired" && targetHost !== null) ||
		(value.phase === "target_bound" && (allowedTarget === null || targetHost === null)) ||
		(value.phase === "released" && allowedTarget === null && targetHost !== null)
	) {
		throw hostContractError("retirement_authority_invalid");
	}
	return Object.freeze({
		allowedTarget,
		phase: value.phase,
		source,
		sourceHost,
		targetHost,
	});
}

function sameRetirementAuthority(left, right) {
	return (
		left.phase === right.phase &&
		sameIdentity(left.source, right.source) &&
		(left.allowedTarget === null) === (right.allowedTarget === null) &&
		(left.allowedTarget === null || sameIdentity(left.allowedTarget, right.allowedTarget)) &&
		sameHostIdentity(left.sourceHost, right.sourceHost) &&
		(left.targetHost === null) === (right.targetHost === null) &&
		(left.targetHost === null || sameHostIdentity(left.targetHost, right.targetHost))
	);
}

function sameRetirementSource(left, right) {
	return (
		left.phase === "retired" &&
		right.phase === "retired" &&
		sameIdentity(left.source, right.source) &&
		sameHostIdentity(left.sourceHost, right.sourceHost)
	);
}

function sameRetirementLineage(left, right) {
	return (
		sameIdentity(left.source, right.source) &&
		(left.allowedTarget === null) === (right.allowedTarget === null) &&
		(left.allowedTarget === null || sameIdentity(left.allowedTarget, right.allowedTarget)) &&
		sameHostIdentity(left.sourceHost, right.sourceHost)
	);
}

function retiredAuthority(source, allowedTarget, sourceHost) {
	requireDistinctRetirementTarget(source, allowedTarget);
	return Object.freeze({
		allowedTarget,
		phase: "retired",
		source,
		sourceHost,
		targetHost: null,
	});
}

function boundAuthority(authority, targetHost) {
	return Object.freeze({
		...authority,
		phase: "target_bound",
		targetHost,
	});
}

function releasedAuthority(authority) {
	return Object.freeze({ ...authority, phase: "released" });
}

function sameBinding(left, right) {
	return (
		sameIdentity(left.identity, right.identity) &&
		left.cwd === right.cwd &&
		left.instructions === right.instructions &&
		left.effort === right.effort &&
		left.model === right.model &&
		left.permissionMode === right.permissionMode &&
		left.providerSessionId === right.providerSessionId &&
		JSON.stringify(left.env) === JSON.stringify(right.env) &&
		JSON.stringify(left.process) === JSON.stringify(right.process)
	);
}

function sameBindingOrUnestablishedReplay(authoritative, requested) {
	return (
		sameBinding(authoritative, requested) ||
		(authoritative.providerSessionId !== null &&
			requested.providerSessionId === null &&
			sameBinding(authoritative, {
				...requested,
				providerSessionId: authoritative.providerSessionId,
			}))
	);
}

function projectProviderSessionBinding(record, rawPayload, replacementFence) {
	if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
		throw hostContractError("provider_session_identity_invalid");
	}
	const providerSessionId = token(
		rawPayload.providerSessionId,
		"provider_session_id",
	);
	if (record.binding.providerSessionId === providerSessionId) return;
	if (record.binding.providerSessionId !== null) {
		throw hostContractError("provider_session_identity_conflict");
	}
	const previous = record.binding;
	record.binding = Object.freeze({ ...previous, providerSessionId });
	if (replacementFence && replacementFence.targetBinding !== null) {
		if (!sameBinding(replacementFence.targetBinding, previous)) {
			throw hostContractError("replacement_authority_conflict");
		}
		replacementFence.targetBinding = record.binding;
	}
}

function queryBinding(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw hostContractError("binding_invalid");
	}
	const identity = queryIdentity(value.identity);
	if (value.instructions !== undefined && typeof value.instructions !== "string") {
		throw hostContractError("instructions_invalid");
	}
	if (typeof value.cwd !== "string" || !value.cwd.startsWith("/") || value.cwd.includes("\0")) {
		throw hostContractError("cwd_invalid");
	}
	if (!value.env || typeof value.env !== "object" || Array.isArray(value.env)) {
		throw hostContractError("environment_invalid");
	}
	const env = Object.create(null);
	for (const [key, entry] of Object.entries(value.env)) {
		if (
			!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
			typeof entry !== "string" ||
			entry.includes("\0")
		) {
			throw hostContractError("environment_invalid");
		}
		env[key] = entry;
	}
	let processBinding = null;
	if (value.process !== undefined) {
		if (!value.process || typeof value.process !== "object" || Array.isArray(value.process)) {
			throw hostContractError("process_binding_invalid");
		}
		const { command, args, relayEndpoint, relayCapability } = value.process;
		if (
			typeof relayEndpoint !== "string" ||
			!relayEndpoint.startsWith("/") ||
			relayEndpoint.includes("\0") ||
			typeof relayCapability !== "string" ||
			relayCapability.length < 16 ||
			relayCapability.length > 256 ||
			/[\u0000-\u001f\u007f]/u.test(relayCapability)
		) {
			throw hostContractError("process_binding_invalid");
		}
		const fixtureLaunchPresent = command !== undefined || args !== undefined;
		if (
			fixtureLaunchPresent &&
			(typeof command !== "string" ||
				!command.startsWith("/") ||
				command.includes("\0") ||
				!Array.isArray(args) ||
				args.some((entry) => typeof entry !== "string" || entry.includes("\0")))
		) {
			throw hostContractError("process_binding_invalid");
		}
		processBinding = Object.freeze({
			...(fixtureLaunchPresent
				? { args: Object.freeze([...args]), command }
				: {}),
			relayCapability,
			relayEndpoint,
		});
	}
	return Object.freeze({
		identity,
		cwd: value.cwd,
		env: Object.freeze(env),
		instructions: value.instructions,
		effort: effortSelection(value.effort),
		model: optionalLaunchSelection(value.model, "model"),
		permissionMode: permissionMode(value.permissionMode),
		process: processBinding,
		providerSessionId:
			value.providerSessionId === undefined
				? null
				: token(value.providerSessionId, "provider_session_id"),
	});
}

function historyAcquisition(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw hostContractError("history_snapshot_invalid");
	}
	if (value.status === "incomplete") {
		return Object.freeze({
			reason: token(value.reason, "history_reason"),
			status: "incomplete",
		});
	}
	if (
		value.status !== "complete" ||
		!Array.isArray(value.items) ||
		value.items.length > MAX_HISTORY_ITEMS
	) {
		throw hostContractError("history_snapshot_invalid");
	}
	const sourceIds = new Set();
	const items = value.items.map((rawItem) => {
		if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
			throw hostContractError("history_snapshot_invalid");
		}
		const sourceId = token(rawItem.sourceId, "history_source_id");
		if (sourceIds.has(sourceId)) throw hostContractError("history_source_id_duplicate");
		sourceIds.add(sourceId);
		const providerMessageId =
			rawItem.providerMessageId === null
				? null
				: token(rawItem.providerMessageId, "history_provider_message_id");
		if (!rawItem.body || typeof rawItem.body !== "object" || Array.isArray(rawItem.body)) {
			throw hostContractError("history_snapshot_invalid");
		}
		if (!Number.isSafeInteger(rawItem.createdAtMs) || rawItem.createdAtMs < 0) {
			throw hostContractError("history_snapshot_invalid");
		}
		let body;
		try {
			body = structuredClone(rawItem.body);
		} catch {
			throw hostContractError("history_snapshot_invalid");
		}
		const item = Object.freeze({
			body,
			createdAtMs: rawItem.createdAtMs,
			providerMessageId,
			sourceId,
		});
		if (Buffer.byteLength(JSON.stringify(item), "utf8") > MAX_HISTORY_ITEM_BYTES) {
			throw hostContractError("history_item_too_large");
		}
		return item;
	});
	return Object.freeze({
		items: Object.freeze(items),
		status: "complete",
	});
}

function unavailableHistory() {
	return Object.freeze({ reason: "history_reader_unavailable", status: "incomplete" });
}

function replayLimits(value = {}) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw hostContractError("replay_limits_invalid");
	}
	const maxEvents = value.maxEvents ?? DEFAULT_REPLAY_MAX_EVENTS;
	const maxBytes = value.maxBytes ?? DEFAULT_REPLAY_MAX_BYTES;
	if (
		!Number.isSafeInteger(maxEvents) ||
		maxEvents < 1 ||
		maxEvents > DEFAULT_REPLAY_MAX_EVENTS ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1_024 ||
		maxBytes > DEFAULT_REPLAY_MAX_BYTES
	) {
		throw hostContractError("replay_limits_invalid");
	}
	return Object.freeze({ maxBytes, maxEvents });
}

function byteLength(value) {
	try {
		const source = JSON.stringify(value);
		if (typeof source !== "string") throw hostContractError("event_not_serializable");
		return Buffer.byteLength(source, "utf8");
	} catch (error) {
		if (error?.code === "DURE_CLAUDE_SDK_HOST_CONTRACT") throw error;
		throw hostContractError("event_not_serializable");
	}
}

function eventByteLength(sequence, kind, payload) {
	return byteLength({
		sequence,
		kind,
		payload: payload === undefined ? null : payload,
	});
}

export function fitsSharedClaudeSdkHostEvent(kind, payload) {
	return eventByteLength(Number.MAX_SAFE_INTEGER, kind, payload) <= MAX_EVENT_BYTES;
}

function inputDigest(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function controllerPendingInteractions(controller) {
	if (!controller) return Object.freeze([]);
	let interactions;
	try {
		interactions = controller.pendingInteractions();
	} catch {
		throw hostContractError("pending_interactions_invalid");
	}
	if (!Array.isArray(interactions) || interactions.length > MAX_PENDING_INTERACTIONS_PER_QUERY) {
		throw hostContractError("pending_interactions_invalid");
	}
	if (interactions.length !== controllerPendingInteractionCount(controller)) {
		throw hostContractError("pending_interactions_invalid");
	}
	let cloned;
	try {
		cloned = structuredClone(interactions);
	} catch {
		throw hostContractError("pending_interactions_invalid");
	}
	if (byteLength(cloned) > MAX_INTERACTION_SNAPSHOT_BYTES) {
		throw hostContractError("pending_interactions_invalid");
	}
	return Object.freeze(cloned);
}

function controllerPendingInteractionCount(controller) {
	if (!controller) return 0;
	let count;
	try {
		count = controller.pendingInteractionCount();
	} catch {
		throw hostContractError("pending_interactions_invalid");
	}
	if (!Number.isSafeInteger(count) || count < 0 || count > MAX_PENDING_INTERACTIONS_PER_QUERY) {
		throw hostContractError("pending_interactions_invalid");
	}
	return count;
}

function interruptMessageIds(value) {
	if (!Array.isArray(value) || value.length > 128) {
		throw hostContractError("turn_interrupt_receipt_invalid");
	}
	return Object.freeze(value.map((entry) => token(entry, "interrupt_message_id")));
}

function controllerInterruptReceipt(value, request) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw hostContractError("turn_interrupt_receipt_invalid");
	}
	if (typeof value.receiptAvailable !== "boolean") {
		throw hostContractError("turn_interrupt_receipt_invalid");
	}
	return Object.freeze({
		cancelledMessageIds: interruptMessageIds(value.cancelledMessageIds),
		clientMessageId: request.clientMessageId,
		interruptRequestId: request.interruptRequestId,
		receiptAvailable: value.receiptAvailable,
		stillQueuedMessageIds: interruptMessageIds(value.stillQueuedMessageIds),
	});
}

function controllerActionError(error) {
	const prefix = "dure_claude_agent_sdk_";
	if (error?.code === "DURE_CLAUDE_AGENT_SDK_CONTRACT" && error.message?.startsWith(prefix)) {
		const reason = error.message.slice(prefix.length);
		if (/^[a-z0-9_]{1,64}$/u.test(reason)) return hostContractError(reason);
	}
	return error;
}

class QueryReplay {
	#events = [];
	#bytes = 0;
	#nextSequence;
	#droppedThrough;
	#committedThrough;
	#limits;

	constructor(limits, replayBase) {
		this.#limits = limits;
		this.#nextSequence = replayBase;
		this.#droppedThrough = replayBase;
		this.#committedThrough = replayBase;
	}

	get fullyCommitted() {
		return this.#committedThrough === this.#nextSequence;
	}

	append(kind, payload) {
		const event = Object.freeze({
			sequence: this.#nextSequence + 1,
			kind: token(kind, "event_kind"),
			payload: payload === undefined ? null : structuredClone(payload),
		});
		const bytes = eventByteLength(event.sequence, event.kind, event.payload);
		if (bytes > MAX_EVENT_BYTES || bytes > this.#limits.maxBytes) {
			throw hostContractError("event_too_large");
		}
		this.#nextSequence = event.sequence;
		this.#events.push({ bytes, event });
		this.#bytes += bytes;
		while (
			this.#events.length > this.#limits.maxEvents ||
			this.#bytes > this.#limits.maxBytes
		) {
			const removed = this.#events.shift();
			this.#bytes -= removed.bytes;
			this.#droppedThrough = removed.event.sequence;
		}
		return event;
	}

	acknowledge(sequence) {
		if (
			!Number.isSafeInteger(sequence) ||
			sequence < this.#committedThrough ||
			sequence > this.#nextSequence
		) {
			throw hostContractError("event_ack_invalid");
		}
		this.#committedThrough = sequence;
		while (this.#events[0]?.event.sequence <= sequence) {
			const removed = this.#events.shift();
			this.#bytes -= removed.bytes;
			this.#droppedThrough = removed.event.sequence;
		}
	}

	#cursor(afterSequence) {
		if (
			!Number.isSafeInteger(afterSequence) ||
			afterSequence < 0 ||
			afterSequence > this.#nextSequence
		) {
			throw hostContractError("event_cursor_invalid");
		}
		return Object.freeze({
			gap:
				afterSequence < this.#droppedThrough
					? Object.freeze({
							requestedAfter: afterSequence,
							droppedThrough: this.#droppedThrough,
						})
					: null,
			latestSequence: this.#nextSequence,
		});
	}

	status(afterSequence) {
		const cursor = this.#cursor(afterSequence);
		return Object.freeze({
			...cursor,
			events: Object.freeze([]),
			hasMore: this.#events.some(({ event }) => event.sequence > afterSequence),
			nextAfterSequence: afterSequence,
		});
	}

	replay(afterSequence) {
		const cursor = this.#cursor(afterSequence);
		const events = [];
		let bytes = 0;
		for (const entry of this.#events) {
			if (entry.event.sequence <= afterSequence) continue;
			if (
				events.length >= REPLAY_PAGE_MAX_EVENTS ||
				(events.length > 0 && bytes + entry.bytes > REPLAY_PAGE_MAX_BYTES)
			) {
				break;
			}
			events.push(entry.event);
			bytes += entry.bytes;
		}
		const nextAfterSequence = events.at(-1)?.sequence ?? afterSequence;
		return Object.freeze({
			...cursor,
			events: Object.freeze(events),
			hasMore: this.#events.some(({ event }) => event.sequence > nextAfterSequence),
			nextAfterSequence,
		});
	}
}

function parseTerminal(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw hostContractError("terminal_invalid");
	}
	if (value.reason !== undefined) {
		return Object.freeze({ reason: token(value.reason, "terminal_reason") });
	}
	const code = value.code ?? null;
	const signal = value.signal ?? null;
	if (
		(code === null) === (signal === null) ||
		(code !== null && (!Number.isSafeInteger(code) || code < 0)) ||
		(signal !== null && !/^SIG[A-Z0-9]+$/u.test(signal))
	) {
		throw hostContractError("terminal_invalid");
	}
	return Object.freeze({ code, signal });
}

class HostConnection {
	#host;
	#detached = false;
	#eventListeners = new Set();
	#cursors;

	constructor(host, clientGeneration, cursors) {
		this.#host = host;
		this.clientGeneration = clientGeneration;
		this.#cursors = { ...cursors };
	}

	#requireAttached() {
		if (this.#detached) throw hostContractError("client_detached");
		this.#host.requireConnection(this);
	}

	bind(binding, options) {
		this.#requireAttached();
		return this.#host.bind(binding, options);
	}

	startTurn(identity, turn) {
		this.#requireAttached();
		return this.#host.startTurn(identity, turn);
	}

	steerTurn(identity, turn) {
		this.#requireAttached();
		return this.#host.steerTurn(identity, turn);
	}

	interruptTurn(identity, request) {
		this.#requireAttached();
		return this.#host.interruptTurn(identity, request);
	}

	answerInteraction(identity, answer) {
		this.#requireAttached();
		return this.#host.answerInteraction(identity, answer);
	}

	pendingInteractions(identity) {
		this.#requireAttached();
		return this.#host.pendingInteractions(identity);
	}

	pendingSnapshot(identity) {
		this.#requireAttached();
		return this.#host.pendingSnapshot(identity);
	}

	historyPage(identity, offset) {
		this.#requireAttached();
		return this.#host.historyPage(identity, offset);
	}

	ackHistory(identity) {
		this.#requireAttached();
		return this.#host.ackHistory(identity);
	}

	replay(identity, afterSequence) {
		this.#requireAttached();
		return this.#host.replay(identity, afterSequence);
	}

	ack(identity, sequence) {
		this.#requireAttached();
		const parsedIdentity = queryIdentity(identity);
		this.#host.ack(parsedIdentity, sequence);
		this.#cursors[parsedIdentity.runtimeGeneration] = sequence;
	}

	snapshot() {
		this.#requireAttached();
		return this.#host.snapshot(this.#cursors);
	}

	onEvent(listener) {
		this.#requireAttached();
		if (typeof listener !== "function") throw hostContractError("event_listener_invalid");
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	publish(identity, event) {
		if (this.#detached) return;
		for (const listener of this.#eventListeners) {
			try {
				listener(identity, event);
			} catch {
				// Event delivery is an observation path. The bounded replay remains
				// authoritative if an attached observer cannot consume a push.
			}
		}
	}

	closeQuery(identity) {
		this.#requireAttached();
		return this.#host.closeQuery(identity);
	}

	closeQueryIfIdle(identity) {
		this.#requireAttached();
		return this.#host.closeQueryIfIdle(identity);
	}

	retireQuery(identity, options) {
		this.#requireAttached();
		return this.#host.retireQuery(identity, options);
	}

	retireQueryIfIdle(identity, options) {
		this.#requireAttached();
		return this.#host.retireQueryIfIdle(identity, options);
	}

	recoverQueryRetirement(identity, retirement) {
		this.#requireAttached();
		return this.#host.recoverQueryRetirement(identity, retirement);
	}

	queryRetirementStatus(identity) {
		this.#requireAttached();
		return this.#host.queryRetirementStatus(identity);
	}

	commitQueryReplacement(authority, target) {
		this.#requireAttached();
		return this.#host.commitQueryReplacement(authority, target);
	}

	retargetQueryRetirement(authority, target) {
		this.#requireAttached();
		return this.#host.retargetQueryRetirement(authority, target);
	}

	releaseQueryRetirement(authority) {
		this.#requireAttached();
		return this.#host.releaseQueryRetirement(authority);
	}

	confirmQueryRetirementRelease(authority) {
		this.#requireAttached();
		return this.#host.confirmQueryRetirementRelease(authority);
	}

	beginDrain() {
		this.#requireAttached();
		return this.#host.beginDrain();
	}

	detach() {
		if (this.#detached) return;
		this.#detached = true;
		this.#eventListeners.clear();
		this.#host.detach(this);
	}
}

class SharedClaudeSdkHost {
	#activeConnection;
	#createQuery;
	#queries = new Map();
	#readHistory;
	#replayLimits;
	#retired = new Map();
	#state = "ready";
	#releaseOwner;
	#unownedIdle;

	constructor({
		hostGeneration,
		hostInstanceId = randomUUID(),
		createQuery,
		readHistory = unavailableHistory,
		replayLimits: configuredReplayLimits,
		retiredIdentities = [],
	}) {
		this.hostGeneration = token(hostGeneration, "host_generation");
		this.hostInstanceId = token(hostInstanceId, "host_instance_id");
		if (typeof createQuery !== "function") throw hostContractError("query_factory_required");
		this.#createQuery = createQuery;
		if (typeof readHistory !== "function") throw hostContractError("history_reader_required");
		this.#readHistory = readHistory;
		this.#replayLimits = replayLimits(configuredReplayLimits);
		if (!Array.isArray(retiredIdentities) || retiredIdentities.length > MAX_RETIRED_IDENTITIES) {
			throw hostContractError("retired_identities_invalid");
		}
		for (const value of retiredIdentities) {
			const identity = queryIdentity(value);
			if (this.#retired.has(identity.runtimeGeneration)) {
				throw hostContractError("retired_runtime_generation_duplicate");
			}
			this.#retired.set(identity.runtimeGeneration, {
				authority: retiredAuthority(identity, null, this.#hostIdentity()),
				bindReceipt: null,
				targetBinding: null,
			});
		}
	}

	#hostIdentity() {
		return Object.freeze({
			hostGeneration: this.hostGeneration,
			hostInstanceId: this.hostInstanceId,
		});
	}

	get state() {
		return this.#state;
	}

	get queryCount() {
		let count = 0;
		for (const query of this.#queries.values()) if (query.active) count += 1;
		return count;
	}

	attach({ hostGeneration, clientGeneration, cursors = {} } = {}) {
		if (hostGeneration !== this.hostGeneration) throw hostContractError("stale_host_generation");
		if (this.#state === "failed") throw hostContractError("failed");
		if (this.#activeConnection) throw hostContractError("client_already_attached");
		clientGeneration = token(clientGeneration, "client_generation");
		if (!cursors || typeof cursors !== "object" || Array.isArray(cursors)) {
			throw hostContractError("cursors_invalid");
		}
		const parsedCursors = {};
		for (const [runtimeGeneration, sequence] of Object.entries(cursors)) {
			token(runtimeGeneration, "cursor_runtime_generation");
			if (!Number.isSafeInteger(sequence) || sequence < 0) {
				throw hostContractError("event_cursor_invalid");
			}
			parsedCursors[runtimeGeneration] = sequence;
		}
		for (const record of this.#queries.values()) {
			const cursor = parsedCursors[record.binding.identity.runtimeGeneration];
			if (cursor !== undefined) record.replay.status(cursor);
		}
		const connection = new HostConnection(
			this,
			clientGeneration,
			Object.freeze(parsedCursors),
		);
		this.#activeConnection = connection;
		return connection;
	}

	requireConnection(connection) {
		if (this.#state === "failed") throw hostContractError("failed");
		if (this.#activeConnection !== connection) throw hostContractError("stale_client");
	}

	detach(connection) {
		if (this.#activeConnection === connection) this.#activeConnection = undefined;
		this.#convergeDrain();
	}

	// A controller is a client, not the lifetime of its Queries. Retain both
	// active work and uncommitted replay until an attached successor releases them.
	releaseOwner() {
		this.#unownedIdle ??= new Promise((resolve) => {
			this.#releaseOwner = resolve;
		});
		this.#convergeDrain();
		return this.#unownedIdle;
	}

	#record(identity) {
		identity = queryIdentity(identity);
		const record = this.#queries.get(identity.runtimeGeneration);
		if (!record || !sameIdentity(record.binding.identity, identity)) {
			throw hostContractError("stale_query_identity");
		}
		return record;
	}

	#retirementTarget(rawIdentity) {
		const identity = queryIdentity(rawIdentity);
		const record = this.#queries.get(identity.runtimeGeneration);
		if (record) {
			if (!sameIdentity(record.binding.identity, identity)) {
				throw hostContractError("query_identity_conflict");
			}
			return { identity, record, retired: undefined };
		}
		const retired = this.#retired.get(identity.runtimeGeneration);
		if (retired) {
			if (!sameIdentity(retired.authority.source, identity)) {
				throw hostContractError("query_identity_conflict");
			}
			return { identity, record: undefined, retired };
		}
		throw hostContractError("stale_query_identity");
	}

	#retirementReceipt(outcome, identity, replayCommitted, authority) {
		return Object.freeze({ authority, identity, outcome, replayCommitted });
	}

	#append(record, kind, payload) {
		const event = record.replay.append(kind, payload);
		this.#activeConnection?.publish(record.binding.identity, event);
		return event;
	}

	async bind(rawBinding, options = {}) {
		if (this.#state === "failed") throw hostContractError("failed");
		if (this.#state !== "ready") throw hostContractError("draining");
		const binding = queryBinding(rawBinding);
		if (!options || typeof options !== "object" || Array.isArray(options)) {
			throw hostContractError("replacement_invalid");
		}
		const replacementAuthority =
			options.authority === undefined ? null : providerRetirementAuthority(options.authority);
		const replayBase = options.replayBase === undefined ? 0 : options.replayBase;
		if (Object.keys(options).some((key) => key !== "authority" && key !== "replayBase")) {
			throw hostContractError("replacement_invalid");
		}
		if (
			!Number.isSafeInteger(replayBase) ||
			replayBase < 0 ||
			replayBase >= Number.MAX_SAFE_INTEGER
		) {
			throw hostContractError("replay_base_invalid");
		}
		const existing = this.#queries.get(binding.identity.runtimeGeneration);
		if (existing) {
			if (
				!sameBindingOrUnestablishedReplay(existing.binding, binding) ||
				(replacementAuthority !== null &&
					(existing.replacementAuthority === null ||
						!sameRetirementAuthority(
							existing.replacementAuthority,
							replacementAuthority,
						)))
			) {
				throw hostContractError("runtime_generation_conflict");
			}
			if (!existing.active || !existing.bindReceipt) {
				throw hostContractError("query_exited");
			}
			return existing.bindReceipt;
		}
		if (this.#queries.size >= MAX_QUERY_RECORDS) {
			throw hostContractError("query_record_capacity_exceeded");
		}
		if (this.#retired.has(binding.identity.runtimeGeneration)) {
			throw hostContractError("stale_runtime_generation");
		}

		let replacementFence;
		if (replacementAuthority !== null) {
			if (
				replacementAuthority.phase !== "retired" ||
				replacementAuthority.allowedTarget === null ||
				!sameIdentity(replacementAuthority.allowedTarget, binding.identity)
			) {
				throw hostContractError("replacement_authority_invalid");
			}
			const expected = this.#retired.get(replacementAuthority.source.runtimeGeneration);
			if (sameHostIdentity(replacementAuthority.sourceHost, this.#hostIdentity())) {
				if (
					!expected ||
					!sameRetirementAuthority(expected.authority, replacementAuthority)
				) {
					throw hostContractError("replacement_authority_invalid");
				}
			} else if (expected) {
				if (!sameRetirementAuthority(expected.authority, replacementAuthority)) {
					throw hostContractError("replacement_authority_conflict");
				}
			} else {
				if (this.#retired.size >= MAX_RETIRED_IDENTITIES) {
					throw hostContractError("retired_identity_capacity_exceeded");
				}
				this.#retired.set(replacementAuthority.source.runtimeGeneration, {
					authority: replacementAuthority,
					bindReceipt: null,
					targetBinding: null,
				});
			}
			replacementFence = this.#retired.get(
				replacementAuthority.source.runtimeGeneration,
			);
			if (
				replacementFence.targetBinding !== null &&
				!sameBinding(replacementFence.targetBinding, binding)
			) {
				throw hostContractError("replacement_authority_conflict");
			}
		}

		const record = {
			active: true,
			abort: new AbortController(),
			binding,
			controller: undefined,
			bindReceipt: undefined,
			history: unavailableHistory(),
			messages: new Map(),
			replay: new QueryReplay(this.#replayLimits, replayBase),
			replacementAuthority,
			retiring: false,
			state: "starting",
			terminal: undefined,
		};
		this.#queries.set(binding.identity.runtimeGeneration, record);
		const emit = (kind, payload) => {
			if (!record.active) throw hostContractError("event_after_terminal");
			if (kind === "provider_session_initialized") {
				projectProviderSessionBinding(record, payload, replacementFence);
			}
			return this.#append(record, kind, payload);
		};
		const terminal = (value) => {
			if (!record.active) return false;
			record.terminal = parseTerminal(value);
			record.active = false;
			record.state = "exited";
			this.#append(record, "query_exited", record.terminal);
			this.#convergeDrain();
			return true;
		};
		try {
			try {
				record.history = historyAcquisition(await this.#readHistory(binding));
			} catch {
				record.history = unavailableHistory();
			}
			if (!record.active) throw hostContractError("query_exited_during_bind");
			const controller = await this.#createQuery({
				binding,
				emit,
				signal: record.abort.signal,
				terminal,
			});
			if (
				!controller ||
				typeof controller.answerInteraction !== "function" ||
				typeof controller.startTurn !== "function" ||
				typeof controller.interruptTurn !== "function" ||
				typeof controller.pendingInteractionCount !== "function" ||
				typeof controller.pendingInteractions !== "function" ||
				typeof controller.close !== "function" ||
				typeof controller.invalidate !== "function"
			) {
				if (typeof controller?.invalidate === "function") {
					await controller.invalidate("query_controller_invalid");
				}
				throw hostContractError("query_controller_invalid");
			}
			record.controller = controller;
			if (!record.active) {
				await controller.invalidate("host_failed_during_bind");
				throw hostContractError("query_exited_during_bind");
			}
			record.state = "waiting_for_input";
			this.#append(record, "initialized", {
				providerSessionId: record.binding.providerSessionId,
			});
			record.bindReceipt = Object.freeze({
				hostIdentity: this.#hostIdentity(),
				identity: binding.identity,
				state: record.state,
			});
			if (replacementFence) {
				replacementFence.bindReceipt = record.bindReceipt;
				replacementFence.targetBinding = record.binding;
			}
			return record.bindReceipt;
		} catch (error) {
			this.#queries.delete(binding.identity.runtimeGeneration);
			if (
				replacementFence &&
				replacementFence.targetBinding !== null &&
				sameBinding(replacementFence.targetBinding, record.binding)
			) {
				replacementFence.bindReceipt = null;
				replacementFence.targetBinding = null;
			}
			throw error;
		}
	}

	historyPage(rawIdentity, offset = 0) {
		const record = this.#record(rawIdentity);
		if (!Number.isSafeInteger(offset) || offset < 0) {
			throw hostContractError("history_offset_invalid");
		}
		const history = record.history;
		if (history.status === "released") throw hostContractError("history_page_released");
		if (history.status === "incomplete") {
			if (offset !== 0) throw hostContractError("history_offset_invalid");
			return Object.freeze({
				hasMore: false,
				items: Object.freeze([]),
				nextOffset: 0,
				offset: 0,
				reason: history.reason,
				status: "incomplete",
			});
		}
		if (offset > history.items.length) throw hostContractError("history_offset_invalid");
		const items = [];
		let bytes = 0;
		for (let index = offset; index < history.items.length; index += 1) {
			const item = history.items[index];
			const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
			if (
				items.length > 0 &&
				(items.length >= MAX_HISTORY_PAGE_ITEMS || bytes + itemBytes > MAX_HISTORY_PAGE_BYTES)
			) {
				break;
			}
			items.push(structuredClone(item));
			bytes += itemBytes;
		}
		const nextOffset = offset + items.length;
		return Object.freeze({
			hasMore: nextOffset < history.items.length,
			items: Object.freeze(items),
			nextOffset,
			offset,
			status: "complete",
		});
	}

	ackHistory(rawIdentity) {
		const record = this.#record(rawIdentity);
		record.history = Object.freeze({ status: "released" });
		return Object.freeze({ released: true });
	}

	/** Delivers one user message into the RUNNING turn. The provider applies
	 * it at its next tool boundary; acceptance means the push reached the
	 * provider's own queue, so the caller must not re-send it afterwards. */
	steerTurn(identity, value) {
		if (this.#state === "failed") throw hostContractError("failed");
		const record = this.#record(identity);
		if (!record.active) throw hostContractError("query_exited");
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw hostContractError("turn_invalid");
		}
		const clientMessageId = token(value.clientMessageId, "client_message_id");
		if (typeof value.input !== "string" || Buffer.byteLength(value.input, "utf8") > MAX_INPUT_BYTES) {
			throw hostContractError("turn_input_invalid");
		}
		const digest = inputDigest(value.input);
		const existingReceipt = record.messages.get(clientMessageId);
		if (existingReceipt) {
			if (existingReceipt.inputDigest !== digest) {
				throw hostContractError("message_id_conflict");
			}
			return existingReceipt.acceptance;
		}
		if (record.retiring || record.state !== "running") {
			throw hostContractError("turn_not_running");
		}
		if (record.messages.size >= MAX_UNCOMMITTED_TURN_RECEIPTS) {
			throw hostContractError("turn_receipt_capacity_exceeded");
		}
		if (typeof record.controller.steerTurn !== "function") {
			throw hostContractError("steer_unsupported");
		}
		// Commit the acceptance only after the push reached the provider.
		record.controller.steerTurn({ clientMessageId, input: value.input });
		const acceptedEvent = this.#append(record, "user_message_accepted", {
			clientMessageId,
		});
		const acceptance = Object.freeze({
			acceptedEventSequence: acceptedEvent.sequence,
			clientMessageId,
		});
		record.messages.set(clientMessageId, {
			acceptance,
			finalEventSequence: null,
			inputDigest: digest,
			interrupt: undefined,
		});
		return acceptance;
	}

	startTurn(identity, value) {
		if (this.#state === "failed") throw hostContractError("failed");
		const record = this.#record(identity);
		if (!record.active) throw hostContractError("query_exited");
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw hostContractError("turn_invalid");
		}
		const clientMessageId = token(value.clientMessageId, "client_message_id");
		if (typeof value.input !== "string" || Buffer.byteLength(value.input, "utf8") > MAX_INPUT_BYTES) {
			throw hostContractError("turn_input_invalid");
		}
		const digest = inputDigest(value.input);
		const existingReceipt = record.messages.get(clientMessageId);
		if (existingReceipt) {
			if (existingReceipt.inputDigest !== digest) {
				throw hostContractError("message_id_conflict");
			}
			return existingReceipt.acceptance;
		}
		if (record.retiring || record.state !== "waiting_for_input") {
			throw hostContractError("query_busy");
		}
		if (record.messages.size >= MAX_UNCOMMITTED_TURN_RECEIPTS) {
			throw hostContractError("turn_receipt_capacity_exceeded");
		}

		const acceptedEvent = this.#append(record, "user_message_accepted", { clientMessageId });
		const acceptance = Object.freeze({
			acceptedEventSequence: acceptedEvent.sequence,
			clientMessageId,
		});
		const receipt = {
			acceptance,
			finalEventSequence: null,
			inputDigest: digest,
			interrupt: undefined,
		};
		record.messages.set(clientMessageId, receipt);
		record.state = "running";
		record.activeClientMessageId = clientMessageId;
		record.activeTurn = Promise.resolve()
			.then(() =>
				record.controller.startTurn({
					clientMessageId,
					input: value.input,
				}),
			)
			.then((result) => {
				if (!record.active) return;
				const completion = Object.freeze({
					clientMessageId,
					result: structuredClone(result ?? null),
				});
				record.state = "waiting_for_input";
				record.activeClientMessageId = undefined;
				receipt.finalEventSequence = this.#append(
					record,
					"turn_completed",
					completion,
				).sequence;
			})
			.catch((error) => {
				if (record.active) {
					record.state = "waiting_for_input";
					record.activeClientMessageId = undefined;
					// Only the driver's bounded classification crosses the
					// boundary — never the provider's error text.
					receipt.finalEventSequence = this.#append(record, "turn_failed", {
						clientMessageId,
						reason: turnFailureReasonToken(error),
					}).sequence;
				}
			})
			.finally(() => {
				record.activeTurn = undefined;
			});
		return acceptance;
	}

	async interruptTurn(identity, value) {
		if (this.#state === "failed") throw hostContractError("failed");
		const record = this.#record(identity);
		if (!record.active) throw hostContractError("query_exited");
		if (record.retiring) throw hostContractError("query_busy");
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw hostContractError("turn_interrupt_invalid");
		}
		const request = Object.freeze({
			clientMessageId: token(value.clientMessageId, "client_message_id"),
			interruptRequestId: token(value.interruptRequestId, "interrupt_request_id"),
		});
		const turnReceipt = record.messages.get(request.clientMessageId);
		if (!turnReceipt) throw hostContractError("stale_turn_identity");
		if (turnReceipt.interrupt) {
			if (turnReceipt.interrupt.interruptRequestId !== request.interruptRequestId) {
				throw hostContractError("turn_interrupt_conflict");
			}
			return turnReceipt.interrupt.promise;
		}
		if (record.activeClientMessageId !== request.clientMessageId) {
			throw hostContractError("stale_turn_identity");
		}
		const promise = Promise.resolve()
			.then(() => record.controller.interruptTurn(request))
			.then((receipt) => controllerInterruptReceipt(receipt, request))
			.catch((error) => {
				throw controllerActionError(error);
			});
		turnReceipt.interrupt = Object.freeze({
			interruptRequestId: request.interruptRequestId,
			promise,
		});
		return promise;
	}

	async answerInteraction(identity, answer) {
		if (this.#state === "failed") throw hostContractError("failed");
		const record = this.#record(identity);
		if (!record.active) throw hostContractError("query_exited");
		if (record.retiring) throw hostContractError("query_busy");
		if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
			throw hostContractError("interaction_answer_invalid");
		}
		try {
			return await record.controller.answerInteraction(structuredClone(answer));
		} catch (error) {
			throw controllerActionError(error);
		}
	}

	pendingInteractions(identity) {
		const record = this.#record(identity);
		return controllerPendingInteractions(record.controller);
	}

	pendingSnapshot(identity) {
		const record = this.#record(identity);
		return Object.freeze({
			observedThroughSequence: record.replay.status(0).latestSequence,
			requests: controllerPendingInteractions(record.controller),
		});
	}

	replay(identity, afterSequence) {
		return this.#record(identity).replay.replay(afterSequence);
	}

	snapshot(cursors = {}) {
		const queries = [...this.#queries.values()]
			.map((record) => {
				const afterSequence = cursors[record.binding.identity.runtimeGeneration] ?? 0;
				const pendingInteractionCount = controllerPendingInteractionCount(record.controller);
				return Object.freeze({
					identity: record.binding.identity,
					pendingInteractionCount,
					providerSessionId: record.binding.providerSessionId,
					state: record.state,
					replay: record.replay.status(afterSequence),
				});
			})
			.sort((left, right) =>
				left.identity.runtimeGeneration.localeCompare(right.identity.runtimeGeneration),
			);
		return Object.freeze({
			hostGeneration: this.hostGeneration,
			hostInstanceId: this.hostInstanceId,
			state: this.#state,
			queries,
		});
	}

	ack(identity, sequence) {
		const record = this.#record(identity);
		record.replay.acknowledge(sequence);
		for (const [clientMessageId, receipt] of record.messages) {
			if (receipt.finalEventSequence !== null && receipt.finalEventSequence <= sequence) {
				record.messages.delete(clientMessageId);
			}
		}
		if (!record.active && record.replay.fullyCommitted) {
			if (
				!this.#retired.has(record.binding.identity.runtimeGeneration) &&
				this.#retired.size >= MAX_RETIRED_IDENTITIES
			) {
				throw hostContractError("retired_identity_capacity_exceeded");
			}
			this.#retired.set(record.binding.identity.runtimeGeneration, {
				authority:
					record.retirementAuthority ??
					retiredAuthority(record.binding.identity, null, this.#hostIdentity()),
				bindReceipt: null,
				targetBinding: null,
			});
			this.#queries.delete(record.binding.identity.runtimeGeneration);
		}
		this.#convergeDrain();
	}

	async closeQuery(identity) {
		const record = this.#record(identity);
		if (!record.active) return record.terminal;
		await record.controller.close();
		if (record.active) throw hostContractError("query_close_without_terminal");
		return record.terminal;
	}

	async closeQueryIfIdle(identity) {
		const record = this.#record(identity);
		if (record.retiring || record.state !== "waiting_for_input") {
			throw hostContractError("query_busy");
		}
		record.retiring = true;
		try {
			return await this.closeQuery(identity);
		} catch (error) {
			if (record.active) record.retiring = false;
			throw error;
		}
	}

	async #retireQuery(identity, requireIdle, options = {}) {
		if (!options || typeof options !== "object" || Array.isArray(options)) {
			throw hostContractError("retirement_options_invalid");
		}
		if (Object.keys(options).some((key) => key !== "allowedTarget")) {
			throw hostContractError("retirement_options_invalid");
		}
		const allowedTarget =
			options.allowedTarget === undefined || options.allowedTarget === null
				? null
				: queryIdentity(options.allowedTarget);
		const target = this.#retirementTarget(identity);
		if (target.retired) {
			if (
				(target.retired.authority.allowedTarget === null) !== (allowedTarget === null) ||
				(allowedTarget !== null &&
					!sameIdentity(target.retired.authority.allowedTarget, allowedTarget))
			) {
				throw hostContractError("retirement_authority_conflict");
			}
			return this.#retirementReceipt(
				"already_retired",
				target.identity,
				true,
				target.retired.authority,
			);
		}
		const { record } = target;
		const authority =
			record.retirementAuthority ??
			retiredAuthority(target.identity, allowedTarget, this.#hostIdentity());
		if (
			(authority.allowedTarget === null) !== (allowedTarget === null) ||
			(allowedTarget !== null && !sameIdentity(authority.allowedTarget, allowedTarget))
		) {
			throw hostContractError("retirement_authority_conflict");
		}
		record.retirementAuthority = authority;
		if (!record.active) {
			return this.#retirementReceipt("already_retired", target.identity, false, authority);
		}
		if (record.retiring || (requireIdle && record.state !== "waiting_for_input")) {
			throw hostContractError("query_busy");
		}
		record.retiring = true;
		try {
			await this.closeQuery(target.identity);
		} catch (error) {
			if (record.active) record.retiring = false;
			throw error;
		}
		return this.#retirementReceipt("retired", target.identity, false, authority);
	}

	retireQuery(identity, options) {
		return this.#retireQuery(identity, false, options);
	}

	retireQueryIfIdle(identity, options) {
		return this.#retireQuery(identity, true, options);
	}

	recoverQueryRetirement(rawIdentity, options = {}) {
		const identity = queryIdentity(rawIdentity);
		if (!options || typeof options !== "object" || Array.isArray(options)) {
			throw hostContractError("retirement_options_invalid");
		}
		if (Object.keys(options).some((key) => key !== "allowedTarget")) {
			throw hostContractError("retirement_options_invalid");
		}
		const allowedTarget =
			options.allowedTarget === undefined || options.allowedTarget === null
				? null
				: queryIdentity(options.allowedTarget);
		const record = this.#queries.get(identity.runtimeGeneration);
		if (record) {
			if (!sameIdentity(record.binding.identity, identity)) {
				throw hostContractError("query_identity_conflict");
			}
			throw hostContractError("retirement_authority_conflict");
		}
		let retired = this.#retired.get(identity.runtimeGeneration);
		if (retired && !sameIdentity(retired.authority.source, identity)) {
			throw hostContractError("query_identity_conflict");
		}
		const requested = retiredAuthority(identity, allowedTarget, this.#hostIdentity());
		if (!retired) {
			if (this.#retired.size >= MAX_RETIRED_IDENTITIES) {
				throw hostContractError("retired_identity_capacity_exceeded");
			}
			retired = { authority: requested, bindReceipt: null, targetBinding: null };
			this.#retired.set(identity.runtimeGeneration, retired);
		} else if (
			retired.authority.phase !== "retired" ||
			retired.bindReceipt !== null ||
			retired.targetBinding !== null ||
			!sameRetirementAuthority(retired.authority, requested)
		) {
			throw hostContractError("retirement_authority_conflict");
		}
		return this.#retirementReceipt(
			"recovered",
			identity,
			true,
			retired.authority,
		);
	}

	queryRetirementStatus(identity) {
		const target = this.#retirementTarget(identity);
		if (target.retired) {
			return this.#retirementReceipt(
				"already_retired",
				target.identity,
				true,
				target.retired.authority,
			);
		}
		if (target.record.active) throw hostContractError("query_not_retired");
		const authority =
			target.record.retirementAuthority ??
			retiredAuthority(target.identity, null, this.#hostIdentity());
		target.record.retirementAuthority = authority;
		return this.#retirementReceipt("already_retired", target.identity, false, authority);
	}

	commitQueryReplacement(rawAuthority, rawTarget) {
		const authority = providerRetirementAuthority(rawAuthority);
		const target = queryIdentity(rawTarget);
		if (
			authority.phase !== "retired" ||
			authority.allowedTarget === null ||
			!sameIdentity(authority.allowedTarget, target)
		) {
			throw hostContractError("replacement_authority_invalid");
		}
		const targetRecord = this.#queries.get(target.runtimeGeneration);
		if (!targetRecord || !sameIdentity(targetRecord.binding.identity, target) || !targetRecord.active) {
			throw hostContractError("replacement_target_missing");
		}
		let retired = this.#retired.get(authority.source.runtimeGeneration);
		if (!retired) {
			if (sameHostIdentity(authority.sourceHost, this.#hostIdentity())) {
				throw hostContractError("replacement_authority_invalid");
			}
			if (this.#retired.size >= MAX_RETIRED_IDENTITIES) {
				throw hostContractError("retired_identity_capacity_exceeded");
			}
			retired = { authority, bindReceipt: targetRecord.bindReceipt, targetBinding: targetRecord.binding };
			this.#retired.set(authority.source.runtimeGeneration, retired);
		}
		const replayedBound =
			retired.authority.phase === "target_bound" &&
			sameRetirementAuthority(
				retired.authority,
				boundAuthority(authority, this.#hostIdentity()),
			);
		if (
			(!sameRetirementAuthority(retired.authority, authority) && !replayedBound) ||
			(retired.targetBinding !== null && !sameBinding(retired.targetBinding, targetRecord.binding))
		) {
			throw hostContractError("replacement_authority_conflict");
		}
		if (replayedBound) {
			return Object.freeze({ authority: retired.authority, outcome: "target_bound" });
		}
		retired.bindReceipt ??= targetRecord.bindReceipt;
		retired.targetBinding ??= targetRecord.binding;
		retired.authority = boundAuthority(authority, this.#hostIdentity());
		return Object.freeze({ authority: retired.authority, outcome: "target_bound" });
	}

	retargetQueryRetirement(rawAuthority, rawTarget) {
		const authority = providerRetirementAuthority(rawAuthority);
		const target = queryIdentity(rawTarget);
		if (authority.phase !== "retired") {
			throw hostContractError("retirement_authority_invalid");
		}
		requireDistinctRetirementTarget(authority.source, target);
		let retired = this.#retired.get(authority.source.runtimeGeneration);
		if (!retired) {
			if (sameHostIdentity(authority.sourceHost, this.#hostIdentity())) {
				throw hostContractError("retirement_authority_invalid");
			}
			if (this.#retired.size >= MAX_RETIRED_IDENTITIES) {
				throw hostContractError("retired_identity_capacity_exceeded");
			}
			retired = { authority, bindReceipt: null, targetBinding: null };
			this.#retired.set(authority.source.runtimeGeneration, retired);
		}
		const replayedRetarget =
			sameRetirementSource(retired.authority, authority) &&
			retired.authority.allowedTarget !== null &&
			sameIdentity(retired.authority.allowedTarget, target);
		if (
			(!sameRetirementAuthority(retired.authority, authority) && !replayedRetarget) ||
			retired.bindReceipt !== null
		) {
			throw hostContractError("retirement_authority_conflict");
		}
		if (replayedRetarget) {
			return Object.freeze({ authority: retired.authority, outcome: "retargeted" });
		}
		retired.authority = retiredAuthority(authority.source, target, authority.sourceHost);
		return Object.freeze({ authority: retired.authority, outcome: "retargeted" });
	}

	releaseQueryRetirement(rawAuthority) {
		const authority = providerRetirementAuthority(rawAuthority);
		if (authority.phase === "released") {
			throw hostContractError("retirement_authority_invalid");
		}
		const retired = this.#retired.get(authority.source.runtimeGeneration);
		if (!retired) {
			const owner = authority.targetHost ?? authority.sourceHost;
			if (sameHostIdentity(owner, this.#hostIdentity())) {
				throw hostContractError("retirement_authority_invalid");
			}
			return Object.freeze({ authority: releasedAuthority(authority), outcome: "already_released" });
		}
		const replayedRelease =
			retired.authority.phase === "released" &&
			sameRetirementAuthority(retired.authority, releasedAuthority(authority));
		const advancedFromRetired =
			authority.phase === "retired" &&
			retired.authority.phase !== "retired" &&
			retired.authority.targetHost !== null &&
			sameRetirementLineage(retired.authority, authority);
		if (
			!sameRetirementAuthority(retired.authority, authority) &&
			!replayedRelease &&
			!advancedFromRetired
		) {
			throw hostContractError("retirement_authority_conflict");
		}
		if (retired.authority.phase !== "released") {
			retired.authority = releasedAuthority(retired.authority);
		}
		return Object.freeze({ authority: retired.authority, outcome: "released" });
	}

	confirmQueryRetirementRelease(rawAuthority) {
		const authority = providerRetirementAuthority(rawAuthority);
		if (authority.phase !== "released") {
			throw hostContractError("retirement_authority_invalid");
		}
		const retired = this.#retired.get(authority.source.runtimeGeneration);
		if (!retired) return Object.freeze({ authority, outcome: "already_absent" });
		if (!sameRetirementAuthority(retired.authority, authority)) {
			throw hostContractError("retirement_authority_conflict");
		}
		this.#retired.delete(authority.source.runtimeGeneration);
		return Object.freeze({ authority, outcome: "confirmed" });
	}

	beginDrain() {
		if (this.#state === "failed") throw hostContractError("failed");
		if (this.#state === "ready") this.#state = "draining";
		this.#convergeDrain();
		return [...this.#queries.values()]
			.filter(({ active }) => active)
			.map(({ binding }) => binding.identity)
			.sort((left, right) => left.runtimeGeneration.localeCompare(right.runtimeGeneration));
	}

	#convergeDrain() {
		const idle = [...this.#queries.values()].every(
			(record) => !record.active && record.replay.fullyCommitted,
		);
		if (this.#state === "draining" && idle) {
			this.#state = "drained";
		}
		if (idle && !this.#activeConnection) this.#releaseOwner?.();
	}

	async fail(reason) {
		if (this.#state === "failed") return [];
		reason = token(reason, "failure_reason");
		const affected = [...this.#queries.values()]
			.filter(({ active }) => active)
			.map(({ binding }) => binding.identity)
			.sort((left, right) => left.runtimeGeneration.localeCompare(right.runtimeGeneration));
		this.#state = "failed";
		await Promise.allSettled(
			affected.map(async (identity) => {
				const record = this.#queries.get(identity.runtimeGeneration);
				record.active = false;
				record.state = "failed";
				record.abort.abort(reason);
				if (record.controller) await record.controller.invalidate(reason);
			}),
		);
		this.#activeConnection = undefined;
		return affected;
	}
}

export function createSharedClaudeSdkHost(options) {
	if (!options || typeof options !== "object" || Array.isArray(options)) {
		throw hostContractError("options_invalid");
	}
	return new SharedClaudeSdkHost(options);
}
