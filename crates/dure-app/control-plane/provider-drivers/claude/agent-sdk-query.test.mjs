import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	createClaudeAgentSdkQueryFactory,
	providerPermissionModeEvidence,
} from "./agent-sdk-query.mjs";
import {
	claudeRuntimeArtifactDescriptor,
	claudeRuntimeTarget,
	installClaudeRuntimeArtifact,
} from "./claude-runtime-artifact.mjs";
import { loadPinnedClaudeSdkRuntime } from "./sdk-runtime.mjs";
import { createSharedClaudeSdkHost } from "./shared-sdk-host.mjs";

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

// A turn Claude runs on its own, as the pinned CLI does when a background
// task it started reports back: no host prompt, a fresh init, the answer, and
// a result that names the task notification instead of a prompt uuid.
function pushProviderInitiatedTurn(output, prepared, text) {
	output.push(initializationMessage(prepared));
	pushAssistantMessage(output, { delta: text, providerMessageId: "message-provider-turn" });
	const result = {
		...successResult(undefined, text),
		duration_ms: 99,
		origin: { kind: "task-notification" },
	};
	delete result.user_message_uuid;
	output.push(result);
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
		beforeResult = [],
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
		supportedCommands = null,
		initialization = null,
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
		const initializationEvent = () => ({
			...initializationMessage(observations.bindings.at(-1)),
			...(initialization ?? {}),
		});
		if (!initializationAfterInput) {
			queueMicrotask(() => output.push(initializationEvent()));
		}
		void (async () => {
			for await (const message of prompt) {
				observations.inputs.push(message);
				if (initializationAfterInput) {
					output.push(initializationEvent());
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
				for (const before of beforeResult) output.push(before);
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
			...(supportedCommands
				? { supportedCommands: async () => supportedCommands }
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
				} else if (turnInput === "plan") {
					const interactionAbort = new AbortController();
					observed.interactionAbortControllers.push(interactionAbort);
					const planResult = await options.canUseTool(
						"ExitPlanMode",
						{ plan: `# Plan\n\n${"- step\n".repeat(2_000)}` },
						{
							requestId: "sdk-plan-request-1",
							signal: interactionAbort.signal,
							toolUseID: "tool-use-plan-1",
						},
					);
					observed.interactionResults.push(planResult);
					// The CLI leaves plan mode for its pre-plan mode and reports it.
					if (planResult.behavior === "allow") {
						output.push({
							permissionMode: "default",
							session_id: SESSION_ID,
							status: null,
							subtype: "status",
							type: "system",
							uuid: "cccccccc-dddd-4eee-8fff-000000000000",
						});
					}
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
				} else if (turnInput === "provider turn first") {
					// The prompt arrived while Claude ran a turn of its own; the
					// CLI queued it and answers it once that turn's result is out.
					pushProviderInitiatedTurn(output, observed.bindings.at(-1), "background task finished");
				} else if (turnInput.startsWith("background ")) {
					// The CLI's level signal: every live background task after a change.
					const count = Number(turnInput.slice("background ".length));
					output.push({
						session_id: SESSION_ID,
						subtype: "background_tasks_changed",
						tasks: Array.from({ length: count }, (_, index) => ({
							description: `Background task ${index}`,
							task_id: `task-${index}`,
							task_type: "local_bash",
						})),
						type: "system",
						uuid: "dddddddd-eeee-4fff-8000-111111111111",
					});
				}
				output.push(successResult(message.uuid));
				activeMessage = undefined;
				if (turnInput === "provider turn after") {
					// The turn left a background task that reports back after it.
					pushProviderInitiatedTurn(output, observed.bindings.at(-1), "background task finished");
				}
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

function delayedInterruptQuery(observed, acknowledgement) {
	const query = interactiveQuery(observed);
	return (options) => {
		const sdkQuery = query(options);
		return {
			...sdkQuery,
			async interrupt() {
				const receipt = await sdkQuery.interrupt();
				await acknowledgement.promise;
				return receipt;
			},
		};
	};
}

test("the shared owner fences actual Query input across result ACK and reconnect until interrupt settlement", async (t) => {
	const prepared = binding();
	const observed = observations(prepared);
	const acknowledgement = Promise.withResolvers();
	const factory = createClaudeAgentSdkQueryFactory({
		claudeCodeVersion: "2.1.234",
		createRelaySpawner: createRelaySpawnerProbe(observed),
		runtimeArtifact,
		sdkVersion: "0.3.234",
		startup: scriptedStartup(delayedInterruptQuery(observed, acknowledgement)),
	});
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-query-interrupt-fence",
		createQuery: factory,
		readHistory: async () => ({ items: [], status: "complete" }),
	});
	const first = host.attach({
		hostGeneration: host.hostGeneration,
		clientGeneration: "first",
	});
	await first.bind(prepared);
	t.after(async () => {
		acknowledgement.resolve();
		await host.closeQuery(prepared.identity);
	});
	first.startTurn(prepared.identity, {
		clientMessageId: "turn-a",
		input: "interrupt",
	});
	await waitForCondition(() => observed.inputs.length === 1);
	const request = {
		clientMessageId: "turn-a",
		interruptRequestId: "interrupt-a",
	};
	const pending = first.interruptTurn(prepared.identity, request);
	await waitForCondition(
		() => first.snapshot().queries[0].state === "waiting_for_input",
	);
	first.ack(
		prepared.identity,
		first.replay(prepared.identity, 0).latestSequence,
	);
	first.detach();
	const second = host.attach({
		hostGeneration: host.hostGeneration,
		clientGeneration: "second",
	});
	assert.throws(
		() =>
			second.startTurn(prepared.identity, {
				clientMessageId: "turn-b",
				input: "B",
			}),
		/query_busy/u,
	);
	assert.throws(
		() =>
			second.steerTurn(prepared.identity, {
				clientMessageId: "steer-b",
				input: "B",
			}),
		/query_busy/u,
	);
	const replay = second.interruptTurn(prepared.identity, request);
	assert.equal(observed.inputs.length, 1);
	assert.equal(observed.interruptCalls, 1);
	acknowledgement.resolve();
	assert.deepEqual(await replay, await pending);
	second.startTurn(prepared.identity, {
		clientMessageId: "turn-b",
		input: "B",
	});
	await waitForCondition(
		() =>
			observed.inputs.length === 2 &&
			second.snapshot().queries[0].state === "waiting_for_input",
	);
	assert.equal(observed.interruptCalls, 1);
	second.detach();
});

test("a late interrupt acknowledgement cannot publish after exact Query close", async () => {
	const prepared = binding();
	const observed = observations(prepared);
	const acknowledgement = Promise.withResolvers();
	const controller = await createController(
		prepared,
		observed,
		delayedInterruptQuery(observed, acknowledgement),
	);
	const turn = controller.startTurn({
		clientMessageId: "turn-a",
		input: "interrupt",
	});
	await waitForCondition(() => observed.inputs.length === 1);
	const pending = controller.interruptTurn({
		clientMessageId: "turn-a",
		interruptRequestId: "interrupt-a",
	});
	assert.equal(
		observed.interruptCalls,
		1,
		"SDK dispatch follows the identity check without a microtask gap",
	);
	await turn;
	await controller.close();
	const refused = assert.rejects(pending, /query_closed/u);
	acknowledgement.resolve();
	await refused;
	assert.equal(
		observed.events.some(
			({ kind }) => kind === "provider_turn_interrupt_acknowledged",
		),
		false,
	);
	assert.equal(observed.closeCalls, 1);
});

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

test("managed memory settings reach the SDK without changing credential or permission options", async () => {
	const prepared = { ...binding(), autoMemoryDirectory: "/data/dure/memories/claude/work/project" };
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, scriptedQuery(observed));
	assert.deepEqual(observed.queryOptions[0].settings, { autoMemoryDirectory: prepared.autoMemoryDirectory });
	assert.equal(observed.queryOptions[0].env.CLAUDE_CONFIG_DIR, prepared.env.CLAUDE_CONFIG_DIR);
	assert.equal(observed.queryOptions[0].permissionMode, "default");
	assert.deepEqual(observed.queryOptions[0].settingSources, ["user", "project", "local"]);
	await controller.close();
});

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
					value: "default",
					resolvedModel: "claude-fable-5",
					displayName: "Default",
					supportsEffort: true,
					supportedEffortLevels: ["low", "high"],
				},
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
				value: "default",
				resolvedModel: "claude-fable-5",
				displayName: "Default",
				isDefault: true,
				supportsEffort: true,
				supportedEffortLevels: ["low", "high"],
			},
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

