import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	claudeRuntimeTarget,
	installClaudeRuntimeArtifact,
} from "./claude-runtime-artifact.mjs";
import { connectSharedClaudeSdkHost } from "./shared-sdk-host-client.mjs";
import { HostFrameDecoder, encodeHostFrame } from "./sdk-host-protocol.mjs";
import { startProductionSharedClaudeSdkHost } from "./shared-sdk-host-production.mjs";
import {
	errorReason,
	startSharedClaudeSdkHostServer,
} from "./shared-sdk-host-server.mjs";

const hostGeneration = "host-server-test-1";
const capability = "sdk-host-server-capability-0123456789";
const queryIdentity = Object.freeze({
	runtimeGeneration: "runtime-server-test-1",
	queryEpoch: "query-server-test-1",
	relayId: "relay-server-test-1",
});

function agentSdkError(reason) {
	const error = new Error(`dure_claude_agent_sdk_${reason}`);
	error.code = "DURE_CLAUDE_AGENT_SDK_CONTRACT";
	return error;
}

function passiveInteractionControls() {
	return {
		async answerInteraction() {
			throw agentSdkError("interaction_stale");
		},
		async interruptTurn() {
			return {
				cancelledMessageIds: [],
				receiptAvailable: false,
				stillQueuedMessageIds: [],
			};
		},
		pendingInteractionCount() {
			return 0;
		},
		pendingInteractions() {
			return [];
		},
	};
}

function createQueryFactory() {
	return async ({ emit, terminal }) => {
		let closed = false;
		return {
			...passiveInteractionControls(),
			async startTurn({ input }) {
				emit("assistant_delta", { text: input.toUpperCase() });
				return { stopReason: "end_turn" };
			},
			async close() {
				if (closed) return;
				closed = true;
				terminal({ code: 0, signal: null });
			},
			async invalidate(reason) {
				if (closed) return;
				closed = true;
				terminal({ reason });
			},
		};
	};
}

function createBoundary() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-claude-sdk-host-"));
	fs.chmodSync(root, 0o700);
	const endpoint = path.join(root, "host.sock");
	const capabilityFile = path.join(root, "host-capability");
	fs.writeFileSync(capabilityFile, capability, { flag: "wx", mode: 0o600 });
	return { capabilityFile, endpoint, root };
}

function connection(endpoint, clientGeneration, cursors = {}) {
	return connectSharedClaudeSdkHost({
		capability,
		clientGeneration,
		cursors,
		endpoint,
		hostGeneration,
	});
}

async function waitForCondition(predicate) {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("shared_sdk_host_condition_timeout");
}

test("DCH1 codec reassembles fragmented bounded JSON frames", () => {
	const source = {
		hostGeneration,
		kind: "event",
		payload: { text: "fragmented-한글" },
		serverSequence: 7,
	};
	const encoded = encodeHostFrame(source);
	const decoder = new HostFrameDecoder();
	const frames = [];
	for (let offset = 0; offset < encoded.length; offset += 3) {
		frames.push(...decoder.push(encoded.subarray(offset, offset + 3)));
	}
	decoder.finish();
	assert.deepEqual(frames, [source]);

	const invalidUtf8 = Buffer.from([0x44, 0x43, 0x48, 0x31, 0, 0, 0, 1, 0xff]);
	assert.throws(
		() => new HostFrameDecoder().push(invalidUtf8),
		/dure_claude_sdk_host_protocol_json_invalid/u,
	);
});

