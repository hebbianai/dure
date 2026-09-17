import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createClaudeAgentSdkQueryFactory } from "./agent-sdk-query.mjs";
import {
	claudeRuntimeArtifactDescriptor,
	claudeRuntimeTarget,
	installClaudeRuntimeArtifact,
} from "./claude-runtime-artifact.mjs";
import { loadPinnedClaudeSdkRuntime } from "./sdk-runtime.mjs";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const DCH1_EVENT_MAX_BYTES = 64 * 1024;
const runtimeFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dure-agent-sdk-runtime-"));
fs.chmodSync(runtimeFixtureRoot, 0o700);
const runtimeArtifact = await installClaudeRuntimeArtifact({
	claudeCodeVersion: "2.1.234",
	runtimeRoot: path.join(runtimeFixtureRoot, "managed"),
	sdkVersion: "0.3.234",
	sourceExecutable: path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../tests/fixtures/fake-claude-agent-sdk-cli.mjs",
	),
	target: claudeRuntimeTarget(),
});
const runtimeDescriptor = claudeRuntimeArtifactDescriptor(runtimeArtifact);
test.after(() => fs.rmSync(runtimeFixtureRoot, { force: true, recursive: true }));

class AsyncQueue {
	#done = false;
	#error;
	#values = [];
	#waiters = [];

	push(value) {
		if (this.#done) throw new Error("async_queue_push_after_close");
		const waiter = this.#waiters.shift();
		if (waiter) waiter.resolve({ done: false, value });
		else this.#values.push(value);
	}

	close() {
		if (this.#done) return;
		this.#done = true;
		for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true });
	}