test("plan maps to the SDK plan mode while keeping the approval channel", async () => {
	const prepared = Object.freeze({ ...binding(), permissionMode: "plan" });
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, scriptedQuery(observed));

	assert.equal(observed.queryOptions[0].permissionMode, "plan");
	assert.equal(typeof observed.queryOptions[0].canUseTool, "function");
	assert.equal(
		Object.hasOwn(observed.queryOptions[0], "allowDangerouslySkipPermissions"),
		false,
	);

	await controller.close();
});

test("a plan larger than one tool input still reaches the approval request", async () => {
	const prepared = Object.freeze({ ...binding(10, null), permissionMode: "plan" });
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, interactiveQuery(observed));

	const turn = controller.startTurn({ clientMessageId: "plan-message-1", input: "plan" });
	await waitForCondition(() =>
		observed.events.some(({ kind }) => kind === "interaction_requested"),
	);
	const request = controller.pendingInteractions()[0];
	assert.equal(request.toolName, "ExitPlanMode");
	assert.equal(request.kind, "permission");
	assert.ok(Buffer.byteLength(request.input.plan, "utf8") > 8 * 1024);
	await controller.answerInteraction({
		clientMessageId: request.clientMessageId,
		decision: "allow",
		kind: request.kind,
		requestId: request.requestId,
	});
	await turn;
	assert.deepEqual(observed.interactionResults[0], { behavior: "allow" });
	await controller.close();
});