test("owner-only host survives detach and reconnects with uncommitted replay", async () => {
	const boundary = createBoundary();
	const server = await startSharedClaudeSdkHostServer({
		...boundary,
		createQuery: createQueryFactory(),
		hostGeneration,
	});
	try {
		assert.equal(fs.existsSync(boundary.capabilityFile), false);
		assert.equal(fs.lstatSync(boundary.endpoint).mode & 0o077, 0);
		const { client: first, snapshot } = await connection(
			boundary.endpoint,
			"client-server-test-1",
		);
		assert.deepEqual(snapshot.queries, []);
		const pushed = [];
		first.onEvent(() => {
			throw new Error("observer_failure");
		});
		first.onEvent((value) => pushed.push(value));
		await first.bind({
			identity: queryIdentity,
			cwd: "/workspace/server-test",
			env: { CLAUDE_CONFIG_DIR: "/credentials/server-test" },
		});
		await first.startTurn(queryIdentity, {
			clientMessageId: "message-server-test-1",
			input: "persist",
		});
		await waitForCondition(() => pushed.length === 4);
		assert.deepEqual(
			pushed.map(({ event }) => [event.sequence, event.kind]),
			[
				[1, "initialized"],
				[2, "user_message_accepted"],
				[3, "assistant_delta"],
				[4, "turn_completed"],
			],
		);
		await first.ack(queryIdentity, 2);
		await first.detach();
		assert.equal(server.host.queryCount, 1);

		const { client: second, snapshot: reattached } = await connection(
			boundary.endpoint,
			"client-server-test-2",
			{ [queryIdentity.runtimeGeneration]: 2 },
		);
		assert.equal(reattached.queries.length, 1);
		assert.deepEqual(reattached.queries[0].replay.events, []);
		assert.equal(reattached.queries[0].replay.hasMore, true);
		const replayed = await second.replay(queryIdentity, 2);
		assert.deepEqual(
			replayed.events.map(({ sequence, kind }) => [sequence, kind]),
			[
				[3, "assistant_delta"],
				[4, "turn_completed"],
			],
		);
		await second.ack(queryIdentity, 4);
		assert.deepEqual((await second.replay(queryIdentity, 4)).events, []);
		assert.equal((await second.beginDrain()).affected.length, 1);
		await second.closeQuery(queryIdentity);
		await assert.rejects(
			second.shutdown(),
			/dure_claude_sdk_host_remote_shutdown_not_drained/u,
		);
		await second.ack(queryIdentity, (await second.replay(queryIdentity, 4)).latestSequence);
		assert.equal(server.host.state, "drained");
		await second.shutdown();
		await server.closed;
		assert.equal(fs.existsSync(boundary.endpoint), false);
	} finally {
		await server.close();
		fs.rmSync(boundary.root, { force: true, recursive: true });
	}
});

test("DCH1 carries a fresh Query replay base without reseeding an existing Query", async () => {
	const boundary = createBoundary();
	const server = await startSharedClaudeSdkHostServer({
		...boundary,
		createQuery: createQueryFactory(),
		hostGeneration,
	});
	try {
		const { client } = await connection(boundary.endpoint, "client-server-replay-base-1");
		const prepared = {
			identity: queryIdentity,
			cwd: "/workspace/server-replay-base",
			env: { CLAUDE_CONFIG_DIR: "/credentials/server-replay-base" },
		};
		const receipt = await client.bind(prepared, { replayBase: 41 });
		assert.deepEqual(
			(await client.replay(queryIdentity, 41)).events.map(({ sequence, kind }) => [
				sequence,
				kind,
			]),
			[[42, "initialized"]],
		);
		assert.deepEqual(await client.bind(prepared, { replayBase: 99 }), receipt);
		assert.equal((await client.replay(queryIdentity, 41)).latestSequence, 42);
		await client.detach();
	} finally {
		await server.close();
		fs.rmSync(boundary.root, { force: true, recursive: true });
	}
});