	fail(error) {
		if (this.#done) return;
		this.#done = true;
		this.#error = error;
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
	}

	next() {
		if (this.#values.length > 0) return Promise.resolve({ done: false, value: this.#values.shift() });
		if (this.#error) return Promise.reject(this.#error);
		if (this.#done) return Promise.resolve({ done: true });
		return new Promise((resolve, reject) => this.#waiters.push({ reject, resolve }));
	}

	[Symbol.asyncIterator]() {
		return this;
	}
}

class FakeSpawnedProcess extends EventEmitter {
	constructor() {
		super();
		this.stdin = new PassThrough();
		this.stdout = new PassThrough();
		this.killed = false;
		this.exitCode = null;
		this.signalCode = null;
	}

	kill(signal) {
		if (this.exitCode !== null || this.signalCode !== null) return false;
		this.killed = true;
		this.exit(null, signal);
		return true;
	}

	exit(code, signal) {
		if (this.exitCode !== null || this.signalCode !== null) return;
		this.exitCode = code;
		this.signalCode = signal;
		queueMicrotask(() => this.emit("exit", code, signal));
	}
}

function binding(index = 1, providerSessionId = SESSION_ID) {
	return Object.freeze({
		cwd: `/workspace/claude-${index}`,
		env: Object.freeze({
			CLAUDE_CONFIG_DIR: `/credentials/claude-${index}`,
			DURE_CREDENTIAL_SENTINEL: `profile-${index}`,
			HOME: `/home/claude-${index}`,
			PATH: "/usr/bin:/bin",
		}),
		identity: Object.freeze({
			relayId: `relay-${index}`,
			queryEpoch: `query-${index}`,
			runtimeGeneration: `runtime-${index}`,
		}),
		process: Object.freeze({
			args: Object.freeze([]),
			command: `/opt/dure/claude-${index}`,
			relayCapability: `relay-capability-${index}-0123456789`,
			relayEndpoint: `/private/tmp/dure-relay-${index}.sock`,
		}),
		providerSessionId,
	});
}

function initializationMessage(prepared) {
	return {
		apiKeySource: "none",
		claude_code_version: "2.1.234",
		cwd: prepared.cwd,
		mcp_servers: [],
		model: "claude-sonnet-4-6",
		output_style: "default",
		permissionMode: "default",
		plugins: [],
		session_id: SESSION_ID,
		skills: [],
		slash_commands: [],
		subtype: "init",
		tools: [],
		type: "system",
		uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
	};
}

function successResult(sdkUserMessageId, result = "hello from Claude") {
	return {
		duration_api_ms: 7,
		duration_ms: 11,
		is_error: false,
		modelUsage: {},
		num_turns: 1,
		permission_denials: [],
		result,
		session_id: SESSION_ID,
		stop_reason: "end_turn",
		subtype: "success",
		total_cost_usd: 0.01,
		type: "result",
		usage: {},
		user_message_uuid: sdkUserMessageId,
		uuid: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
	};
}

function errorResult(secret) {
	return {
		duration_api_ms: 5,
		duration_ms: 8,
		errors: [`provider failed with ${secret}`],
		is_error: true,
		modelUsage: {},
		num_turns: 1,
		permission_denials: [],
		session_id: SESSION_ID,
		stop_reason: null,
		subtype: "error_during_execution",
		terminal_reason: "api_error",
		total_cost_usd: 0,
		type: "result",
		usage: {},
		uuid: "cccccccc-dddd-4eee-8fff-000000000000",
	};
}

function createRelaySpawnerProbe(observations) {
	return (configuration) => {
		observations.relayConfigurations.push(configuration);
		return (options) => {
			observations.spawnOptions.push(options);
			const child = new FakeSpawnedProcess();
			observations.children.push(child);
			return child;
		};
	};
}

function pushAssistantMessage(
	output,
	{
		delta,
		providerMessageId,
		toolInput = { file_path: "README.md" },
		toolUse = false,
		trailingText = null,
	},
) {
	output.push({
		event: {
			message: { id: providerMessageId, model: "claude-sonnet-4-6" },
			type: "message_start",
		},
		parent_tool_use_id: null,
		session_id: SESSION_ID,
		type: "stream_event",
		uuid: "dddddddd-eeee-4fff-8000-111111111111",
	});
	const blocks = [{ text: delta, type: "text" }];
	if (toolUse) {
		blocks.push({
			id: "tool-use-1",
			input: toolInput,
			name: "Read",
			type: "tool_use",
		});
	}
	if (trailingText !== null) {
		blocks.push({ text: trailingText, type: "text" });
	}
	for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
		const block = blocks[blockIndex];
		output.push({
			event: {
				content_block:
					block.type === "text" ? { text: "", type: "text" } : { ...block, input: {} },
				index: blockIndex,
				type: "content_block_start",
			},
			parent_tool_use_id: null,
			session_id: SESSION_ID,
			type: "stream_event",
			uuid: "eeeeeeee-ffff-4000-8111-222222222220",
		});
		if (block.type === "text") {
			output.push({
				event: {
					delta: { text: block.text, type: "text_delta" },
					index: blockIndex,
					type: "content_block_delta",
				},
				parent_tool_use_id: null,
				session_id: SESSION_ID,
				type: "stream_event",
				uuid: "eeeeeeee-ffff-4000-8111-222222222222",
			});
		} else {
			output.push({
				event: {
					delta: {
						partial_json: JSON.stringify(block.input),
						type: "input_json_delta",
					},
					index: blockIndex,
					type: "content_block_delta",
				},
				parent_tool_use_id: null,
				session_id: SESSION_ID,
				type: "stream_event",
				uuid: "eeeeeeee-ffff-4000-8111-222222222223",
			});
		}
		output.push({
			event: { index: blockIndex, type: "content_block_stop" },
			parent_tool_use_id: null,
			session_id: SESSION_ID,
			type: "stream_event",
			uuid: "eeeeeeee-ffff-4000-8111-222222222224",
		});
		output.push({
			message: {
				content: [block],
				id: providerMessageId,
				model: "claude-sonnet-4-6",
				role: "assistant",
				stop_reason: null,
				usage: {},
			},
			parent_tool_use_id: null,
			session_id: SESSION_ID,
			type: "assistant",
			uuid: "ffffffff-0000-4111-8222-333333333333",
		});
	}
	output.push({
		event: { type: "message_stop" },
		parent_tool_use_id: null,
		session_id: SESSION_ID,
		type: "stream_event",
		uuid: "eeeeeeee-ffff-4000-8111-222222222226",
	});
}

function scriptedQuery(
	observations,
	{
		assistantMessages = true,
		delta = "hello from Claude",
		initializationAfterInput = false,
		result,
		resultError,
		resultPatch = null,
		spawnEnvironment = {},
		trailingText = null,
		toolPreamble = null,
		toolInput = { file_path: "README.md" },
		toolResult = {},
		toolResultError = false,
		supportedModels = null,
	} = {},
) {
	return ({ prompt, options }) => {
		observations.queryOptions.push(options);
		const output = new AsyncQueue();
		const child = options.spawnClaudeCodeProcess({
			args: [],
			command: options.pathToClaudeCodeExecutable,
			cwd: options.cwd,
				env: {
					...options.env,
					CLAUDE_AGENT_SDK_VERSION: "0.3.234",
					CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
					...spawnEnvironment,
				},
			signal: new AbortController().signal,
		});
		let closed = false;
		if (!initializationAfterInput) {
			queueMicrotask(() => output.push(initializationMessage(observations.bindings.at(-1))));
		}
		void (async () => {
			for await (const message of prompt) {
				observations.inputs.push(message);
				if (initializationAfterInput) {
					output.push(initializationMessage(observations.bindings.at(-1)));
				}
				if (resultError) {
					output.push(errorResult(resultError));
					continue;
				}
				if (toolPreamble !== null) {
					pushAssistantMessage(output, {
						delta: toolPreamble,
						providerMessageId: "message-preamble",
						toolInput,
						toolUse: true,
					});
					const resultContent = Object.hasOwn(toolResult, "content")
						? toolResult.content
						: toolResultError
							? "read failed"
							: "tool output";
					const toolResultMessage = {
						message: {
							content: [
								{
									...(toolResult.omitContent ? {} : { content: resultContent }),
									...(Object.hasOwn(toolResult, "isError")
										? { is_error: toolResult.isError }
										: toolResultError
											? { is_error: true }
											: {}),
									tool_use_id: "tool-use-1",
									type: "tool_result",
								},
							],
							role: "user",
						},
						parent_tool_use_id: null,
						session_id: SESSION_ID,
						...(Object.hasOwn(toolResult, "shouldQuery")
							? { shouldQuery: toolResult.shouldQuery }
							: {}),
						...(toolResultError
							? {}
							: {
									tool_use_result: Object.hasOwn(toolResult, "override")
										? toolResult.override
										: { bytes: 11, content: "tool output" },
								}),
						type: "user",
						uuid: "aaaaaaaa-0000-4111-8222-333333333333",
					};
					if (toolResult.replayBeforeLive) {
						output.push({
							...toolResultMessage,
							isReplay: true,
							uuid: "aaaaaaaa-0000-4111-8222-333333333332",
						});
					}
					output.push(toolResultMessage);
				}
				if (assistantMessages) {
					pushAssistantMessage(output, {
						delta,
						providerMessageId: "message-1",
						trailingText,
					});
				}
				output.push({
					...successResult(message.uuid, result ?? trailingText ?? delta),
					...(resultPatch ?? {}),
				});
			}
		})().catch((error) => output.fail(error));
		return {
			[Symbol.asyncIterator]() {
				return output;
			},
			close() {
				if (closed) return;
				closed = true;
				observations.closeCalls += 1;
				child.exit(0, null);
				output.close();
			},
			...(supportedModels
				? { supportedModels: async () => supportedModels }
				: {}),
			async applyFlagSettings(settings) {
				(observations.flagSettings ??= []).push(settings);
			},
			async interrupt() {
				observations.interruptCalls += 1;
				return undefined;
			},
		};
	};
}

function observations(prepared) {
	return {
		bindings: [prepared],
		children: [],
		closeCalls: 0,
		events: [],
		inputs: [],
		interactionAbortControllers: [],
		interactionResults: [],
		interruptCalls: 0,
		queryOptions: [],
		relayConfigurations: [],
		spawnOptions: [],
		terminals: [],
	};
}

async function waitForCondition(predicate) {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("agent_sdk_query_condition_timeout");
}

function interactiveQuery(observed) {
	return ({ prompt, options }) => {
		observed.queryOptions.push(options);
		const output = new AsyncQueue();
		const child = options.spawnClaudeCodeProcess({
			args: [],
			command: options.pathToClaudeCodeExecutable,
			cwd: options.cwd,
			env: options.env,
			signal: new AbortController().signal,
		});
		let activeMessage;
		let closed = false;
		let interruptRelease;
		queueMicrotask(() => output.push(initializationMessage(observed.bindings.at(-1))));
		void (async () => {
			for await (const message of prompt) {
				activeMessage = message;
				observed.inputs.push(message);
				const turnInput = message.message.content[0].text;
				if (turnInput === "permission") {
					const interactionAbort = new AbortController();
					observed.interactionAbortControllers.push(interactionAbort);
					observed.interactionResults.push(
						await options.canUseTool(
							"Read",
							{ file_path: "/workspace/secret.txt" },
							{
								blockedPath: "/workspace/secret.txt",
								decisionReason: "outside reviewed roots",
								description: "Claude will read one file",
								displayName: "Read file",
								requestId: "sdk-permission-request-1",
								matchedAskRule: {
									ruleContent: "/workspace/**",
									source: "projectSettings",
									toolName: "Read",
								},
								signal: interactionAbort.signal,
								suggestions: [
									{ destination: "session", mode: "acceptEdits", type: "setMode" },
								],
								title: "Claude wants to read secret.txt",
								toolUseID: "tool-use-read-1",
							},
						),
					);
				} else if (turnInput === "question") {
					const interactionAbort = new AbortController();
					observed.interactionAbortControllers.push(interactionAbort);
					observed.interactionResults.push(
						await options.canUseTool(
							"AskUserQuestion",
							{
								questions: [
									{
										header: "Database",
										multiSelect: false,
										options: [
											{ description: "Use the local database", label: "SQLite" },
											{ description: "Use the server database", label: "Postgres" },
										],
										question: "Which database should we use?",
									},
								],
							},
							{
								requestId: "sdk-question-request-1",
								signal: interactionAbort.signal,
								toolUseID: "tool-use-question-1",
							},
						),
					);
				} else if (turnInput === "interrupt") {
					await new Promise((resolve) => {
						interruptRelease = resolve;
					});
				}
				output.push(successResult(message.uuid));
				activeMessage = undefined;
			}
		})().catch((error) => output.fail(error));
		return {
			[Symbol.asyncIterator]() {
				return output;
			},
			close() {
				if (closed) return;
				closed = true;
				observed.closeCalls += 1;
				child.exit(0, null);
				output.close();
			},
			async interrupt() {
				assert.ok(activeMessage);
				observed.interruptCalls += 1;
				interruptRelease?.();
				return { still_queued: ["queued-user-message-1"] };
			},
		};
	};
}

function scriptedStartup(query) {
	return async ({ options }) =>
		Object.freeze({
			close() {},
			query: (prompt) => query({ options, prompt }),
		});
}

async function createController(prepared, observed, query, factoryOptions = {}) {
	const factory = createClaudeAgentSdkQueryFactory({
		claudeCodeVersion: "2.1.234",
		createRelaySpawner: createRelaySpawnerProbe(observed),
		runtimeArtifact,
		...factoryOptions,
		sdkVersion: "0.3.234",
		startup: scriptedStartup(query),
	});
	return factory({
		binding: prepared,
		emit: (kind, payload) => observed.events.push({ kind, payload }),
		signal: new AbortController().signal,
		terminal: (value) => observed.terminals.push(value),
	});
}

test("conversation instructions append to the preset without changing the human input", async () => {
	for (const providerSessionId of [null, SESSION_ID]) {
		const original = binding(1, providerSessionId);
		const prepared = {
			...original,
			env: { ...original.env, DURE_ORCHESTRATION_HOME: "/backend/current" },
			instructions: "Dure agent ID: agent-a",
		};
		const observed = observations(prepared);
		const controller = await createController(prepared, observed, scriptedQuery(observed));
		assert.equal(observed.spawnOptions[0].env.DURE_ORCHESTRATION_HOME, "/backend/current");
		assert.deepEqual(observed.queryOptions[0].systemPrompt, {
			preset: "claude_code", type: "preset", append: prepared.instructions,
		});
		await controller.startTurn({ clientMessageId: "context-human-message", input: "Work on my goal." });
		assert.deepEqual(observed.inputs[0].message.content, [{ type: "text", text: "Work on my goal." }]);
		await controller.close();
	}
});

test("the attested runtime artifact overrides an untrusted binding command", async () => {
	const prepared = binding();
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, scriptedQuery(observed), {
		runtimeArtifact,
	});

	assert.equal(
		observed.queryOptions[0].pathToClaudeCodeExecutable,
		runtimeDescriptor.executablePath,
	);
	assert.equal(observed.spawnOptions[0].command, runtimeDescriptor.executablePath);
	assert.deepEqual(
		observed.spawnOptions[0].commandIdentity,
		runtimeDescriptor.executableIdentity,
	);
	await controller.close();
});

test("structured launch selections reach the immutable SDK Query options", async () => {
	const prepared = Object.freeze({
		...binding(),
		effort: "high",
		model: "opus",
		permissionMode: "skip_permissions",
	});
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, scriptedQuery(observed));

	assert.equal(observed.queryOptions[0].model, "opus");
	assert.equal(observed.queryOptions[0].effort, "high");
	assert.equal(observed.queryOptions[0].permissionMode, "bypassPermissions");
	assert.equal(observed.queryOptions[0].allowDangerouslySkipPermissions, true);
	assert.equal(Object.hasOwn(observed.queryOptions[0], "canUseTool"), false);

	await controller.close();
});

test("the provider catalog reaches the timeline as durable evidence", async () => {
	const prepared = binding();
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, {
			supportedModels: [
				{
					value: "fable",
					resolvedModel: "claude-fable-5",
					displayName: "Fable",
					supportsEffort: true,
					supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
				},
				{ ignored: true },
			],
		}),
	);
	await waitForCondition(() =>
		observed.events.some(({ kind }) => kind === "provider_catalog"),
	);
	const catalog = observed.events.find(({ kind }) => kind === "provider_catalog");
	assert.deepEqual(catalog.payload, {
		models: [
			{
				value: "fable",
				resolvedModel: "claude-fable-5",
				displayName: "Fable",
				supportsEffort: true,
				supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
			},
		],
	});
	await controller.close();
});