test("an approved plan reports the permission mode Claude continues in", async () => {
	const prepared = Object.freeze({ ...binding(10, null), permissionMode: "plan" });
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, interactiveQuery(observed));

	const turn = controller.startTurn({ clientMessageId: "plan-message-1", input: "plan" });
	await waitForCondition(() =>
		observed.events.some(({ kind }) => kind === "interaction_requested"),
	);
	assert.equal(
		observed.events.some(({ kind }) => kind === "provider_permission_mode"),
		false,
	);
	const request = controller.pendingInteractions()[0];
	await controller.answerInteraction({
		clientMessageId: request.clientMessageId,
		decision: "allow",
		kind: request.kind,
		requestId: request.requestId,
	});
	await turn;
	assert.deepEqual(
		observed.events.filter(({ kind }) => kind === "provider_permission_mode").map(({ payload }) => payload),
		[{ permissionMode: "default", providerPermissionMode: "default" }],
	);
	await controller.close();
});

test("the provider's background task level outlives the turn and replaces itself", async () => {
	const prepared = binding();
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, interactiveQuery(observed));
	assert.equal(controller.backgroundTaskCount(), 0);

	await controller.startTurn({ clientMessageId: "background-message-1", input: "background 2" });
	assert.equal(controller.backgroundTaskCount(), 2, "the turn ended; its tasks still run");
	await controller.startTurn({ clientMessageId: "background-message-2", input: "background 0" });
	assert.equal(controller.backgroundTaskCount(), 0, "an empty level clears every task");
	assert.equal(
		observed.events.some(({ payload }) => payload?.subtype === "background_tasks_changed"),
		false,
		"the level is Query state, not a timeline event",
	);
	await controller.close();
});

test("a turn Claude runs on its own after a background task leaves the Query open", async () => {
	const prepared = binding();
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, interactiveQuery(observed));

	await controller.startTurn({ clientMessageId: "provider-turn-message-1", input: "provider turn after" });
	await waitForCondition(
		() =>
			observed.terminals.length > 0 ||
			observed.events.some(
				({ kind, payload }) => kind === "provider_event" && payload.type === "result",
			),
	);
	assert.deepEqual(observed.terminals, [], "Claude's own turn is not a stream failure");
	assert.equal(observed.closeCalls, 0);
	assert.equal(observed.children[0].killed, false);
	assert.ok(
		observed.events.some(
			({ kind, payload }) =>
				kind === "assistant_delta" && payload.text === "background task finished",
		),
		"what Claude said in its own turn still reaches the timeline",
	);
	assert.equal(
		observed.events.filter(({ kind }) => kind === "provider_turn_result").length,
		1,
		"only the host's turn has a turn result",
	);

	const next = await controller.startTurn({ clientMessageId: "provider-turn-message-2", input: "hello" });
	assert.equal(next.sdkUserMessageId, observed.inputs[1].uuid);
	await controller.close();
});