test("DCH1 routes bounded interaction snapshots, answers, and idempotent interrupts", async () => {
	const boundary = createBoundary();
	let activeClientMessageId;
	let interruptCalls = 0;
	let pending = [];
	let resolveTurn;
	const server = await startSharedClaudeSdkHostServer({
		...boundary,
		hostGeneration,
		createQuery: async ({ emit, terminal }) => ({
			async answerInteraction(answer) {
				const request = pending.find(({ requestId }) => requestId === answer.requestId);
				if (!request) throw agentSdkError("interaction_stale");
				pending = [];
				emit("interaction_resolved", {
					clientMessageId: answer.clientMessageId,
					kind: answer.kind,
					outcome: answer.decision,
					requestId: answer.requestId,
				});
				resolveTurn({ stopReason: "end_turn" });
				return { outcome: answer.decision, requestId: answer.requestId };
			},
			async close() {
				terminal({ code: 0, signal: null });
			},
			async interruptTurn({ clientMessageId }) {
				assert.equal(clientMessageId, activeClientMessageId);
				interruptCalls += 1;
				resolveTurn({ stopReason: "interrupted" });
				return {
					cancelledMessageIds: [],
					receiptAvailable: true,
					stillQueuedMessageIds: [],
				};
			},
			async invalidate(reason) {
				terminal({ reason });
			},
			pendingInteractionCount() {
				return pending.length;
			},
			pendingInteractions() {
				return pending;
			},
			startTurn({ clientMessageId, input }) {
				activeClientMessageId = clientMessageId;
				if (input === "permission") {
					pending = [
						{
							clientMessageId,
							input: { path: "/workspace/server-interaction.txt" },
							kind: "permission",
							requestId: "server-interaction-request-1",
							toolName: "Read",
							toolUseId: "server-tool-use-1",
						},
					];
					emit("interaction_requested", pending[0]);
				}
				return new Promise((resolve) => {
					resolveTurn = resolve;
				});
			},
		}),
	});
	try {
		const { client } = await connection(boundary.endpoint, "client-server-interactions-1");
		await client.bind({
			identity: queryIdentity,
			cwd: "/workspace/server-interactions",
			env: { CLAUDE_CONFIG_DIR: "/credentials/server-interactions" },
		});
		await client.startTurn(queryIdentity, {
			clientMessageId: "message-server-interactions-1",
			input: "permission",
		});
		await waitForCondition(
			async () => (await client.pendingInteractions(queryIdentity)).length === 1,
		);
		assert.equal((await client.snapshot()).queries[0].pendingInteractionCount, 1);
		const pendingSnapshot = await client.pendingSnapshot(queryIdentity);
		assert.equal(
			pendingSnapshot.observedThroughSequence,
			(await client.replay(queryIdentity, 0)).latestSequence,
		);
		assert.equal(pendingSnapshot.requests.length, 1);
		const request = pendingSnapshot.requests[0];
		await client.answerInteraction(queryIdentity, {
			clientMessageId: request.clientMessageId,
			decision: "allow",
			kind: request.kind,
			requestId: request.requestId,
		});
		await assert.rejects(
			client.answerInteraction(queryIdentity, {
				clientMessageId: request.clientMessageId,
				decision: "allow",
				kind: request.kind,
				requestId: request.requestId,
			}),
			/dure_claude_sdk_host_remote_interaction_stale/u,
		);
		await waitForCondition(async () =>
			(await client.snapshot()).queries.every(({ state }) => state === "waiting_for_input"),
		);
		assert.deepEqual(await client.pendingInteractions(queryIdentity), []);
		const resolvedSnapshot = await client.pendingSnapshot(queryIdentity);
		assert.deepEqual(resolvedSnapshot.requests, []);
		assert.equal(
			resolvedSnapshot.observedThroughSequence,
			(await client.replay(queryIdentity, 0)).latestSequence,
		);

		await client.startTurn(queryIdentity, {
			clientMessageId: "message-server-interrupt-1",
			input: "interrupt",
		});
		const interrupt = {
			clientMessageId: "message-server-interrupt-1",
			interruptRequestId: "server-interrupt-request-1",
		};
		const firstReceipt = await client.interruptTurn(queryIdentity, interrupt);
		assert.deepEqual(await client.interruptTurn(queryIdentity, interrupt), firstReceipt);
		assert.equal(interruptCalls, 1);
		await waitForCondition(async () =>
			(await client.snapshot()).queries.every(({ state }) => state === "waiting_for_input"),
		);
		await client.beginDrain();
		await client.closeQuery(queryIdentity);
		await client.ack(queryIdentity, (await client.replay(queryIdentity, 0)).latestSequence);
		await client.shutdown();
		await server.closed;
	} finally {
		await server.close();
		fs.rmSync(boundary.root, { force: true, recursive: true });
	}
});