test("ultracode spawns at xhigh and applies the session setting", async () => {
	const prepared = Object.freeze({ ...binding(), effort: "ultracode" });
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, scriptedQuery(observed));

	assert.equal(observed.queryOptions[0].effort, "xhigh");
	await waitForCondition(() =>
		(observed.flagSettings ?? []).some((settings) => settings.ultracode === true),
	);

	await controller.close();
});

test("auto_edit maps to acceptEdits while keeping the approval channel", async () => {
	const prepared = Object.freeze({
		...binding(),
		permissionMode: "auto_edit",
	});
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, scriptedQuery(observed));

	assert.equal(observed.queryOptions[0].permissionMode, "acceptEdits");
	assert.equal(typeof observed.queryOptions[0].canUseTool, "function");
	assert.equal(
		Object.hasOwn(observed.queryOptions[0], "allowDangerouslySkipPermissions"),
		false,
	);

	await controller.close();
});

test("one persistent SDK Query receives turns through immutable relay-backed options", async () => {
	const prepared = binding();
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, scriptedQuery(observed));
	assert.equal(observed.queryOptions.length, 1);
	const options = observed.queryOptions[0];
	assert.equal(typeof options.canUseTool, "function");
	assert.equal(options.permissionMode, "default");
	assert.equal(Object.hasOwn(options, "allowDangerouslySkipPermissions"), false);
	assert.equal(Object.hasOwn(options, "model"), false);
	assert.equal(Object.hasOwn(options, "effort"), false);
	assert.equal(Object.hasOwn(options, "onUserDialog"), false);
	assert.equal(Object.hasOwn(options, "supportedDialogKinds"), false);
	assert.deepEqual(
		{
			cwd: options.cwd,
			env: options.env,
			forwardSubagentText: options.forwardSubagentText,
			includeHookEvents: options.includeHookEvents,
			includePartialMessages: options.includePartialMessages,
			pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
			persistSession: options.persistSession,
			resume: options.resume,
			settingSources: options.settingSources,
			systemPrompt: options.systemPrompt,
		},
		{
			cwd: prepared.cwd,
			env: {
				...prepared.env,
				CLAUDE_AGENT_SDK_VERSION: "0.3.234",
				CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
				DISABLE_AUTOUPDATER: "1",
			},
			forwardSubagentText: false,
			includeHookEvents: false,
			includePartialMessages: true,
			pathToClaudeCodeExecutable: runtimeDescriptor.executablePath,
			persistSession: true,
			resume: SESSION_ID,
			settingSources: ["user", "project", "local"],
			systemPrompt: { preset: "claude_code", type: "preset" },
		},
	);
	assert.deepEqual(observed.relayConfigurations, [
		{
			endpoint: prepared.process.relayEndpoint,
			identity: prepared.identity,
			launchCapability: prepared.process.relayCapability,
		},
	]);

	const result = await controller.startTurn({
		clientMessageId: "12345678-1234-4234-8234-123456789abc",
		input: "say hello",
	});
	assert.match(observed.inputs[0].uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
	assert.deepEqual(observed.inputs[0].message, {
		content: [{ text: "say hello", type: "text" }],
		role: "user",
	});
	assert.deepEqual(result, {
		durationApiMs: 7,
		durationMs: 11,
		isError: false,
		numTurns: 1,
		providerSessionId: SESSION_ID,
		sdkUserMessageId: observed.inputs[0].uuid,
		stopReason: "end_turn",
		subtype: "success",
		totalCostUsd: 0.01,
	});
	assert.deepEqual(
		observed.events.map(({ kind }) => kind),
		["provider_session_initialized", "assistant_delta", "assistant_message_completed", "provider_turn_result"],
	);
	assert.equal(observed.events[1].payload.text, "hello from Claude");

	await controller.close();
	assert.deepEqual(observed.terminals, [{ code: 0, signal: null }]);
	assert.equal(observed.closeCalls, 1);
});