test("a host turn queued behind Claude's own turn completes with its own result", async () => {
	const prepared = binding();
	const observed = observations(prepared);
	const controller = await createController(prepared, observed, interactiveQuery(observed));

	const result = await controller.startTurn({
		clientMessageId: "queued-behind-provider-turn-1",
		input: "provider turn first",
	});
	assert.equal(result.durationMs, 11, "the turn ends on its own result, not on Claude's");
	assert.equal(result.sdkUserMessageId, observed.inputs[0].uuid);
	const turnResults = observed.events.filter(({ kind }) => kind === "provider_turn_result");
	assert.deepEqual(
		turnResults.map(({ payload }) => payload.durationMs),
		[11],
	);
	assert.ok(
		observed.events.some(
			({ kind, payload }) =>
				kind === "assistant_delta" &&
				payload.providerMessageId === `result-${observed.inputs[0].uuid}` &&
				payload.text === "hello from Claude",
		),
		"the turn's own answer is not taken for the text of Claude's turn",
	);

	const next = await controller.startTurn({ clientMessageId: "queued-behind-provider-turn-2", input: "hello" });
	assert.equal(next.sdkUserMessageId, observed.inputs[1].uuid);
	assert.deepEqual(observed.terminals, []);
	await controller.close();
});

test("provider permission modes map to Dure's selections or to none", () => {
	assert.deepEqual(providerPermissionModeEvidence("acceptEdits"), {
		permissionMode: "auto_edit",
		providerPermissionMode: "acceptEdits",
	});
	assert.deepEqual(providerPermissionModeEvidence("bypassPermissions"), {
		permissionMode: "skip_permissions",
		providerPermissionMode: "bypassPermissions",
	});
	assert.deepEqual(providerPermissionModeEvidence("plan"), {
		permissionMode: "plan",
		providerPermissionMode: "plan",
	});
	assert.deepEqual(providerPermissionModeEvidence("auto"), {
		permissionMode: null,
		providerPermissionMode: "auto",
	});
	assert.equal(providerPermissionModeEvidence(""), null);
	assert.equal(providerPermissionModeEvidence(7), null);
	assert.equal(providerPermissionModeEvidence("x".repeat(64)), null);
});

test("the provider's slash commands reach the timeline without terminal-only ones", async () => {
	const prepared = binding();
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		scriptedQuery(observed, {
			initialization: { terminal_slash_commands: ["statusline"] },
			supportedCommands: [
				{ name: "compact", description: "Clear history but keep a summary", argumentHint: "<instructions>" },
				{ name: "/review", description: "Review a pull request", argumentHint: "", aliases: ["pr", "bad alias"] },
				{ name: "statusline", description: "Terminal only", argumentHint: "" },
				{ name: "compact", description: "duplicate", argumentHint: "" },
				{ name: "no spaces allowed", description: "", argumentHint: "" },
			],
		}),
	);
	await waitForCondition(() =>
		observed.events.some(({ kind }) => kind === "provider_commands"),
	);
	assert.deepEqual(
		observed.events.find(({ kind }) => kind === "provider_commands").payload,
		{
			commands: [
				{
					name: "compact",
					description: "Clear history but keep a summary",
					argumentHint: "<instructions>",
				},
				{ name: "review", description: "Review a pull request", aliases: ["pr"] },
			],
		},
	);
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
		[
			"provider_session_initialized",
			"provider_user_message",
			"assistant_delta",
			"assistant_message_completed",
			"provider_turn_result",
		],
	);
	assert.equal(
		observed.events.find(({ kind }) => kind === "assistant_delta").payload.text,
		"hello from Claude",
	);

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
			"provider_user_message",
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
			"provider_user_message",
			"assistant_delta",
			"assistant_message_completed",
			"provider_turn_result",
		],
	);
	assert.equal(
		observed.events.find(({ kind }) => kind === "assistant_delta").payload.text,
		"hello from Claude",
	);
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
			"provider_user_message",
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
		"provider_user_message",
		"provider_turn_result",
	]);
	assert.equal(observed.events.at(-1).payload.isError, true);
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