test("a cold production host accepts its controller before a Query needs a runtime download", async (context) => {
	const boundary = createBoundary();
	const runtimeRoot = path.join(boundary.root, "claude-runtime");
	fs.mkdirSync(runtimeRoot, { mode: 0o700 });
	const download = context.mock.method(globalThis, "fetch", async () => {
		throw new Error("offline QA download");
	});
	let production;
	try {
		production = await startProductionSharedClaudeSdkHost({
			...boundary,
			hostGeneration,
			runtimeRoot,
		});
		const { client, snapshot } = await connection(
			boundary.endpoint,
			"client-cold-host",
		);
		assert.deepEqual(snapshot.queries, []);
		assert.equal(download.mock.callCount(), 0);
		assert.equal(production.runtime, null);
		await assert.rejects(
			client.bind({
				identity: queryIdentity,
				cwd: boundary.root,
				env: { HOME: boundary.root, PATH: process.env.PATH },
			}),
			/download_failed/u,
		);
		assert.equal(download.mock.callCount(), 1);
		assert.deepEqual((await client.snapshot()).queries, []);
		assert.equal(production.runtime, null);
		await client.beginDrain();
		await client.shutdown();
		await production.server.closed;
	} finally {
		await production?.server.close();
		fs.rmSync(boundary.root, { force: true, recursive: true });
	}
});

test("the production host imports the pinned SDK once and stays process-lazy before bind", async () => {
	const boundary = createBoundary();
	const runtimeRoot = path.join(boundary.root, "claude-runtime");
	await installClaudeRuntimeArtifact({
		claudeCodeVersion: "2.1.234",
		runtimeRoot,
		sdkVersion: "0.3.234",
		sourceExecutable: fileURLToPath(
			new URL("../../tests/fixtures/fake-claude-agent-sdk-cli.mjs", import.meta.url),
		),
		target: claudeRuntimeTarget(),
	});
	const production = await startProductionSharedClaudeSdkHost({
		...boundary,
		hostGeneration,
		runtimeRoot,
	});
	const { sdk, server } = production;
	try {
		assert.equal(sdk.sdkVersion, "0.3.234");
		assert.equal(sdk.claudeCodeVersion, "2.1.234");
		assert.equal(production.runtime, null);
		assert.equal(server.host.queryCount, 0);
		const { client, snapshot } = await connection(
			boundary.endpoint,
			"client-production-host-test-1",
		);
		assert.deepEqual(snapshot.queries, []);
		await assert.rejects(client.bind({
			identity: queryIdentity,
			cwd: boundary.root,
			env: { HOME: boundary.root, PATH: process.env.PATH },
		}), /process_binding_required/u);
		assert.equal(production.runtime.sdkVersion, "0.3.234");
		assert.equal(production.runtime.claudeCodeVersion, "2.1.234");
		assert.deepEqual((await client.beginDrain()).affected, []);
		await client.shutdown();
		await server.closed;
	} finally {
		await server.close();
		fs.rmSync(boundary.root, { force: true, recursive: true });
	}
});

test("host refuses a group-readable endpoint boundary before binding", async () => {
	const boundary = createBoundary();
	fs.chmodSync(boundary.root, 0o750);
	try {
		await assert.rejects(
			startSharedClaudeSdkHostServer({
				...boundary,
				createQuery: createQueryFactory(),
				hostGeneration,
			}),
			/dure_claude_sdk_host_server_endpoint_parent_unsafe/u,
		);
		assert.equal(fs.existsSync(boundary.endpoint), false);
		assert.equal(fs.existsSync(boundary.capabilityFile), true);
	} finally {
		fs.rmSync(boundary.root, { force: true, recursive: true });
	}
});