test("SDK prewarm admits a Query whose public init event follows its first input", async () => {
	const prepared = binding(11, null);
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, { initializationAfterInput: true }),
		{ initializationTimeoutMs: 20 },
	);
	await controller.startTurn({
		clientMessageId: "prewarmed-first-turn-1",
		input: "hello after prewarm",
	});
	assert.deepEqual(
		observed.events.map(({ kind }) => kind),
		[
			"provider_session_initialized",
			"assistant_delta",
			"assistant_message_completed",
			"provider_turn_result",
		],
	);
	await controller.close();
});

test("a successful result supplies assistant text when partial messages are absent", async () => {
	const prepared = binding(12, null);
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, { assistantMessages: false }),
	);
	await controller.startTurn({ clientMessageId: "result-only-turn-1", input: "hello" });
	assert.deepEqual(
		observed.events.map(({ kind }) => kind),
		[
			"provider_session_initialized",
			"assistant_delta",
			"assistant_message_completed",
			"provider_turn_result",
		],
	);
	assert.equal(observed.events[1].payload.text, "hello from Claude");
	await controller.close();
});

test("a result-only final answer follows a tool preamble", async () => {
	const prepared = binding(13, null);
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, {
			assistantMessages: false,
			result: "final answer",
			toolPreamble: "checking first",
		}),
	);
	await controller.startTurn({ clientMessageId: "tool-result-only-turn-1", input: "check" });
	assert.deepEqual(
		observed.events.map(({ kind }) => kind),
		[
			"provider_session_initialized",
			"assistant_delta",
			"assistant_message_completed",
			"tool_started",
			"assistant_message_completed",
			"tool_result",
			"assistant_delta",
			"assistant_message_completed",
			"provider_turn_result",
		],
	);
	assert.deepEqual(
		observed.events.find(({ kind }) => kind === "tool_started")?.payload,
		{
			input: { file_path: "README.md" },
			name: "Read",
			parentToolUseId: null,
			providerMessageId: "message-preamble",
			toolCallId: "tool-use-1",
		},
	);
	assert.deepEqual(
		observed.events.find(({ kind }) => kind === "tool_result")?.payload,
		{
			input: { file_path: "README.md" },
			isError: false,
			name: "Read",
			output: { bytes: 11, content: "tool output" },
			parentToolUseId: null,
			providerMessageId: "message-preamble",
			toolCallId: "tool-use-1",
		},
	);
	assert.equal(observed.events.some(({ kind }) => kind === "tool_input_delta"), false);
	assert.deepEqual(
		observed.events
			.filter(({ kind }) => kind === "assistant_delta")
			.map(({ payload }) => payload.text),
		["checking first", "final answer"],
	);
	await controller.close();
});