// What the pinned CLI reports for each uuid-stamped prompt it queues: queued
// on arrival, started once folded into the running turn or begun as a turn
// of its own, completed after the turn that answered it.
function commandLifecycle(commandUuid, state) {
	return {
		command_uuid: commandUuid,
		session_id: SESSION_ID,
		state,
		type: "command_lifecycle",
		uuid: "abababab-cdcd-4efe-8a0a-121212121212",
	};
}

// A Query whose CLI hands every prompt it reads to `onInput`, so a test
// scripts what Claude emits around steers.
function steeredQuery(observed, onInput) {
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
		let closed = false;
		queueMicrotask(() => output.push(initializationMessage(observed.bindings.at(-1))));
		void (async () => {
			for await (const message of prompt) {
				observed.inputs.push(message);
				onInput(output, observed.inputs);
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
	};
}

test("a mid-turn steer rides the same streaming input into the running turn", async () => {
	const prepared = binding();
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		steeredQuery(observed, (output, inputs) => {
			// Hold the turn open until the steer arrives; Claude folds it in at
			// the next tool boundary and finishes once.
			if (inputs.length < 2) return;
			const steer = inputs[1].uuid;
			output.push(commandLifecycle(steer, "queued"));
			output.push(commandLifecycle(steer, "started"));
			pushAssistantMessage(output, {
				delta: "steered answer",
				providerMessageId: "message-1",
			});
			output.push(commandLifecycle(steer, "completed"));
			output.push(successResult(inputs[0].uuid, "steered answer"));
		}),
	);

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
	// Each prompt the provider received is reported with the uuid it was sent
	// with, which is the id the provider records it under. Refused steers are
	// not.
	assert.deepEqual(
		observed.events
			.filter(({ kind }) => kind === "provider_user_message")
			.map(({ payload }) => payload),
		[
			{
				clientMessageId: "12345678-1234-4234-8234-123456789abc",
				providerMessageId: observed.inputs[0].uuid,
			},
			{
				clientMessageId: "12345678-1234-4234-8234-123456789abd",
				providerMessageId: observed.inputs[1].uuid,
			},
		],
	);
	await controller.close();
});

test("a steer Claude answers in a turn of its own keeps the host turn open for it", async () => {
	const prepared = binding();
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		steeredQuery(observed, (output, inputs) => {
			if (inputs.length === 1) return;
			const message = inputs.at(-1).uuid;
			if (inputs.length > 2) {
				pushAssistantMessage(output, { delta: "next answer", providerMessageId: "message-3" });
				output.push(successResult(message, "next answer"));
				return;
			}
			// The steer arrived after the turn's last tool boundary, as the
			// pinned CLI shows: Claude queues it, ends the turn, then answers
			// it in a turn of its own under the steer's uuid.
			const prompt = inputs[0].uuid;
			output.push(commandLifecycle(message, "queued"));
			pushAssistantMessage(output, { delta: "first answer", providerMessageId: "message-1" });
			output.push(successResult(prompt, "first answer"));
			output.push(commandLifecycle(prompt, "completed"));
			output.push(commandLifecycle(message, "started"));
			output.push(initializationMessage(observed.bindings.at(-1)));
			pushAssistantMessage(output, { delta: "steered answer", providerMessageId: "message-2" });
			output.push({ ...successResult(message, "steered answer"), duration_ms: 22 });
			output.push(commandLifecycle(message, "completed"));
		}),
	);

	const turn = controller.startTurn({
		clientMessageId: "late-steer-message-1",
		input: "write about the sea",
	});
	await waitForCondition(() => observed.inputs.length === 1);
	controller.steerTurn({ clientMessageId: "late-steer-message-2", input: "also say banana" });
	const result = await turn;
	assert.equal(result.durationMs, 22, "the turn ends once Claude has answered the steer");
	assert.equal(result.sdkUserMessageId, observed.inputs[0].uuid);
	assert.deepEqual(observed.terminals, [], "the steer's own result is not a stream failure");
	assert.equal(observed.closeCalls, 0);
	assert.equal(observed.children[0].killed, false);
	assert.deepEqual(
		observed.events
			.filter(({ kind }) => kind === "provider_turn_result")
			.map(({ payload }) => payload.durationMs),
		[22],
	);
	assert.deepEqual(
		observed.events
			.filter(({ kind }) => kind === "assistant_delta")
			.map(({ payload }) => payload.text),
		["first answer", "steered answer"],
	);

	const next = await controller.startTurn({ clientMessageId: "late-steer-message-3", input: "hello" });
	assert.equal(next.sdkUserMessageId, observed.inputs[2].uuid);
	assert.deepEqual(observed.terminals, []);
	await controller.close();
});