test("host rejects an overlong Unix socket path before consuming its capability", async () => {
	const boundary = createBoundary();
	boundary.endpoint = path.join(boundary.root, "s".repeat(100));
	try {
		await assert.rejects(
			startSharedClaudeSdkHostServer({
				...boundary,
				createQuery: createQueryFactory(),
				hostGeneration,
			}),
			/dure_claude_sdk_host_server_endpoint_path_too_long/u,
		);
		assert.equal(fs.existsSync(boundary.capabilityFile), true);
	} finally {
		fs.rmSync(boundary.root, { force: true, recursive: true });
	}
});

test("supervisor shutdown invalidates live Queries before closing the endpoint", async () => {
	const boundary = createBoundary();
	const server = await startSharedClaudeSdkHostServer({
		...boundary,
		createQuery: createQueryFactory(),
		hostGeneration,
	});
	try {
		const { client } = await connection(boundary.endpoint, "client-server-shutdown-1");
		await client.bind({
			identity: queryIdentity,
			cwd: "/workspace/server-shutdown",
			env: { CLAUDE_CONFIG_DIR: "/credentials/server-shutdown" },
		});
		assert.equal(server.host.queryCount, 1);
		await server.close();
		assert.equal(server.host.state, "failed");
		assert.equal(server.host.queryCount, 0);
		assert.equal(fs.existsSync(boundary.endpoint), false);
	} finally {
		await server.close();
		fs.rmSync(boundary.root, { force: true, recursive: true });
	}
});

test("starting one long turn does not serialize another Query's control request", async () => {
	const boundary = createBoundary();
	const releases = [];
	let starts = 0;
	const server = await startSharedClaudeSdkHostServer({
		...boundary,
		hostGeneration,
		createQuery: async ({ terminal }) => ({
			...passiveInteractionControls(),
			startTurn() {
				starts += 1;
				return new Promise((resolve) => releases.push(resolve));
			},
			async close() {
				terminal({ code: 0, signal: null });
			},
			async invalidate(reason) {
				terminal({ reason });
			},
		}),
	});
	try {
		const { client } = await connection(boundary.endpoint, "client-server-concurrency-1");
		const identities = [
			queryIdentity,
			{
				relayId: "relay-server-test-2",
				queryEpoch: "query-server-test-2",
				runtimeGeneration: "runtime-server-test-2",
			},
		];
		for (const identity of identities) {
			await client.bind({
				identity,
				cwd: "/workspace/server-concurrency",
				env: { CLAUDE_CONFIG_DIR: "/credentials/server-concurrency" },
			});
		}
		for (let index = 0; index < identities.length; index += 1) {
			await Promise.race([
				client.startTurn(identities[index], {
					clientMessageId: `message-server-concurrency-${index}`,
					input: `turn-${index}`,
				}),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("start_turn_response_blocked")), 100),
				),
			]);
		}
		await waitForCondition(() => starts === 2);
		for (const release of releases) release({ stopReason: "end_turn" });
		await waitForCondition(async () => {
			const snapshots = await client.snapshot();
			return snapshots.queries.every(({ state }) => state === "waiting_for_input");
		});
		await client.beginDrain();
		for (const identity of identities) {
			await client.closeQuery(identity);
			await client.ack(identity, (await client.replay(identity, 0)).latestSequence);
		}
		await client.shutdown();
		await server.closed;
	} finally {
		await server.close();
		fs.rmSync(boundary.root, { force: true, recursive: true });
	}
});

test("errorReason surfaces adapter reasons and sanitizes unexpected messages", () => {
	// Adapter failures (agent-sdk-query) must reach the runtime journal as
	// their own reason, not collapse into a bare "internal_error".
	assert.equal(
		errorReason(new Error("dure_claude_agent_sdk_spawn_arguments_invalid")),
		"spawn_arguments_invalid",
	);
	assert.equal(
		errorReason(new Error("dure_claude_sdk_host_effort_invalid")),
		"effort_invalid",
	);
	// Unexpected exceptions stay bounded but keep their one diagnostic fact.
	assert.equal(
		errorReason(new TypeError("Cannot read properties of undefined (reading 'x')")),
		"internal_error_cannot_read_properties_of_undefined_reading_x",
	);
	assert.equal(errorReason({ message: 42 }), "internal_error");
});