test("a failed main-turn tool result preserves exact failure evidence", async () => {
	const prepared = binding(131, null);
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, {
			result: "recovered answer",
			toolPreamble: "checking first",
			toolResultError: true,
		}),
	);
	await controller.startTurn({ clientMessageId: "tool-failed-turn-1", input: "check" });
	assert.deepEqual(
		observed.events.find(({ kind }) => kind === "tool_result")?.payload,
		{
			input: { file_path: "README.md" },
			isError: true,
			name: "Read",
			output: "read failed",
			parentToolUseId: null,
			providerMessageId: "message-preamble",
			toolCallId: "tool-use-1",
		},
	);
	await controller.close();
});

test("an empty main-turn tool result remains a completed lifecycle event", async () => {
	const prepared = binding(132, null);
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, {
			toolPreamble: "checking first",
			toolResult: { omitContent: true, override: undefined },
		}),
	);
	await controller.startTurn({ clientMessageId: "tool-empty-turn-1", input: "check" });
	assert.equal(
		observed.events.find(({ kind }) => kind === "tool_result")?.payload.output,
		null,
	);
	await controller.close();
});

test("a replayed tool result cannot consume the live tool lifecycle", async () => {
	const prepared = binding(133, null);
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, {
			toolPreamble: "checking first",
			toolResult: { replayBeforeLive: true },
		}),
	);
	await controller.startTurn({ clientMessageId: "tool-replay-turn-1", input: "check" });
	assert.equal(observed.events.filter(({ kind }) => kind === "tool_started").length, 1);
	assert.equal(observed.events.filter(({ kind }) => kind === "tool_result").length, 1);
	await controller.close();
});

test("a shouldQuery false tool result still completes the live tool lifecycle", async () => {
	const prepared = binding(134, null);
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, {
			toolPreamble: "checking first",
			toolResult: { shouldQuery: false },
		}),
	);
	await controller.startTurn({ clientMessageId: "tool-no-query-turn-1", input: "check" });
	assert.equal(observed.events.filter(({ kind }) => kind === "tool_result").length, 1);
	await controller.close();
});

test("a malformed tool result error flag cannot become a successful lifecycle", async () => {
	const prepared = binding(135, null);
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, {
			toolPreamble: "checking first",
			toolResult: { isError: "true" },
		}),
	);
	await assert.rejects(
		controller.startTurn({ clientMessageId: "tool-invalid-error-turn-1", input: "check" }),
		/dure_claude_agent_sdk_stream_failed/,
	);
	assert.equal(observed.events.some(({ kind }) => kind === "tool_result"), false);
	await controller.close();
});

test("an oversized tool input preserves lifecycle without exceeding a host event", async () => {
	const prepared = binding(136, null);
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, {
			toolInput: { content: "x".repeat(DCH1_EVENT_MAX_BYTES) },
			toolPreamble: "checking first",
		}),
	);
	await controller.startTurn({ clientMessageId: "tool-large-input-turn-1", input: "check" });
	const lifecycle = observed.events.filter(({ kind }) => kind.startsWith("tool_"));
	assert.equal(lifecycle[0]?.payload.input, null);
	assert.equal(lifecycle[1]?.payload.input, null);
	for (const event of lifecycle) {
		assert.ok(
			Buffer.byteLength(
				JSON.stringify({ ...event, sequence: Number.MAX_SAFE_INTEGER }),
				"utf8",
			) <= DCH1_EVENT_MAX_BYTES,
		);
	}
	await controller.close();
});

test("combined tool input and output retain the result that fits the host event", async () => {
	const prepared = binding(137, null);
	const observed = observations(prepared);
	const output = { content: "y".repeat(40 * 1024) };
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, {
			toolInput: { content: "x".repeat(40 * 1024) },
			toolPreamble: "checking first",
			toolResult: { override: output },
		}),
	);
	await controller.startTurn({ clientMessageId: "tool-combined-size-turn-1", input: "check" });
	const resultEvent = observed.events.find(({ kind }) => kind === "tool_result");
	assert.equal(resultEvent?.payload.input, null);
	assert.deepEqual(resultEvent?.payload.output, output);
	assert.ok(
		Buffer.byteLength(
			JSON.stringify({ ...resultEvent, sequence: Number.MAX_SAFE_INTEGER }),
			"utf8",
		) <= DCH1_EVENT_MAX_BYTES,
	);
	await controller.close();
});

test("an oversized tool output preserves the input and terminal lifecycle", async () => {
	const prepared = binding(138, null);
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, {
			toolPreamble: "checking first",
			toolResult: {
				override: { content: "y".repeat(DCH1_EVENT_MAX_BYTES) },
			},
		}),
	);
	await controller.startTurn({ clientMessageId: "tool-large-output-turn-1", input: "check" });
	const resultEvent = observed.events.find(({ kind }) => kind === "tool_result");
	assert.deepEqual(resultEvent?.payload.input, { file_path: "README.md" });
	assert.equal(resultEvent?.payload.output, null);
	assert.ok(
		Buffer.byteLength(
			JSON.stringify({ ...resultEvent, sequence: Number.MAX_SAFE_INTEGER }),
			"utf8",
		) <= DCH1_EVENT_MAX_BYTES,
	);
	await controller.close();
});

test("the final streamed text block represents a multi-text assistant result", async () => {
	const prepared = binding(14, null);
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, {
			delta: "earlier text",
			result: "final text",
			trailingText: "final text",
		}),
	);
	await controller.startTurn({ clientMessageId: "multi-block-final-turn-1", input: "check" });
	assert.deepEqual(
		observed.events
			.filter(({ kind }) => kind === "assistant_delta")
			.map(({ payload }) => payload.text),
		["earlier text", "final text"],
	);
	assert.equal(observed.events.at(-1).kind, "provider_turn_result");
	await controller.close();
});

