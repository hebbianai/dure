import { createHash } from "node:crypto";

import { createClaudeQueryInteractionBroker } from "./agent-sdk-interactions.mjs";
import {
	attestClaudeRuntimeArtifact,
	claudeRuntimeArtifactDescriptor,
} from "./claude-runtime-artifact.mjs";
import { createClaudeRelaySpawner } from "./relay-spawned-process.mjs";
import { fitsSharedClaudeSdkHostEvent } from "./shared-sdk-host.mjs";

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 120_000;
const DELTA_FRAGMENT_MAX_BYTES = 16 * 1024;
const MAX_LAUNCH_ARGUMENTS = 256;
const MAX_LAUNCH_ARGUMENT_BYTES = 32 * 1024;
const MAX_LAUNCH_ARGUMENT_TOTAL_BYTES = 256 * 1024;
const MAX_METADATA_STRING_BYTES = 4 * 1024;
const MAX_ACTIVE_TOOL_CALLS = 256;
const MAX_CANONICAL_STREAM_TEXT_BYTES = 256 * 1024;
const MAX_STREAM_DELTA_BYTES = 2 * 1024 * 1024;
const MAX_TRACE_CONTEXT_BYTES = 4 * 1024;
const SDK_ENTRYPOINT = "sdk-ts";
const SDK_ADDED_ENVIRONMENT_KEYS = new Set(["TRACEPARENT", "TRACESTATE"]);
const SAFE_OPERATION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function adapterError(reason) {
	const error = new Error(`dure_claude_agent_sdk_${reason}`);
	error.code = "DURE_CLAUDE_AGENT_SDK_CONTRACT";
	return error;
}

// The legacy "Claude AI usage limit reached|<epoch>" result text; current
// CLIs use the pinned SDK's USAGE_LIMIT_ERROR_PREFIXES, which the runtime
// loader hands in so the list can never drift from the SDK. Only a bounded
// reason token crosses the boundary; the text itself never does.
const LEGACY_USAGE_LIMIT_RESULT_PREFIXES = Object.freeze([
	"Claude AI usage limit reached",
]);

function usageLimitResultPrefixes(sdkPrefixes) {
	return Object.freeze([
		...LEGACY_USAGE_LIMIT_RESULT_PREFIXES,
		...(Array.isArray(sdkPrefixes)
			? sdkPrefixes.filter((prefix) => typeof prefix === "string" && prefix)
			: []),
	]);
}

/** Classifies a failed result into the shared turn-failure vocabulary
 * (usage_limit | rate_limit | authentication_failed | context_window_exceeded
 * | provider_error) from the SDK's own typed signals first and the CLI's
 * usage-limit result text last. */
function turnFailureReason(message, assistantError, usageLimitPrefixes) {
	if (
		assistantError === "authentication_failed" ||
		assistantError === "oauth_org_not_allowed"
	) {
		return "authentication_failed";
	}
	if (assistantError === "rate_limit") return "rate_limit";
	if (assistantError === "billing_error") return "usage_limit";
	if (message.terminal_reason === "blocking_limit") return "usage_limit";
	if (message.terminal_reason === "prompt_too_long") return "context_window_exceeded";
	const text = typeof message.result === "string" ? message.result : "";
	if (usageLimitPrefixes.some((prefix) => text.startsWith(prefix))) {
		return "usage_limit";
	}
	const status = message.api_error_status;
	if (status === 401 || status === 403) return "authentication_failed";
	if (status === 429) return "rate_limit";
	return "provider_error";
}

function object(value, reason) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw adapterError(reason);
	}
	return value;
}

function timeout(value, fallback, reason) {
	value ??= fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
		throw adapterError(reason);
	}
	return value;
}

function boundedString(value, reason, { nullable = false } = {}) {
	if (nullable && value === null) return null;
	if (
		typeof value !== "string" ||
		value.includes("\0") ||
		Buffer.byteLength(value, "utf8") > MAX_METADATA_STRING_BYTES
	) {
		throw adapterError(reason);
	}
	return value;
}

function exactVersion(value, reason) {
	if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/u.test(value)) {
		throw adapterError(reason);
	}
	return value;
}

function operationToken(value, reason) {
	value = boundedString(value, reason);
	if (!SAFE_OPERATION_TOKEN.test(value)) throw adapterError(reason);
	return value;
}

function jsonValue(value, reason) {
	try {
		const source = JSON.stringify(value);
		if (typeof source !== "string") throw adapterError(reason);
		return JSON.parse(source);
	} catch (error) {
		if (error?.code === "DURE_CLAUDE_AGENT_SDK_CONTRACT") throw error;
		throw adapterError(reason);
	}
}