test("steers that reach Claude after it ended the turn are answered inside that turn", async () => {
	const prepared = binding();
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		steeredQuery(observed, (output, inputs) => {
			if (inputs.length < 3) return;
			// Claude had already ended the turn when both steers arrived. It
			// queues them, takes them up together and answers under the last.
			const [prompt, first, second] = inputs.map(({ uuid }) => uuid);
			output.push(successResult(prompt, "first answer"));
			for (const steer of [first, second]) output.push(commandLifecycle(steer, "queued"));
			for (const steer of [first, second]) output.push(commandLifecycle(steer, "started"));
			pushAssistantMessage(output, { delta: "both answered", providerMessageId: "message-2" });
			output.push({ ...successResult(second, "both answered"), duration_ms: 33 });
		}),
	);

	const turn = controller.startTurn({ clientMessageId: "race-steer-message-1", input: "go" });
	await waitForCondition(() => observed.inputs.length === 1);
	controller.steerTurn({ clientMessageId: "race-steer-message-2", input: "first steer" });
	controller.steerTurn({ clientMessageId: "race-steer-message-3", input: "second steer" });
	const result = await turn;
	assert.equal(result.durationMs, 33);
	assert.equal(result.sdkUserMessageId, observed.inputs[0].uuid);
	assert.deepEqual(observed.terminals, []);
	assert.deepEqual(
		observed.events
			.filter(({ kind }) => kind === "assistant_delta")
			.map(({ payload }) => [payload.providerMessageId, payload.text]),
		[
			// The first result's answer had no stream, so its own text fills in.
			[`result-${observed.inputs[0].uuid}`, "first answer"],
			["message-2", "both answered"],
		],
	);
	await controller.close();
});

test("a result naming a prompt the turn never sent still fails the stream", async () => {
	const prepared = binding();
	const observed = observations(prepared);
	const controller = await createController(
		prepared,
		observed,
		steeredQuery(observed, (output) => {
			output.push(successResult("12345678-1234-4234-8234-0000000000ff"));
		}),
	);

	await assert.rejects(
		controller.startTurn({ clientMessageId: "unknown-prompt-message-1", input: "hello" }),
		/dure_claude_agent_sdk_stream_failed/u,
	);
	assert.deepEqual(observed.terminals, [{ reason: "sdk_stream_failed" }]);
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

test("a usage-limit failure carries the reset its provider reported, and only that number", async () => {
	const rateLimit = (rate_limit_info) => ({
		rate_limit_info,
		session_id: SESSION_ID,
		type: "rate_limit_event",
		uuid: "bbbbbbbb-0000-4111-8222-333333333333",
	});
	const soon = Math.floor(Date.now() / 1000) + 3600;
	for (const [beforeResult, result, expected] of [
		[[rateLimit({ resetsAt: soon, status: "rejected" })], "You've hit your limit", soon * 1000],
		// A later allowed reading means the rejection no longer applies.
		[
			[
				rateLimit({ resetsAt: soon, status: "rejected" }),
				rateLimit({ resetsAt: soon, status: "allowed" }),
			],
			"You've hit your limit",
			undefined,
		],
		[[], `Claude AI usage limit reached|${soon}`, soon * 1000],
		[[], "You've hit your limit · resets 3pm", undefined],
		[[rateLimit({ resetsAt: soon + 30 * 86_400, status: "rejected" })], "You've hit your limit", undefined],
	]) {
		const prepared = binding(3, null);
		const observed = observations(prepared);
		const controller = await createController(
			prepared,
			observed,
			scriptedQuery(observed, {
				assistantMessages: false,
				beforeResult,
				resultPatch: { is_error: true, result },
			}),
			{ usageLimitErrorPrefixes: SDK_USAGE_LIMIT_PREFIXES },
		);
		await assert.rejects(
			controller.startTurn({ clientMessageId: "limit-reset-turn-1", input: "go" }),
			(error) => error.reason === "usage_limit" && error.resetsAtMs === expected,
		);
		await controller.close();
	}
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