test("one Query parks exact permission and question callbacks and interrupts only its active turn", async () => {
	const prepared = binding(10, null);
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, interactiveQuery(observed));

	const permissionTurn = controller.startTurn({
		clientMessageId: "permission-message-1",
		input: "permission",
	});
	await waitForCondition(() =>
		observed.events.some(({ kind }) => kind === "interaction_requested"),
	);
	const permission = controller.pendingInteractions()[0];
	assert.deepEqual(
		{
			clientMessageId: permission.clientMessageId,
			input: permission.input,
			kind: permission.kind,
			toolName: permission.toolName,
			toolUseId: permission.toolUseId,
		},
		{
			clientMessageId: "permission-message-1",
			input: { file_path: "/workspace/secret.txt" },
			kind: "permission",
			toolName: "Read",
			toolUseId: "tool-use-read-1",
		},
	);
	assert.deepEqual(permission.matchedAskRule, {
		ruleContent: "/workspace/**",
		source: "projectSettings",
		toolName: "Read",
	});
	assert.deepEqual(permission.suggestions, [
		{ destination: "session", mode: "acceptEdits", type: "setMode" },
	]);
	await assert.rejects(
		controller.answerInteraction({
			clientMessageId: "permission-message-stale",
			decision: "allow",
			kind: permission.kind,
			requestId: permission.requestId,
		}),
		/dure_claude_agent_sdk_interaction_identity_mismatch/u,
	);
	await assert.rejects(
		controller.answerInteraction({
			clientMessageId: permission.clientMessageId,
			kind: "question",
			requestId: permission.requestId,
		}),
		/dure_claude_agent_sdk_interaction_identity_mismatch/u,
	);
	await controller.answerInteraction({
		clientMessageId: permission.clientMessageId,
		decision: "allow",
		kind: permission.kind,
		requestId: permission.requestId,
	});
	await permissionTurn;
	assert.deepEqual(observed.interactionResults[0], { behavior: "allow" });

	const questionTurn = controller.startTurn({
		clientMessageId: "question-message-1",
		input: "question",
	});
	await waitForCondition(() => controller.pendingInteractions().length === 1);
	const question = controller.pendingInteractions()[0];
	assert.equal(question.kind, "question");
	assert.equal(question.input.questions[0].question, "Which database should we use?");
	assert.equal(question.input.questions[0].allowOther, true);
	await controller.answerInteraction({
		answers: { "Which database should we use?": "SQLite" },
		clientMessageId: question.clientMessageId,
		kind: question.kind,
		requestId: question.requestId,
	});
	await questionTurn;
	assert.deepEqual(observed.interactionResults[1], {
		behavior: "allow",
		updatedInput: {
			answers: { "Which database should we use?": "SQLite" },
			questions: [
				{
					header: "Database",
					multiSelect: false,
					options: [
						{ description: "Use the local database", label: "SQLite" },
						{ description: "Use the server database", label: "Postgres" },
					],
					question: "Which database should we use?",
				},
			],
		},
	});

	const deniedTurn = controller.startTurn({
		clientMessageId: "denied-permission-message-1",
		input: "permission",
	});
	await waitForCondition(() => controller.pendingInteractions().length === 1);
	const deniedPermission = controller.pendingInteractions()[0];
	await controller.answerInteraction({
		clientMessageId: deniedPermission.clientMessageId,
		decision: "deny",
		interrupt: false,
		kind: deniedPermission.kind,
		message: "Not in this turn",
		requestId: deniedPermission.requestId,
	});
	await deniedTurn;
	assert.deepEqual(observed.interactionResults[2], {
		behavior: "deny",
		interrupt: false,
		message: "Not in this turn",
	});

	const interruptedTurn = controller.startTurn({
		clientMessageId: "interrupt-message-1",
		input: "interrupt",
	});
	await waitForCondition(() => observed.inputs.length === 4);
	assert.deepEqual(
		await controller.interruptTurn({
			clientMessageId: "interrupt-message-1",
			interruptRequestId: "direct-interrupt-request-1",
		}),
		{
			cancelledMessageIds: [],
			receiptAvailable: true,
			stillQueuedMessageIds: ["queued-user-message-1"],
		},
	);
	await interruptedTurn;
	assert.equal(observed.interruptCalls, 1);
	assert.deepEqual(controller.pendingInteractions(), []);
	await assert.rejects(
		controller.answerInteraction({
			clientMessageId: permission.clientMessageId,
			decision: "allow",
			kind: permission.kind,
			requestId: permission.requestId,
		}),
		/dure_claude_agent_sdk_interaction_stale/u,
	);
	await controller.close();
});

test("declining AskUserQuestion denies only its exact pending callback", async () => {
	const prepared = binding(15, null);
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, interactiveQuery(observed));
	const turn = controller.startTurn({
		clientMessageId: "declined-question-message-1",
		input: "question",
	});
	await waitForCondition(() => controller.pendingInteractions().length === 1);
	const question = controller.pendingInteractions()[0];

	await controller.answerInteraction({
		clientMessageId: question.clientMessageId,
		decision: "deny",
		kind: question.kind,
		requestId: question.requestId,
	});
	await turn;

	assert.deepEqual(observed.interactionResults, [
		{ behavior: "deny", message: "Denied by user" },
	]);
	assert.deepEqual(controller.pendingInteractions(), []);
	await controller.close();
});

test("SDK cancellation clears the exact pending callback and makes later answers stale", async () => {
	const prepared = binding(11, null);
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, interactiveQuery(observed));
	const turn = controller.startTurn({
		clientMessageId: "cancelled-permission-message-1",
		input: "permission",
	});
	await waitForCondition(() => controller.pendingInteractions().length === 1);
	const request = controller.pendingInteractions()[0];
	observed.interactionAbortControllers[0].abort("sdk_cancelled");
	await assert.rejects(turn, /dure_claude_agent_sdk_stream_failed/u);
	assert.deepEqual(controller.pendingInteractions(), []);
	assert.equal(
		observed.events.some(
			({ kind, payload }) =>
				kind === "interaction_cancelled" && payload.requestId === request.requestId,
		),
		true,
	);
	await assert.rejects(
		controller.answerInteraction({
			clientMessageId: request.clientMessageId,
			decision: "allow",
			kind: request.kind,
			requestId: request.requestId,
		}),
		/dure_claude_agent_sdk_interaction_stale/u,
	);
	await controller.close();
});

test("large UTF-8 stream deltas are split into bounded lossless events", async () => {
	const prepared = binding(2, null);
	const observed = observations(prepared);
	const delta = "가나다🙂".repeat(8_000);
	const controller = await createController(prepared, observed, scriptedQuery(observed, { delta }));
	await controller.startTurn({ clientMessageId: "large-delta-1", input: "stream" });
	const deltas = observed.events.filter(({ kind }) => kind === "assistant_delta");
	assert.ok(deltas.length > 1);
	assert.equal(deltas.map(({ payload }) => payload.text).join(""), delta);
	for (const event of deltas) {
		assert.ok(Buffer.byteLength(JSON.stringify(event), "utf8") < 32 * 1024);
	}
	await controller.close();
});