function fitToolEventPayload(kind, payload) {
	const candidates =
		kind === "tool_result"
			? [
					payload,
					{ ...payload, input: null },
					{ ...payload, output: null },
					{ ...payload, input: null, output: null },
				]
			: [payload, { ...payload, input: null }];
	for (const candidate of candidates) {
		if (fitsSharedClaudeSdkHostEvent(kind, candidate)) {
			return Object.freeze(candidate);
		}
	}
	throw adapterError("tool_event_too_large");
}

function toolResultError(value) {
	if (value === undefined) return false;
	if (typeof value !== "boolean") throw adapterError("tool_result_error_invalid");
	return value;
}

function deferred() {
	let reject;
	let resolve;
	let settled = false;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		reject = (error) => {
			if (settled) return;
			settled = true;
			rejectPromise(error);
		};
		resolve = (value) => {
			if (settled) return;
			settled = true;
			resolvePromise(value);
		};
	});
	return { promise, reject, resolve };
}

function withTimeout(promise, milliseconds, reason) {
	let timer;
	const expired = new Promise((_, reject) => {
		timer = setTimeout(() => reject(adapterError(reason)), milliseconds);
		timer.unref?.();
	});
	return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function sdkPromptUuid(identity, clientMessageId) {
	const bytes = createHash("sha256")
		.update(identity.runtimeGeneration, "utf8")
		.update("\0", "utf8")
		.update(identity.queryEpoch, "utf8")
		.update("\0", "utf8")
		.update(clientMessageId, "utf8")
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x80;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function streamText(value, reason, maxBytes = MAX_STREAM_DELTA_BYTES) {
	if (
		typeof value !== "string" ||
		value.includes("\0") ||
		Buffer.byteLength(value, "utf8") > maxBytes
	) {
		throw adapterError(reason);
	}
	return value;
}

function utf8Fragments(value) {
	value = streamText(value, "stream_delta_invalid");
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= DELTA_FRAGMENT_MAX_BYTES) return [value];
	const fragments = [];
	let offset = 0;
	while (offset < bytes.length) {
		let end = Math.min(offset + DELTA_FRAGMENT_MAX_BYTES, bytes.length);
		if (end < bytes.length) {
			while (end > offset && (bytes[end] & 0xc0) === 0x80) end -= 1;
		}
		if (end === offset) throw adapterError("stream_delta_invalid");
		fragments.push(bytes.subarray(offset, end).toString("utf8"));
		offset = end;
	}
	return fragments;
}

class QueryInput {
	#closed = false;
	#pending;
	#waiter;

	push(value) {
		if (this.#closed) throw adapterError("input_closed");
		if (this.#pending !== undefined) throw adapterError("input_capacity_exceeded");
		if (this.#waiter) {
			const waiter = this.#waiter;
			this.#waiter = undefined;
			waiter({ done: false, value });
			return;
		}
		this.#pending = value;
	}

	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#pending = undefined;
		if (this.#waiter) {
			const waiter = this.#waiter;
			this.#waiter = undefined;
			waiter({ done: true });
		}
	}

	next() {
		if (this.#pending !== undefined) {
			const value = this.#pending;
			this.#pending = undefined;
			return Promise.resolve({ done: false, value });
		}
		if (this.#closed) return Promise.resolve({ done: true });
		if (this.#waiter) return Promise.reject(adapterError("input_reader_conflict"));
		return new Promise((resolve) => {
			this.#waiter = resolve;
		});
	}

	[Symbol.asyncIterator]() {
		return this;
	}
}

function queryBinding(value) {
	value = object(value, "binding_invalid");
	const processBinding = object(value.process, "process_binding_required");
	if (
		typeof processBinding.relayEndpoint !== "string" ||
		!processBinding.relayEndpoint.startsWith("/") ||
		processBinding.relayEndpoint.includes("\0") ||
		typeof processBinding.relayCapability !== "string" ||
		processBinding.relayCapability.length < 16 ||
		processBinding.relayCapability.length > 256 ||
		/[\u0000-\u001f\u007f]/u.test(processBinding.relayCapability)
	) {
		throw adapterError("relay_binding_invalid");
	}
	return value;
}

function sdkEnvironment(binding, sdkVersion) {
	if (
		Object.hasOwn(binding.env, "CLAUDE_AGENT_SDK_VERSION") ||
		Object.hasOwn(binding.env, "CLAUDE_CODE_ENTRYPOINT") ||
		(Object.hasOwn(binding.env, "DISABLE_AUTOUPDATER") &&
			binding.env.DISABLE_AUTOUPDATER !== "1")
	) {
		throw adapterError("reserved_environment_conflict");
	}
	return Object.freeze({
		...binding.env,
		CLAUDE_AGENT_SDK_VERSION: sdkVersion,
		CLAUDE_CODE_ENTRYPOINT: SDK_ENTRYPOINT,
		DISABLE_AUTOUPDATER: "1",
	});
}

function validateLaunchEnvironment(value, expected) {
	value = object(value, "spawn_environment_invalid");
	for (const [key, expectedValue] of Object.entries(expected)) {
		if (value[key] !== expectedValue) throw adapterError("spawn_environment_mismatch");
	}
	for (const [key, entry] of Object.entries(value)) {
		const addedBySdk = !Object.hasOwn(expected, key);
		if (addedBySdk && !SDK_ADDED_ENVIRONMENT_KEYS.has(key)) {
			throw adapterError("spawn_environment_mismatch");
		}
		if (
			typeof entry !== "string" ||
			entry.includes("\0") ||
			(addedBySdk && Buffer.byteLength(entry, "utf8") > MAX_TRACE_CONTEXT_BYTES)
		) {
			throw adapterError("spawn_environment_invalid");
		}
	}
}

function validateSpawnOptions(value, binding, expectedEnvironment, runtime) {
	value = object(value, "spawn_options_invalid");
	if (value.command !== runtime.executablePath) {
		throw adapterError("spawn_command_mismatch");
	}
	if (value.cwd !== binding.cwd) throw adapterError("spawn_cwd_mismatch");
	if (!Array.isArray(value.args) || value.args.length > MAX_LAUNCH_ARGUMENTS) {
		throw adapterError("spawn_arguments_invalid");
	}
	let argumentBytes = 0;
	for (const argument of value.args) {
		if (typeof argument !== "string" || argument.includes("\0")) {
			throw adapterError("spawn_arguments_invalid");
		}
		const bytes = Buffer.byteLength(argument, "utf8");
		if (bytes > MAX_LAUNCH_ARGUMENT_BYTES) throw adapterError("spawn_arguments_invalid");
		argumentBytes += bytes;
	}
	if (argumentBytes > MAX_LAUNCH_ARGUMENT_TOTAL_BYTES) {
		throw adapterError("spawn_arguments_invalid");
	}
	if (!value.signal || typeof value.signal.addEventListener !== "function") {
		throw adapterError("spawn_signal_invalid");
	}
	validateLaunchEnvironment(value.env, expectedEnvironment);
	return value;
}

function validateSpawnedProcess(value) {
	if (
		!value ||
		typeof value !== "object" ||
		!value.stdin ||
		!value.stdout ||
		typeof value.kill !== "function" ||
		typeof value.once !== "function" ||
		typeof value.off !== "function"
	) {
		throw adapterError("spawned_process_invalid");
	}
	return value;
}

function resultSummary(message, sdkUserMessageId, assistantError, usageLimitPrefixes) {
	const isError = message.is_error === true || message.subtype !== "success";
	const number = (value, reason) => {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw adapterError(reason);
		}
		return value;
	};
	const integer = (value, reason) => {
		if (!Number.isSafeInteger(value) || value < 0) throw adapterError(reason);
		return value;
	};
	if (
		message.user_message_uuid !== undefined &&
		message.user_message_uuid !== sdkUserMessageId
	) {
		throw adapterError("result_message_identity_mismatch");
	}
	return Object.freeze({
		durationApiMs: number(message.duration_api_ms, "result_duration_invalid"),
		durationMs: number(message.duration_ms, "result_duration_invalid"),
		// Present only on failure, so a successful summary keeps its shape.
		...(isError
			? {
					failureReason: turnFailureReason(
						message,
						assistantError,
						usageLimitPrefixes,
					),
				}
			: {}),
		isError,
		numTurns: integer(message.num_turns, "result_turn_count_invalid"),
		providerSessionId: boundedString(message.session_id, "provider_session_id_invalid"),
		sdkUserMessageId,
		stopReason: boundedString(message.stop_reason, "result_stop_reason_invalid", {
			nullable: true,
		}),
		subtype: boundedString(message.subtype, "result_subtype_invalid"),
		totalCostUsd: number(message.total_cost_usd, "result_cost_invalid"),
	});
}

function mainToolResultBlocks(message) {
	if (message.parent_tool_use_id !== null || message.isReplay === true) return [];
	const content = message.message?.content;
	return Array.isArray(content)
		? content.filter(
				(block) =>
					block &&
					typeof block === "object" &&
					!Array.isArray(block) &&
					block.type === "tool_result",
			)
		: [];
}

function interruptMessageIds(value, reason) {
	if (!Array.isArray(value) || value.length > 128) throw adapterError(reason);
	return Object.freeze(
		value.map((messageId) => {
			messageId = boundedString(messageId, reason, { nullable: false });
			if (!SAFE_OPERATION_TOKEN.test(messageId)) throw adapterError(reason);
			return messageId;
		}),
	);
}

function interruptReceipt(value) {
	if (value === undefined) {
		return Object.freeze({
			cancelledMessageIds: Object.freeze([]),
			receiptAvailable: false,
			stillQueuedMessageIds: Object.freeze([]),
		});
	}
	value = object(value, "interrupt_receipt_invalid");
	return Object.freeze({
		cancelledMessageIds:
			value.cancelled === undefined
				? Object.freeze([])
				: interruptMessageIds(value.cancelled, "interrupt_receipt_invalid"),
		receiptAvailable: true,
		stillQueuedMessageIds: interruptMessageIds(
			value.still_queued,
			"interrupt_receipt_invalid",
		),
	});
}

export function createClaudeAgentSdkQueryFactory({
	claudeCodeVersion,
	closeTimeoutMs,
	createRelaySpawner = createClaudeRelaySpawner,
	initializationTimeoutMs,
	runtimeArtifact,
	sdkVersion,
	startup,
	usageLimitErrorPrefixes = [],
} = {}) {
	const usageLimitPrefixes = usageLimitResultPrefixes(usageLimitErrorPrefixes);
	claudeCodeVersion = exactVersion(claudeCodeVersion, "claude_code_version_invalid");
	sdkVersion = exactVersion(sdkVersion, "sdk_version_invalid");
	const configuredRuntime = claudeRuntimeArtifactDescriptor(runtimeArtifact);
	if (
		configuredRuntime.claudeCodeVersion !== claudeCodeVersion ||
		configuredRuntime.sdkVersion !== sdkVersion
	) {
		throw adapterError("runtime_version_mismatch");
	}
	initializationTimeoutMs = timeout(
		initializationTimeoutMs,
		DEFAULT_INITIALIZATION_TIMEOUT_MS,
		"initialization_timeout_invalid",
	);
	closeTimeoutMs = timeout(closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, "close_timeout_invalid");
	if (typeof startup !== "function") throw adapterError("startup_export_required");
	if (typeof createRelaySpawner !== "function") throw adapterError("relay_spawner_required");

	return async ({ binding: rawBinding, emit, signal, terminal }) => {
		const binding = queryBinding(rawBinding);
		const runtime = attestClaudeRuntimeArtifact(runtimeArtifact);
		if (typeof emit !== "function" || typeof terminal !== "function") {
			throw adapterError("host_callbacks_invalid");
		}
		if (!signal || typeof signal.addEventListener !== "function") {
			throw adapterError("host_signal_invalid");
		}

		const input = new QueryInput();
		const exited = deferred();
		const abortController = new AbortController();
		const environment = sdkEnvironment(binding, sdkVersion);
		const relaySpawner = createRelaySpawner({
			endpoint: binding.process.relayEndpoint,
			identity: binding.identity,
			launchCapability: binding.process.relayCapability,
		});
		if (typeof relaySpawner !== "function") throw adapterError("relay_spawner_invalid");

		let activeTurn;
		let closing = false;
		let initialized = false;
		let providerSessionId = binding.providerSessionId;
		let sdkQuery;
		let spawnedProcess;
		let stopPromise;
		let streamMessageId = null;
		let terminalDelivered = false;
		let warmQuery;
		const interactions = createClaudeQueryInteractionBroker({
			activeTurn: () => activeTurn,
			emit,
			identity: binding.identity,
		});

		const rejectActiveTurn = (error) => {
			if (!activeTurn) return;
			const turn = activeTurn;
			activeTurn = undefined;
			turn.reject(error);
		};
		const deliverTerminal = (value) => {
			if (terminalDelivered) return;
			terminalDelivered = true;
			interactions.cancelAll("query_exited", { emitEvents: !signal.aborted });
			rejectActiveTurn(adapterError("query_exited_during_turn"));
			try {
				terminal(value);
			} finally {
				exited.resolve(value);
			}
		};
		const processExit = (code, exitSignal) => {
			if ((code === null) === (exitSignal === null)) {
				deliverTerminal({ reason: "process_exit_invalid" });
				return;
			}
			deliverTerminal({ code, signal: exitSignal });
		};
		const processError = () => deliverTerminal({ reason: "relay_transport_error" });
		const spawnClaudeCodeProcess = (options) => {
			if (spawnedProcess) throw adapterError("spawn_repeated");
			validateSpawnOptions(options, binding, environment, runtime);
			spawnedProcess = validateSpawnedProcess(
				relaySpawner({
					...options,
					commandIdentity: runtime.executableIdentity,
				}),
			);
			spawnedProcess.once("exit", processExit);
			spawnedProcess.once("error", processError);
			return spawnedProcess;
		};

		const validateSession = (message) => {
			if (message.session_id === undefined) return;
			const sessionId = boundedString(message.session_id, "provider_session_id_invalid");
			if (providerSessionId !== null && providerSessionId !== sessionId) {
				throw adapterError("provider_session_id_mismatch");
			}
			providerSessionId = sessionId;
		};
		const emitFragments = (kind, text, payload) => {
			const fragments = utf8Fragments(text);
			for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex += 1) {
				emit(kind, {
					...payload,
					finalFragment: fragmentIndex === fragments.length - 1,
					fragmentIndex,
					text: fragments[fragmentIndex],
				});
			}
		};
		const handleStreamEvent = (message) => {
			const event = object(message.event, "stream_event_invalid");
			switch (event.type) {
				case "message_start": {
					const providerMessage = object(event.message, "stream_message_start_invalid");
					streamMessageId = boundedString(
						providerMessage.id,
						"provider_message_id_invalid",
					);
					if (activeTurn && message.parent_tool_use_id === null) {
						activeTurn.finalAssistantTextBlock = null;
					}
					break;
				}
				case "content_block_start": {
					if (!Number.isSafeInteger(event.index) || event.index < 0) {
						throw adapterError("stream_block_index_invalid");
					}
					const contentBlock = object(event.content_block, "stream_content_block_invalid");
					if (activeTurn && message.parent_tool_use_id === null) {
						if (contentBlock.type === "text") {
							activeTurn.finalAssistantTextBlock = {
								blockIndex: event.index,
								providerMessageId: streamMessageId,
								textObserved: false,
							};
							if (contentBlock.text !== "") {
								emitFragments("assistant_delta", contentBlock.text, {
									blockIndex: event.index,
									parentToolUseId: null,
									providerMessageId: streamMessageId,
								});
								activeTurn.finalAssistantTextBlock.textObserved = true;
							}
						} else {
							activeTurn.finalAssistantTextBlock = null;
						}
					}
					break;
				}
				case "content_block_delta": {
					const delta = object(event.delta, "stream_delta_invalid");
					if (!Number.isSafeInteger(event.index) || event.index < 0) {
						throw adapterError("stream_block_index_invalid");
					}
					const common = {
						blockIndex: event.index,
						parentToolUseId:
							message.parent_tool_use_id === null
								? null
								: boundedString(message.parent_tool_use_id, "parent_tool_use_id_invalid"),
						providerMessageId: streamMessageId,
					};
					if (delta.type === "text_delta") {
						emitFragments("assistant_delta", delta.text, common);
						if (activeTurn && common.parentToolUseId === null) {
							if (
								!activeTurn.finalAssistantTextBlock ||
								activeTurn.finalAssistantTextBlock.providerMessageId !==
									common.providerMessageId ||
								activeTurn.finalAssistantTextBlock.blockIndex !== event.index
							) {
								activeTurn.finalAssistantTextBlock = {
									blockIndex: event.index,
									providerMessageId: common.providerMessageId,
									textObserved: false,
								};
							}
							if (delta.text.length > 0) {
								activeTurn.finalAssistantTextBlock.textObserved = true;
							}
						}
					} else if (delta.type === "thinking_delta") {
						emitFragments("reasoning_delta", delta.thinking, common);
					}
					break;
				}
				case "message_stop":
					streamMessageId = null;
					break;
				default:
					break;
			}
		};
		const handleMessage = (rawMessage) => {
			const message = object(rawMessage, "message_invalid");
			boundedString(message.type, "message_type_invalid");
			validateSession(message);
			if (message.type === "system" && message.subtype === "init") {
				if (!spawnedProcess) throw adapterError("initialize_before_spawn");
				if (message.cwd !== binding.cwd) throw adapterError("initialize_cwd_mismatch");
				if (message.claude_code_version !== claudeCodeVersion) {
					throw adapterError("initialize_claude_code_version_mismatch");
				}
				const snapshot = Object.freeze({
					apiKeySource: boundedString(message.apiKeySource, "initialize_api_key_source_invalid"),
					claudeCodeVersion,
					cwd: binding.cwd,
					model: boundedString(message.model, "initialize_model_invalid"),
					permissionMode: boundedString(
						message.permissionMode,
						"initialize_permission_mode_invalid",
					),
					providerSessionId,
				});
				emit("provider_session_initialized", snapshot);
				initialized = true;
				// The provider owns which models and efforts exist; publish its
				// catalog as durable evidence so pickers never depend on a local
				// hardcoded list. Resolves from the cached initialize handshake.
				void Promise.resolve()
					.then(() =>
						typeof sdkQuery?.supportedModels === "function"
							? sdkQuery.supportedModels()
							: undefined,
					)
					.then((models) => {
						if (!Array.isArray(models) || models.length === 0) return;
						const catalog = models.slice(0, 32).flatMap((model) => {
							if (!model || typeof model !== "object") return [];
							const value = typeof model.value === "string" ? model.value : null;
							if (!value) return [];
							return [
								{
									value,
									...(typeof model.resolvedModel === "string"
										? { resolvedModel: model.resolvedModel }
										: {}),
									displayName:
										typeof model.displayName === "string"
											? model.displayName
											: value,
									supportsEffort: model.supportsEffort === true,
									supportedEffortLevels: Array.isArray(
										model.supportedEffortLevels,
									)
										? model.supportedEffortLevels.filter(
												(level) => typeof level === "string",
											)
										: [],
								},
							];
						});
						if (catalog.length > 0) {
							emit("provider_catalog", { models: catalog });
						}
					})
					.catch(() => {});
				// ultracode rides the session settings channel, not the effort
				// flag: xhigh was already applied at spawn, and the standing
				// orchestration mode follows once the session is live.
				if (binding.effort === "ultracode") {
					void Promise.resolve()
						.then(() =>
							typeof sdkQuery?.applyFlagSettings === "function"
								? sdkQuery.applyFlagSettings({ ultracode: true })
								: undefined,
						)
						.catch(() => {});
				}
				return;
			}
			if (message.type === "stream_event") {
				handleStreamEvent(message);
				return;
			}
			if (message.type === "assistant") {
				const providerMessage = object(message.message, "assistant_message_invalid");
				if (!Array.isArray(providerMessage.content)) {
					throw adapterError("assistant_content_invalid");
				}
				const providerMessageId = boundedString(
					providerMessage.id,
					"provider_message_id_invalid",
				);
				const parentToolUseId =
					message.parent_tool_use_id === null
						? null
						: boundedString(message.parent_tool_use_id, "parent_tool_use_id_invalid");
				if (activeTurn && parentToolUseId === null) {
					for (const block of providerMessage.content) {
						if (
							!block ||
							typeof block !== "object" ||
							Array.isArray(block) ||
							block.type !== "tool_use"
						) {
							continue;
						}
						const toolCallId = operationToken(block.id, "tool_call_id_invalid");
						if (
							!activeTurn.tools.has(toolCallId) &&
							activeTurn.tools.size >= MAX_ACTIVE_TOOL_CALLS
						) {
							throw adapterError("active_tool_limit_exceeded");
						}
						const started = fitToolEventPayload("tool_started", {
							input: jsonValue(block.input, "tool_input_invalid"),
							name: boundedString(block.name, "tool_name_invalid"),
							parentToolUseId: null,
							providerMessageId,
							toolCallId,
						});
						const tool = Object.freeze({
							input: started.input,
							name: started.name,
							providerMessageId,
						});
						activeTurn.tools.set(toolCallId, tool);
						emit("tool_started", started);
					}
				}
				// The SDK's per-message error enum is the strongest signal for why
				// the turn is about to fail; the result message repeats none of it.
				// Only the main thread's newest message counts: a subagent's or an
				// earlier retried failure must not label an unrelated stop.
				if (activeTurn && parentToolUseId === null) {
					activeTurn.lastAssistantError =
						typeof message.error === "string" ? message.error : undefined;
				}
				emit("assistant_message_completed", {
					blockCount: providerMessage.content.length,
					error:
						message.error === undefined
							? null
							: boundedString(message.error, "assistant_error_invalid"),
					parentToolUseId,
					providerMessageId,
					providerSessionId,
				});
				return;
			}
			if (message.type === "user" && activeTurn) {
				const resultBlocks = mainToolResultBlocks(message);
				if (resultBlocks.length > 0) {
					activeTurn.finalAssistantTextBlock = null;
					const resultOverride =
						resultBlocks.length === 1 && message.tool_use_result !== undefined
							? jsonValue(message.tool_use_result, "tool_output_invalid")
							: undefined;
					const completed = resultBlocks.map((block) => {
						const toolCallId = operationToken(block.tool_use_id, "tool_call_id_invalid");
						const tool = activeTurn.tools.get(toolCallId);
						if (!tool) throw adapterError("tool_result_without_start");
						return fitToolEventPayload("tool_result", {
							...tool,
							isError: toolResultError(block.is_error),
							output:
								resultOverride === undefined
									? jsonValue(block.content ?? null, "tool_output_invalid")
									: resultOverride,
							parentToolUseId: null,
							toolCallId,
						});
					});
					for (const result of completed) {
						activeTurn.tools.delete(result.toolCallId);
						emit("tool_result", result);
					}
					return;
				}
			}
			if (message.type === "result") {
				if (!activeTurn) throw adapterError("result_without_turn");
				const turn = activeTurn;
				const summary = resultSummary(
					message,
					turn.sdkUserMessageId,
					turn.lastAssistantError,
					usageLimitPrefixes,
				);
				// Pinned partial streams are complete; result.result fills only an absent final text block.
				if (!summary.isError && turn.finalAssistantTextBlock?.textObserved !== true) {
					const assistantText = streamText(
						message.result,
						"result_text_invalid",
						MAX_CANONICAL_STREAM_TEXT_BYTES,
					);
					// The pinned SDK makes result.result authoritative when the final stream is absent.
					const providerMessageId = `result-${turn.sdkUserMessageId}`;
					if (assistantText.length > 0) {
						emitFragments("assistant_delta", assistantText, {
							blockIndex: 0,
							parentToolUseId: null,
							providerMessageId,
						});
						emit("assistant_message_completed", {
							blockCount: 1,
							error: null,
							parentToolUseId: null,
							providerMessageId,
							providerSessionId,
						});
					}
				}
				activeTurn = undefined;
				emit("provider_turn_result", summary);
				if (summary.isError) {
					const failure = adapterError("turn_failed");
					failure.reason = summary.failureReason;
					turn.reject(failure);
				} else {
					turn.resolve(summary);
				}
				return;
			}
			emit("provider_event", {
				subtype:
					message.subtype === undefined
						? null
						: boundedString(message.subtype, "message_subtype_invalid"),
				type: message.type,
			});
		};

		const hostAbort = () => abortController.abort(signal.reason);
		signal.addEventListener("abort", hostAbort, { once: true });
		if (signal.aborted) hostAbort();

		const skipsPermissions = binding.permissionMode === "skip_permissions";
		// auto_edit keeps the interactive approval channel: edits auto-accept
		// (acceptEdits) while commands still ask through canUseTool.
		const sdkPermissionMode =
			binding.permissionMode === "auto_edit" ? "acceptEdits" : "default";
		const options = {
			abortController,
			...(skipsPermissions
				? {
						allowDangerouslySkipPermissions: true,
						permissionMode: "bypassPermissions",
					}
				: {
						canUseTool: interactions.canUseTool,
						permissionMode: sdkPermissionMode,
					}),
			cwd: binding.cwd,
			env: environment,
			...(binding.effort
				? { effort: binding.effort === "ultracode" ? "xhigh" : binding.effort }
				: {}),
			forwardSubagentText: false,
			includeHookEvents: false,
			includePartialMessages: true,
			...(binding.model ? { model: binding.model } : {}),
			pathToClaudeCodeExecutable: runtime.executablePath,
			persistSession: true,
			...(binding.providerSessionId === null
				? {}
				: { resume: binding.providerSessionId }),
			settingSources: ["user", "project", "local"],
			spawnClaudeCodeProcess,
			systemPrompt: {
				preset: "claude_code",
				type: "preset",
				...(binding.instructions ? { append: binding.instructions } : {}),
			},
		};
		try {
			warmQuery = await startup({
				initializeTimeoutMs: initializationTimeoutMs,
				options,
			});
			if (
				!warmQuery ||
				typeof warmQuery !== "object" ||
				typeof warmQuery.query !== "function" ||
				typeof warmQuery.close !== "function"
			) {
				throw adapterError("warm_query_invalid");
			}
			sdkQuery = warmQuery.query(input);
			if (
				!sdkQuery ||
				typeof sdkQuery !== "object" ||
				typeof sdkQuery[Symbol.asyncIterator] !== "function" ||
				typeof sdkQuery.close !== "function" ||
				typeof sdkQuery.interrupt !== "function"
			) {
				throw adapterError("query_invalid");
			}
		} catch (error) {
			signal.removeEventListener("abort", hostAbort);
			abortController.abort(error);
			if (!sdkQuery && typeof warmQuery?.close === "function") {
				try {
					warmQuery.close();
				} catch {
					// Preserve the startup or Query construction failure.
				}
			}
			if (spawnedProcess && !terminalDelivered) {
				try {
					spawnedProcess.kill("SIGTERM");
				} catch {
					// Preserve the Query construction failure.
				}
			}
			throw error;
		}

		const pump = (async () => {
			try {
				for await (const message of sdkQuery) {
					if (terminalDelivered) break;
					handleMessage(message);
				}
				if (!closing && !terminalDelivered) {
					throw adapterError(initialized ? "stream_ended" : "initialize_stream_ended");
				}
			} catch (error) {
				rejectActiveTurn(adapterError("stream_failed"));
				if (!terminalDelivered) deliverTerminal({ reason: "sdk_stream_failed" });
				abortController.abort(error);
				try {
					sdkQuery.close();
				} catch {
					// The typed stream failure remains authoritative.
				}
			}
		})();

		const stop = () => {
			if (stopPromise) return stopPromise;
			stopPromise = (async () => {
				closing = true;
				interactions.cancelAll("query_close", { emitEvents: !signal.aborted });
				input.close();
				abortController.abort("query_close");
				try {
					sdkQuery.close();
				} catch (error) {
					if (!terminalDelivered) throw error;
				}
				await withTimeout(exited.promise, closeTimeoutMs, "close_timeout");
				await pump;
				return exited.promise;
			})().finally(() => signal.removeEventListener("abort", hostAbort));
			return stopPromise;
		};

		return Object.freeze({
			answerInteraction: interactions.answerInteraction,
			close: stop,
			async interruptTurn({ clientMessageId, interruptRequestId }) {
				if (closing || terminalDelivered) throw adapterError("query_closed");
				boundedString(clientMessageId, "client_message_id_invalid");
				if (
					typeof interruptRequestId !== "string" ||
					!SAFE_OPERATION_TOKEN.test(interruptRequestId)
				) {
					throw adapterError("interrupt_request_id_invalid");
				}
				const turn = activeTurn;
				if (!turn || turn.clientMessageId !== clientMessageId) {
					throw adapterError("stale_turn_identity");
				}
				if (!turn.interruptPromise) {
					turn.interruptPromise = Promise.resolve()
						.then(() => sdkQuery.interrupt())
						.then((value) => {
							const receipt = interruptReceipt(value);
							emit("provider_turn_interrupt_acknowledged", {
								clientMessageId,
								interruptRequestId,
								...receipt,
							});
							return receipt;
						});
				}
				return turn.interruptPromise;
			},
			invalidate: stop,
			pendingInteractionCount: interactions.pendingInteractionCount,
			pendingInteractions: interactions.pendingInteractions,
			steerTurn({ clientMessageId, input: steerInput }) {
				if (closing || terminalDelivered) throw adapterError("query_closed");
				if (!activeTurn) throw adapterError("turn_not_running");
				boundedString(clientMessageId, "client_message_id_invalid");
				if (typeof steerInput !== "string") throw adapterError("turn_input_invalid");
				// The CLI reads the same streaming input the turns ride; a user
				// message pushed mid-turn is queued by the provider itself and
				// applied at its next tool boundary.
				input.push(
					Object.freeze({
						message: Object.freeze({
							content: Object.freeze([
								Object.freeze({ text: steerInput, type: "text" }),
							]),
							role: "user",
						}),
						parent_tool_use_id: null,
						session_id: providerSessionId ?? "",
						type: "user",
						uuid: sdkPromptUuid(binding.identity, clientMessageId),
					}),
				);
			},
			startTurn({ clientMessageId, input: turnInput }) {
				if (closing || terminalDelivered) throw adapterError("query_closed");
				if (activeTurn) throw adapterError("turn_overlap");
				boundedString(clientMessageId, "client_message_id_invalid");
				if (typeof turnInput !== "string") throw adapterError("turn_input_invalid");
				const completion = deferred();
				const sdkUserMessageId = sdkPromptUuid(binding.identity, clientMessageId);
				activeTurn = {
					...completion,
					clientMessageId,
					finalAssistantTextBlock: null,
					sdkUserMessageId,
					tools: new Map(),
				};
				try {
					input.push(
						Object.freeze({
							message: Object.freeze({
								content: Object.freeze([
									Object.freeze({ text: turnInput, type: "text" }),
								]),
								role: "user",
							}),
							parent_tool_use_id: null,
							session_id: providerSessionId ?? "",
							type: "user",
							uuid: sdkUserMessageId,
						}),
					);
				} catch (error) {
					activeTurn = undefined;
					throw error;
				}
				return completion.promise;
			},
		});
	};
}