test("provider failures reject only the active turn and redact raw provider errors", async () => {
	const prepared = binding(3, null);
	const observed = observations(prepared);
	const secret = "credential-secret-must-not-cross-dch1";
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, { resultError: secret }),
	);
	await assert.rejects(
		controller.startTurn({ clientMessageId: "failed-turn-1", input: "fail" }),
		/dure_claude_agent_sdk_turn_failed/u,
	);
	assert.equal(JSON.stringify(observed.events).includes(secret), false);
	assert.deepEqual(observed.events.map(({ kind }) => kind), [
		"provider_session_initialized",
		"provider_turn_result",
	]);
	assert.equal(observed.events[1].payload.isError, true);
	await controller.close();
});

test("the relay boundary rejects SDK attempts to replace prepared credential state", async () => {
	const prepared = binding(4, null);
	const observed = observations(prepared);
	const query = ({ options }) => {
		options.spawnClaudeCodeProcess({
			args: [],
			command: options.pathToClaudeCodeExecutable,
			cwd: options.cwd,
			env: { ...options.env, CLAUDE_CONFIG_DIR: "/credentials/wrong-profile" },
			signal: new AbortController().signal,
		});
		throw new Error("query_must_not_continue_after_invalid_spawn");
	};
	await assert.rejects(
		createController(prepared, observed, query),
		/dure_claude_agent_sdk_spawn_environment_mismatch/u,
	);
	assert.equal(observed.children.length, 0);
});

test("the relay boundary admits only bounded SDK trace context", async () => {
	const prepared = binding(9, null);
	const accepted = observations(prepared);
	const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
	const controller = await createController(
		prepared,
		accepted,
		scriptedQuery(accepted, { spawnEnvironment: { TRACEPARENT: traceparent } }),
	);
	assert.equal(accepted.spawnOptions[0].env.TRACEPARENT, traceparent);
	await controller.close();

	const rejected = observations(prepared);
	await assert.rejects(
		createController(
			prepared,
			rejected,
			scriptedQuery(rejected, { spawnEnvironment: { TRACESTATE: "x".repeat(4_097) } }),
		),
		/dure_claude_agent_sdk_spawn_environment_invalid/u,
	);
	assert.equal(rejected.children.length, 0);
});

test("parallel Query bindings retain distinct credential environments without shared mutation", async () => {
	const prepared = [binding(7, null), binding(8, null)];
	const observed = prepared.map((value) => observations(value));
	const byRuntime = new Map(
		prepared.map((value, index) => [value.identity.runtimeGeneration, observed[index]]),
	);
	const byCredential = new Map(
		prepared.map((value, index) => [value.env.DURE_CREDENTIAL_SENTINEL, observed[index]]),
	);
	const sharedValueBefore = process.env.DURE_CREDENTIAL_SENTINEL;
	const factory = createClaudeAgentSdkQueryFactory({
		claudeCodeVersion: "2.1.234",
		createRelaySpawner: (configuration) =>
			createRelaySpawnerProbe(byRuntime.get(configuration.identity.runtimeGeneration))(
				configuration,
			),
		runtimeArtifact,
		sdkVersion: "0.3.234",
		startup: ({ options }) =>
			scriptedStartup(
				scriptedQuery(byCredential.get(options.env.DURE_CREDENTIAL_SENTINEL)),
			)({ options }),
	});
	const controllers = await Promise.all(
		prepared.map((value, index) =>
			factory({
				binding: value,
				emit: (kind, payload) => observed[index].events.push({ kind, payload }),
				signal: new AbortController().signal,
				terminal: (terminalValue) => observed[index].terminals.push(terminalValue),
			}),
		),
	);
	assert.equal(observed[0].spawnOptions[0].env.CLAUDE_CONFIG_DIR, "/credentials/claude-7");
	assert.equal(observed[1].spawnOptions[0].env.CLAUDE_CONFIG_DIR, "/credentials/claude-8");
	assert.equal(observed[0].spawnOptions[0].env.DURE_CREDENTIAL_SENTINEL, "profile-7");
	assert.equal(observed[1].spawnOptions[0].env.DURE_CREDENTIAL_SENTINEL, "profile-8");
	assert.equal(process.env.DURE_CREDENTIAL_SENTINEL, sharedValueBefore);
	await Promise.all(controllers.map((controller) => controller.close()));
});

test("host abort reaches the SDK controller and invalidation closes exactly once", async () => {
	const prepared = binding(5, null);
	const observed = observations(prepared);
	const hostAbort = new AbortController();
	const factory = createClaudeAgentSdkQueryFactory({
		claudeCodeVersion: "2.1.234",
		createRelaySpawner: createRelaySpawnerProbe(observed),
		runtimeArtifact,
		sdkVersion: "0.3.234",
		startup: scriptedStartup(scriptedQuery(observed)),
	});
	const controller = await factory({
		binding: prepared,
		emit: (kind, payload) => observed.events.push({ kind, payload }),
		signal: hostAbort.signal,
		terminal: (value) => observed.terminals.push(value),
	});
	assert.equal(observed.queryOptions[0].abortController.signal.aborted, false);
	hostAbort.abort("host_failed");
	assert.equal(observed.queryOptions[0].abortController.signal.aborted, true);
	await controller.invalidate("host_failed");
	await controller.invalidate("host_failed");
	assert.equal(observed.closeCalls, 1);
});

test("the pinned SDK consumes a persistent fake stream-json CLI without network access", async () => {
	const runtime = await loadPinnedClaudeSdkRuntime();
	const executable = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../tests/fixtures/fake-claude-agent-sdk-cli",
	);
	const prepared = Object.freeze({
		...binding(6, null),
		cwd: process.cwd(),
		env: Object.freeze({
			CLAUDE_CONFIG_DIR: "/private/tmp/dure-fake-agent-sdk-config",
			HOME: process.env.HOME ?? "/private/tmp",
			PATH: process.env.PATH ?? "/usr/bin:/bin",
		}),
		process: Object.freeze({
			...binding(6, null).process,
			command: executable,
		}),
	});
	const observed = observations(prepared);
	let stderr = "";
	const factory = createClaudeAgentSdkQueryFactory({
		claudeCodeVersion: runtime.metadata.claudeCodeVersion,
		createRelaySpawner: () => (options) => {
			const child = spawn(options.command, options.args, {
				cwd: options.cwd,
				env: options.env,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			return child;
		},
		runtimeArtifact,
		sdkVersion: runtime.metadata.sdkVersion,
		startup: runtime.startup,
	});
	let controller;
	try {
		controller = await factory({
			binding: prepared,
			emit: (kind, payload) => observed.events.push({ kind, payload }),
			signal: new AbortController().signal,
			terminal: (value) => observed.terminals.push(value),
		});
	} catch (error) {
		throw new Error(`pinned_sdk_fake_cli_bind_failed:${error.message}:stderr=${stderr}`, {
			cause: error,
		});
	}
	const result = await controller.startTurn({
		clientMessageId: "pinned-sdk-fake-cli-message-1",
		input: "hello",
	});
	assert.equal(result.providerSessionId, "99999999-8888-4777-8666-555555555555");
	assert.equal(
		observed.events.find(({ kind }) => kind === "assistant_delta").payload.text,
		"sdk-echo:hello",
	);
	await controller.close();
	assert.equal(stderr, "");
});

test("a mid-turn steer rides the same streaming input into the running turn", async () => {
	const prepared = binding();
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, ({ prompt, options }) => {
		observed.queryOptions.push(options);
		const output = new AsyncQueue();
		const child = options.spawnClaudeCodeProcess({
			args: [],
			command: options.pathToClaudeCodeExecutable,
			cwd: options.cwd,
			env: options.env,
			signal: new AbortController().signal,
		});
		let closed = false;
		queueMicrotask(() => output.push(initializationMessage(observed.bindings.at(-1))));
		void (async () => {
			for await (const message of prompt) {
				observed.inputs.push(message);
				// Hold the turn open until the steer arrives, then finish once.
				if (observed.inputs.length < 2) continue;
				pushAssistantMessage(output, {
					delta: "steered answer",
					providerMessageId: "message-1",
				});
				output.push(successResult(observed.inputs[0].uuid, "steered answer"));
			}
		})().catch((error) => output.fail(error));
		return {
			[Symbol.asyncIterator]() {
				return output;
			},
			close() {
				if (closed) return;
				closed = true;
				observed.closeCalls += 1;
				child.exit(0, null);
				output.close();
			},
			async interrupt() {
				observed.interruptCalls += 1;
				return undefined;
			},
		};
	});

	assert.throws(
		() =>
			controller.steerTurn({
				clientMessageId: "12345678-1234-4234-8234-123456789abd",
				input: "too soon",
			}),
		/dure_claude_agent_sdk_turn_not_running/u,
	);

	const turn = controller.startTurn({
		clientMessageId: "12345678-1234-4234-8234-123456789abc",
		input: "start the work",
	});
	await waitForCondition(() => observed.inputs.length === 1);
	controller.steerTurn({
		clientMessageId: "12345678-1234-4234-8234-123456789abd",
		input: "actually target the tests",
	});
	const result = await turn;
	assert.equal(result.stopReason, "end_turn");
	assert.equal(observed.inputs.length, 2);
	assert.deepEqual(observed.inputs[1].message, {
		content: [{ text: "actually target the tests", type: "text" }],
		role: "user",
	});
	assert.match(
		observed.inputs[1].uuid,
		/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
	);
	assert.notEqual(observed.inputs[1].uuid, observed.inputs[0].uuid);

	assert.throws(
		() =>
			controller.steerTurn({
				clientMessageId: "12345678-1234-4234-8234-123456789abe",
				input: "after the turn ended",
			}),
		/dure_claude_agent_sdk_turn_not_running/u,
	);
	await controller.close();
});

const SDK_USAGE_LIMIT_PREFIXES = Object.freeze(["You've hit your", "Fable 5 requires usage credits"]);

test("a usage-limit result crosses the boundary as a bounded reason, never as text", async () => {
	const prepared = binding(3, null);
	const observed = observations(prepared);
	const limitText = "You've hit your limit · resets 3pm (America/Los_Angeles)";
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, {
			assistantMessages: false,
			resultPatch: { is_error: true, result: limitText },
		}),
		{ usageLimitErrorPrefixes: SDK_USAGE_LIMIT_PREFIXES },
	);
	await assert.rejects(
		controller.startTurn({ clientMessageId: "limit-turn-1", input: "go" }),
		(error) =>
			/dure_claude_agent_sdk_turn_failed/u.test(error.message) &&
			error.reason === "usage_limit",
	);
	const result = observed.events.find(({ kind }) => kind === "provider_turn_result");
	assert.equal(result.payload.isError, true);
	assert.equal(result.payload.failureReason, "usage_limit");
	assert.equal(JSON.stringify(observed.events).includes("resets 3pm"), false);
	await controller.close();
});

test("an API auth status classifies as authentication_failed and other errors stay provider_error", async () => {
	for (const [resultPatch, expected] of [
		// Injected from the pinned SDK, not hand-copied: a new prefix classifies
		// the moment the SDK ships it.
		[{ is_error: true, result: "Fable 5 requires usage credits · buy more" }, "usage_limit"],
		[{ is_error: true, result: "Claude AI usage limit reached|1756800000" }, "usage_limit"],
		[{ is_error: true, result: "", api_error_status: 401 }, "authentication_failed"],
		[{ is_error: true, result: "", api_error_status: 429 }, "rate_limit"],
		[{ is_error: true, result: "something else went wrong" }, "provider_error"],
	]) {
		const prepared = binding(3, null);
		const observed = observations(prepared);
		const controller = await createController(
			prepared,
			observed,
			scriptedQuery(observed, { assistantMessages: false, resultPatch }),
			{ usageLimitErrorPrefixes: SDK_USAGE_LIMIT_PREFIXES },
		);
		await assert.rejects(
			controller.startTurn({ clientMessageId: "classified-turn-1", input: "go" }),
			(error) => error.reason === expected,
		);
		assert.equal(
			observed.events.find(({ kind }) => kind === "provider_turn_result").payload
				.failureReason,
			expected,
		);
		await controller.close();
	}
});
