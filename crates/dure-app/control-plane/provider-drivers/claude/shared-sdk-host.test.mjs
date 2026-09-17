import assert from "node:assert/strict";
import test from "node:test";

import { MAX_HOST_FRAME_BYTES, encodeHostFrame } from "./sdk-host-protocol.mjs";
import { createSharedClaudeSdkHost } from "./shared-sdk-host.mjs";

function identity(index, generation = 1) {
	return Object.freeze({
		runtimeGeneration: `runtime-${index}-g${generation}`,
		queryEpoch: `query-${index}-g${generation}`,
		relayId: `relay-${index}-g${generation}`,
	});
}

function binding(index, generation = 1) {
	return {
		identity: identity(index, generation),
		cwd: `/workspace/${index}`,
		env: {
			CLAUDE_CONFIG_DIR: `/credentials/${index}`,
			DURE_QUERY_INDEX: String(index),
		},
	};
}

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

function fakeQueryFactory(observations = []) {
	return async ({ binding: prepared, emit, terminal }) => {
		observations.push({
			identity: prepared.identity,
			cwd: prepared.cwd,
			env: prepared.env,
			effort: prepared.effort,
			model: prepared.model,
			permissionMode: prepared.permissionMode,
		});
		let closed = false;
		return {
			...passiveInteractionControls(),
			async startTurn({ input }) {
				assert.equal(closed, false);
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

function attach(host, clientGeneration, cursors = {}) {
	return host.attach({
		hostGeneration: host.hostGeneration,
		clientGeneration,
		cursors,
	});
}

async function waitForReplay(client, queryIdentity, predicate) {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		const replay = client.replay(queryIdentity, 0);
		if (predicate(replay)) return replay;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("shared_sdk_host_replay_timeout");
}

async function retireAndAck(client, prepared, allowedTarget = null) {
	const retired = await client.retireQueryIfIdle(prepared.identity, { allowedTarget });
	assert.equal(retired.outcome, "retired");
	assert.equal(retired.replayCommitted, false);
	const replay = client.replay(prepared.identity, 0);
	client.ack(prepared.identity, replay.latestSequence);
	const committed = client.queryRetirementStatus(prepared.identity);
	assert.equal(committed.outcome, "already_retired");
	assert.equal(committed.replayCommitted, true);
	return committed.authority;
}

test("each query receives its own conversation instructions", async () => {
	const received = [];
	const factory = fakeQueryFactory();
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-instructions-1",
		createQuery: async (options) => {
			received.push(options.binding.instructions);
			return factory(options);
		},
		readHistory: async () => ({ items: [], status: "complete" }),
	});
	const client = attach(host, "client-instructions-1");
	for (const index of [1, 2]) {
		await client.bind({ ...binding(index), instructions: `Dure agent ID: agent-${index}` });
	}
	assert.deepEqual(received, ["Dure agent ID: agent-1", "Dure agent ID: agent-2"]);
	await assert.rejects(
		client.bind({ ...binding(1), instructions: "Dure agent ID: agent-2" }),
		/dure_claude_sdk_host_runtime_generation_conflict/u,
	);
	client.detach();
});

test("private history pages never advance live replay and release idempotently", async () => {
	const items = Array.from({ length: 70 }, (_, index) => ({
		body: { markdown: `history ${index}`, role: "assistant", type: "message" },
		createdAtMs: index,
		providerMessageId: `provider-message-${index}`,
		sourceId: `source-${index}:message:0`,
	}));
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-history-pages-1",
		createQuery: fakeQueryFactory(),
		readHistory: async () => ({ items, status: "complete" }),
	});
	const client = attach(host, "client-history-pages-1");
	const prepared = {
		...binding(500),
		providerSessionId: "session-history-500",
	};
	await client.bind(prepared);
	assert.equal(client.replay(prepared.identity, 0).latestSequence, 1);
	const first = client.historyPage(prepared.identity, 0);
	const second = client.historyPage(prepared.identity, first.nextOffset);
	assert.equal(first.offset, 0);
	assert.equal(first.hasMore, true);
	assert.equal(second.hasMore, false);
	assert.equal(first.items.length + second.items.length, items.length);
	assert.equal(second.nextOffset, items.length);
	assert.equal(client.replay(prepared.identity, 0).latestSequence, 1);
	assert.deepEqual(client.ackHistory(prepared.identity), { released: true });
	assert.deepEqual(client.ackHistory(prepared.identity), { released: true });
	assert.throws(
		() => client.historyPage(prepared.identity, 0),
		/dure_claude_sdk_host_history_page_released/u,
	);
	client.detach();
});

function releaseAndConfirm(client, authority) {
	const released = client.releaseQueryRetirement(authority);
	assert.ok(new Set(["released", "already_released"]).has(released.outcome));
	assert.equal(released.authority.phase, "released");
	assert.ok(
		new Set(["confirmed", "already_absent"]).has(
			client.confirmQueryRetirementRelease(released.authority).outcome,
		),
	);
	return released.authority;
}

test("one shared host lazily binds 1, 5, and 20 isolated fake Queries", async () => {
	for (const count of [1, 5, 20]) {
		const observations = [];
		const ambientConfig = process.env.CLAUDE_CONFIG_DIR;
		const host = createSharedClaudeSdkHost({
			hostGeneration: `host-matrix-${count}`,
			createQuery: fakeQueryFactory(observations),
		});
		assert.equal(host.queryCount, 0);
		assert.equal(observations.length, 0);

		const client = attach(host, `client-matrix-${count}`);
		for (let index = 0; index < count; index += 1) {
			await client.bind(binding(index));
		}

		assert.equal(host.queryCount, count);
		assert.equal(observations.length, count);
		assert.equal(process.env.CLAUDE_CONFIG_DIR, ambientConfig);
		assert.equal(new Set(observations.map(({ env }) => env.CLAUDE_CONFIG_DIR)).size, count);
		assert.equal(new Set(observations.map(({ identity: value }) => value.relayId)).size, count);
		client.detach();
	}
});

test("provider session establishment monotonically advances surviving and replacement bindings", async () => {
	const observations = [];
	const emitters = new Map();
	const createFakeQuery = fakeQueryFactory(observations);
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-provider-session-projection-1",
		createQuery: async (context) => {
			emitters.set(context.binding.identity.runtimeGeneration, context.emit);
			return createFakeQuery(context);
		},
	});
	let client = attach(host, "client-provider-session-projection-1");
	const prepared = binding(501);
	const receipt = await client.bind(prepared);
	const providerSessionId = "session-established-501";
	emitters.get(prepared.identity.runtimeGeneration)("provider_session_initialized", {
		providerSessionId,
	});
	client.detach();

	client = attach(host, "client-provider-session-projection-2");
	const established = { ...prepared, providerSessionId };
	assert.deepEqual(await client.bind(established), receipt);
	assert.equal(client.snapshot().queries[0].providerSessionId, providerSessionId);
	assert.deepEqual(
		await client.bind(prepared),
		receipt,
		"a lost original bind response may replay its weaker pre-initialization request",
	);
	assert.equal(client.snapshot().queries[0].providerSessionId, providerSessionId);
	await assert.rejects(
		client.bind({ ...prepared, providerSessionId: "session-conflict-501" }),
		/dure_claude_sdk_host_runtime_generation_conflict/u,
	);

	const source = { ...binding(502), providerSessionId: "session-source-502" };
	const target = binding(502, 2);
	await client.bind(source);
	const authority = await retireAndAck(client, source, target.identity);
	await client.bind(target, { authority });
	const targetProviderSessionId = "session-target-502";
	emitters.get(target.identity.runtimeGeneration)("provider_session_initialized", {
		providerSessionId: targetProviderSessionId,
	});
	assert.equal(
		client.commitQueryReplacement(authority, target.identity).outcome,
		"target_bound",
	);
	await client.bind({ ...target, providerSessionId: targetProviderSessionId });
	assert.equal(observations.length, 3);
	client.detach();
});

test("a fresh Query seeds its durable replay base exactly once", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-replay-base-1",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-replay-base-1");
	const prepared = binding(503);
	const receipt = await client.bind(prepared, { replayBase: 7 });
	assert.deepEqual(
		client.replay(prepared.identity, 7).events.map(({ sequence, kind }) => [sequence, kind]),
		[[8, "initialized"]],
	);
	assert.deepEqual(client.replay(prepared.identity, 0).gap, {
		requestedAfter: 0,
		droppedThrough: 7,
	});

	assert.deepEqual(
		await client.bind(prepared, { replayBase: 99 }),
		receipt,
		"an existing Query must never be reseeded by a later bind",
	);
	assert.equal(client.replay(prepared.identity, 7).latestSequence, 8);
	client.detach();
});

test("Query bindings normalize legacy defaults and exact structured selections", async () => {
	const observations = [];
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-structured-selections-1",
		createQuery: fakeQueryFactory(observations),
	});
	const client = attach(host, "client-structured-selections-1");
	await client.bind(binding(300));

	const efforts = ["low", "medium", "high", "xhigh", "max"];
	for (let index = 0; index < efforts.length; index += 1) {
		await client.bind({
			...binding(301 + index),
			effort: efforts[index],
			model: "claude-sonnet-4-6",
			permissionMode: index === 0 ? "skip_permissions" : "default",
		});
	}

	assert.equal(observations[0].permissionMode, "default");
	assert.equal(observations[0].model, null);
	assert.equal(observations[0].effort, null);
	assert.deepEqual(
		observations.slice(1).map(({ effort }) => effort),
		efforts,
	);
	assert.equal(observations[1].permissionMode, "skip_permissions");
	assert.equal(observations[1].model, "claude-sonnet-4-6");
	client.detach();
});

test("Query binding normalization rejects invalid structured selections", async () => {
	const observations = [];
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-invalid-structured-selections-1",
		createQuery: fakeQueryFactory(observations),
	});
	const client = attach(host, "client-invalid-structured-selections-1");
	const invalid = [
		["permissionMode", null, /dure_claude_sdk_host_permission_mode_invalid/u],
		["permissionMode", "bypassPermissions", /dure_claude_sdk_host_permission_mode_invalid/u],
		["model", null, /dure_claude_sdk_host_model_invalid/u],
		["model", "has space", /dure_claude_sdk_host_model_invalid/u],
		["model", "x".repeat(65), /dure_claude_sdk_host_model_invalid/u],
		["effort", null, /dure_claude_sdk_host_effort_invalid/u],
		["effort", "***", /dure_claude_sdk_host_effort_invalid/u],
	];
	for (let index = 0; index < invalid.length; index += 1) {
		const [field, value, expected] = invalid[index];
		await assert.rejects(client.bind({ ...binding(400 + index), [field]: value }), expected);
	}
	assert.equal(observations.length, 0);
	assert.equal(host.queryCount, 0);
	client.detach();
});

test("the maximum retained Query snapshot remains one bounded metadata frame", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-snapshot-capacity-1",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-snapshot-capacity-1");
	for (let index = 0; index < 128; index += 1) {
		const suffix = String(index).padStart(3, "0");
		const paddedToken = (prefix) => `${prefix}${"x".repeat(124)}${suffix}`;
		await client.bind({
			identity: {
				relayId: paddedToken("r"),
				queryEpoch: paddedToken("q"),
				runtimeGeneration: paddedToken("g"),
			},
			cwd: `/workspace/snapshot/${index}`,
			env: {},
			providerSessionId: paddedToken("s"),
		});
	}
	const frame = encodeHostFrame({
		hostGeneration: host.hostGeneration,
		kind: "response",
		ok: true,
		requestSequence: 1,
		result: client.snapshot(),
		serverSequence: 1,
	});
	assert.ok(frame.length <= MAX_HOST_FRAME_BYTES + 8);
	await assert.rejects(
		client.bind(binding(200)),
		/dure_claude_sdk_host_query_record_capacity_exceeded/u,
	);
	client.detach();
});

test("aggregate snapshots read O(1) interaction counts without cloning Query payloads", async () => {
	let payloadReads = 0;
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-snapshot-interaction-count-1",
		createQuery: async ({ terminal }) => ({
			...passiveInteractionControls(),
			async close() {
				terminal({ code: 0, signal: null });
			},
			async invalidate(reason) {
				terminal({ reason });
			},
			pendingInteractionCount() {
				return 1;
			},
			pendingInteractions() {
				payloadReads += 1;
				return [{ input: { text: "must-not-be-cloned" }, requestId: "pending-1" }];
			},
			async startTurn() {
				return { stopReason: "end_turn" };
			},
		}),
	});
	const client = attach(host, "client-snapshot-interaction-count-1");
	await client.bind(binding(201));
	assert.equal(client.snapshot().queries[0].pendingInteractionCount, 1);
	assert.equal(payloadReads, 0);
	assert.equal(client.pendingInteractions(identity(201)).length, 1);
	assert.equal(payloadReads, 1);
	client.detach();
});

test("client detach preserves Queries and reconnect replays only uncommitted ordered events", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-reconnect-1",
		createQuery: fakeQueryFactory(),
	});
	const first = attach(host, "client-reconnect-1");
	const prepared = binding(1);
	await first.bind(prepared);
	await first.startTurn(prepared.identity, {
		clientMessageId: "message-1",
		input: "first",
	});
	const beforeDetach = await waitForReplay(
		first,
		prepared.identity,
		({ latestSequence }) => latestSequence === 4,
	);
	assert.deepEqual(
		beforeDetach.events.map(({ sequence, kind }) => [sequence, kind]),
		[
			[1, "initialized"],
			[2, "user_message_accepted"],
			[3, "assistant_delta"],
			[4, "turn_completed"],
		],
	);
	first.ack(prepared.identity, 2);
	first.detach();

	assert.equal(host.queryCount, 1);
	const second = attach(host, "client-reconnect-2", {
		[prepared.identity.runtimeGeneration]: 2,
	});
	const snapshot = second.snapshot();
	assert.deepEqual(snapshot.queries[0].replay.events, []);
	assert.equal(snapshot.queries[0].replay.hasMore, true);
	const replayed = second.replay(prepared.identity, 2);
	assert.equal(replayed.gap, null);
	assert.deepEqual(
		replayed.events.map(({ sequence, kind }) => [sequence, kind]),
		[
			[3, "assistant_delta"],
			[4, "turn_completed"],
		],
	);
	second.ack(prepared.identity, 4);
	assert.deepEqual(second.replay(prepared.identity, 4).events, []);
	second.detach();
});

test("idle-fenced close preserves a Query that started a turn before replacement", async () => {
	let finishTurn;
	let finishClose;
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-idle-close-1",
		createQuery: async ({ terminal }) => ({
			...passiveInteractionControls(),
			startTurn() {
				return new Promise((resolve) => {
					finishTurn = resolve;
				});
			},
			close() {
				return new Promise((resolve) => {
					finishClose = () => {
						terminal({ code: 0, signal: null });
						resolve();
					};
				});
			},
			async invalidate(reason) {
				terminal({ reason });
			},
		}),
	});
	const client = attach(host, "client-idle-close-1");
	const prepared = binding(202);
	await client.bind(prepared);
	client.startTurn(prepared.identity, {
		clientMessageId: "message-idle-close-1",
		input: "still running",
	});

	await assert.rejects(client.closeQueryIfIdle(prepared.identity), /query_busy/u);
	assert.equal(host.queryCount, 1);
	finishTurn({ stopReason: "end_turn" });
	await waitForReplay(
		client,
		prepared.identity,
		({ latestSequence }) => latestSequence === 3,
	);
	const close = client.closeQueryIfIdle(prepared.identity);
	assert.throws(
		() =>
			client.startTurn(prepared.identity, {
				clientMessageId: "message-idle-close-2",
				input: "must not race retirement",
			}),
		/query_busy/u,
	);
	finishClose();
	await close;
	assert.equal(host.queryCount, 0);
});

test("force retirement fences every provider effect while controller close is pending", async () => {
	let finishClose;
	let answerCalls = 0;
	let interruptCalls = 0;
	let startCalls = 0;
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-force-retire-race-1",
		createQuery: async ({ terminal }) => ({
			...passiveInteractionControls(),
			async answerInteraction() {
				answerCalls += 1;
			},
			close() {
				return new Promise((resolve) => {
					finishClose = () => {
						terminal({ code: 0, signal: null });
						resolve();
					};
				});
			},
			async interruptTurn() {
				interruptCalls += 1;
				return {
					cancelledMessageIds: [],
					receiptAvailable: false,
					stillQueuedMessageIds: [],
				};
			},
			invalidate(reason) {
				terminal({ reason });
			},
			startTurn() {
				startCalls += 1;
				return new Promise(() => {});
			},
		}),
	});
	const client = attach(host, "client-force-retire-race-1");
	const prepared = binding(205);
	await client.bind(prepared);
	client.startTurn(prepared.identity, {
		clientMessageId: "message-force-retire-race-1",
		input: "active effect",
	});
	await Promise.resolve();
	assert.equal(startCalls, 1);

	const retirement = client.retireQuery(prepared.identity);
	assert.throws(
		() =>
			client.startTurn(prepared.identity, {
				clientMessageId: "message-force-retire-race-2",
				input: "must stay fenced",
			}),
		/query_busy/u,
	);
	await assert.rejects(
		client.interruptTurn(prepared.identity, {
			clientMessageId: "message-force-retire-race-1",
			interruptRequestId: "interrupt-force-retire-race-1",
		}),
		/query_busy/u,
	);
	await assert.rejects(
		client.answerInteraction(prepared.identity, {
			clientMessageId: "message-force-retire-race-1",
			decision: "allow",
			kind: "permission",
			requestId: "interaction-force-retire-race-1",
		}),
		/query_busy/u,
	);
	assert.equal(startCalls, 1);
	assert.equal(interruptCalls, 0);
	assert.equal(answerCalls, 0);

	finishClose();
	const retired = await retirement;
	assert.deepEqual(retired.identity, prepared.identity);
	assert.equal(retired.outcome, "retired");
	assert.equal(retired.replayCommitted, false);
	assert.equal(retired.authority.phase, "retired");
});

test("exact retirement retries only after terminal replay has an ACK tombstone", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-exact-retirement-1",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-exact-retirement-1");
	const prepared = binding(203);
	await client.bind(prepared);
	const retired = await client.retireQueryIfIdle(prepared.identity);
	assert.deepEqual(retired.identity, prepared.identity);
	assert.equal(retired.outcome, "retired");
	assert.equal(retired.replayCommitted, false);
	assert.equal(retired.authority.phase, "retired");
	assert.equal(retired.authority.allowedTarget, null);
	assert.deepEqual(client.queryRetirementStatus(prepared.identity), {
		...retired,
		outcome: "already_retired",
	});
	const replay = client.replay(prepared.identity, 0);
	client.ack(prepared.identity, replay.latestSequence);
	assert.deepEqual(client.queryRetirementStatus(prepared.identity), {
		authority: retired.authority,
		identity: prepared.identity,
		outcome: "already_retired",
		replayCommitted: true,
	});
	assert.deepEqual(await client.retireQueryIfIdle(prepared.identity), {
		authority: retired.authority,
		identity: prepared.identity,
		outcome: "already_retired",
		replayCommitted: true,
	});
	await assert.rejects(
		async () =>
			client.queryRetirementStatus({
				...prepared.identity,
				queryEpoch: "query-conflict-g1",
			}),
		/query_identity_conflict/u,
	);
	await assert.rejects(
		async () => client.queryRetirementStatus(identity(9_999)),
		/stale_query_identity/u,
	);
	const released = client.releaseQueryRetirement(retired.authority);
	assert.deepEqual(released, {
		authority: { ...retired.authority, phase: "released" },
		outcome: "released",
	});
	assert.deepEqual(client.releaseQueryRetirement(retired.authority), released);
	assert.deepEqual(client.confirmQueryRetirementRelease(released.authority), {
		authority: released.authority,
		outcome: "confirmed",
	});
	assert.deepEqual(client.confirmQueryRetirementRelease(released.authority), {
		authority: released.authority,
		outcome: "already_absent",
	});
});

test("durably released terminal retirements do not exhaust tombstone capacity", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-retirement-capacity-1",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-retirement-capacity-1");
	for (let index = 1_000; index < 1_140; index += 1) {
		const prepared = binding(index);
		await client.bind(prepared);
		const authority = await retireAndAck(client, prepared);
		const released = client.releaseQueryRetirement(authority);
		assert.equal(released.outcome, "released");
		assert.equal(client.confirmQueryRetirementRelease(released.authority).outcome, "confirmed");
	}
	assert.equal(host.queryCount, 0);
});

test("a same-host Claude successor consumes its exact retirement fence", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-retirement-successor-1",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-retirement-successor-1");
	const source = binding(204);
	await client.bind(source);
	const target = binding(204, 2);
	const authority = await retireAndAck(client, source, target.identity);
	await client.bind(target, { authority });
	const committed = client.commitQueryReplacement(authority, target.identity);
	assert.deepEqual(
		client.commitQueryReplacement(authority, target.identity),
		committed,
	);
	releaseAndConfirm(client, committed.authority);
	assert.equal(host.queryCount, 1);
});

test("a stale retired receipt releases a provider-committed replacement after response loss", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-commit-loss-1",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-commit-loss-1");
	const source = binding(205);
	const target = binding(205, 2);
	await client.bind(source);
	const retired = await retireAndAck(client, source, target.identity);
	await client.bind(target, { authority: retired });
	client.commitQueryReplacement(retired, target.identity);

	const failedTarget = await retireAndAck(client, target);
	const released = releaseAndConfirm(client, retired);
	assert.deepEqual(released.targetHost, {
		hostGeneration: host.hostGeneration,
		hostInstanceId: host.hostInstanceId,
	});
	releaseAndConfirm(client, failedTarget);
	assert.equal(host.queryCount, 0);
});

test("a dropped replacement bind response replays one exact Query receipt", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-bind-replay-1",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-bind-replay-1");
	const source = binding(206);
	await client.bind(source);
	const target = binding(206, 2);
	const authority = await retireAndAck(client, source, target.identity);
	const dropped = await client.bind(target, { authority });

	assert.deepEqual(await client.bind(target, { authority }), dropped);
	assert.equal(host.queryCount, 1);
});

test("a fresh host adopts one durably retired source for its exact target", async () => {
	const oldHost = createSharedClaudeSdkHost({
		hostGeneration: "host-retirement-owner-1",
		createQuery: fakeQueryFactory(),
	});
	const oldClient = attach(oldHost, "client-retirement-owner-1");
	const source = binding(207);
	await oldClient.bind(source);
	const target = binding(207, 2);
	const authority = await retireAndAck(oldClient, source, target.identity);

	const freshHost = createSharedClaudeSdkHost({
		hostGeneration: "host-retirement-owner-2",
		createQuery: fakeQueryFactory(),
	});
	const freshClient = attach(freshHost, "client-retirement-owner-2");
	const receipt = await freshClient.bind(target, { authority });
	assert.deepEqual(receipt.identity, target.identity);
	assert.equal(receipt.state, "waiting_for_input");
	assert.deepEqual(receipt.hostIdentity, {
		hostGeneration: freshHost.hostGeneration,
		hostInstanceId: freshHost.hostInstanceId,
	});
	assert.equal(freshHost.queryCount, 1);
});

test("a fresh host reconstructs one v4 retirement authority from durable migration proof", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-v4-retirement-recovery-1",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-v4-retirement-recovery-1");
	const source = binding(2_070);
	const target = binding(2_070, 2);
	const recovered = client.recoverQueryRetirement(source.identity, {
		allowedTarget: target.identity,
	});

	assert.equal(recovered.outcome, "recovered");
	assert.equal(recovered.replayCommitted, true);
	assert.equal(recovered.authority.phase, "retired");
	assert.deepEqual(recovered.authority.allowedTarget, target.identity);
	await client.bind(target, { authority: recovered.authority });
	const committed = client.commitQueryReplacement(
		recovered.authority,
		target.identity,
	).authority;
	releaseAndConfirm(client, committed);
	assert.equal(host.queryCount, 1);
});

test("v4 retirement recovery rejects an active source and a conflicting successor", async () => {
	const activeHost = createSharedClaudeSdkHost({
		hostGeneration: "host-v4-retirement-active-1",
		createQuery: fakeQueryFactory(),
	});
	const activeClient = attach(activeHost, "client-v4-retirement-active-1");
	const activeSource = binding(2_072);
	await activeClient.bind(activeSource);
	assert.throws(
		() =>
			activeClient.recoverQueryRetirement(activeSource.identity, {
				allowedTarget: binding(2_072, 2).identity,
			}),
		/dure_claude_sdk_host_retirement_authority_conflict/u,
	);

	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-v4-retirement-conflict-1",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-v4-retirement-conflict-1");
	const source = binding(2_073);
	client.recoverQueryRetirement(source.identity, {
		allowedTarget: binding(2_073, 2).identity,
	});
	assert.throws(
		() =>
			client.recoverQueryRetirement(source.identity, {
				allowedTarget: binding(2_073, 3).identity,
			}),
		/dure_claude_sdk_host_retirement_authority_conflict/u,
	);

	const unpoisonedHost = createSharedClaudeSdkHost({
		hostGeneration: "host-v4-retirement-invalid-target-1",
		createQuery: fakeQueryFactory(),
	});
	const unpoisonedClient = attach(
		unpoisonedHost,
		"client-v4-retirement-invalid-target-1",
	);
	const unpoisonedSource = binding(2_074);
	for (const invalidTarget of [
		unpoisonedSource.identity,
		{ ...binding(2_075).identity, queryEpoch: unpoisonedSource.identity.queryEpoch },
		{ ...binding(2_076).identity, relayId: unpoisonedSource.identity.relayId },
	]) {
		assert.throws(
			() =>
				unpoisonedClient.recoverQueryRetirement(unpoisonedSource.identity, {
					allowedTarget: invalidTarget,
				}),
			/dure_claude_sdk_host_retirement_authority_invalid/u,
		);
	}
	const validTarget = binding(2_074, 2);
	assert.equal(
		unpoisonedClient.recoverQueryRetirement(unpoisonedSource.identity, {
			allowedTarget: validTarget.identity,
		}).outcome,
		"recovered",
		"an invalid recovery must not poison or consume the source tombstone slot",
	);
});

test("an Attached target replays its own bind receipt without its predecessor", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-attached-replay-1",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-attached-replay-1");
	const source = binding(208);
	await client.bind(source);
	const target = binding(208, 2);
	const authority = await retireAndAck(client, source, target.identity);
	const attached = await client.bind(target, { authority });

	assert.deepEqual(await client.bind(target), attached);
	assert.equal(host.queryCount, 1);
});

test("an Attached target recreates once after its owning host exits without resending its predecessor", async () => {
	const oldHost = createSharedClaudeSdkHost({
		hostGeneration: "host-attached-restart-1",
		createQuery: fakeQueryFactory(),
	});
	const oldClient = attach(oldHost, "client-attached-restart-1");
	const source = binding(209);
	const target = binding(209, 2);
	await oldClient.bind(source);
	const authority = await retireAndAck(oldClient, source, target.identity);
	await oldClient.bind(target, { authority });
	const committed = oldClient.commitQueryReplacement(authority, target.identity).authority;
	await oldHost.fail("host_process_exited");

	const freshHost = createSharedClaudeSdkHost({
		hostGeneration: "host-attached-restart-1",
		createQuery: fakeQueryFactory(),
	});
	const freshClient = attach(freshHost, "client-attached-restart-2");
	await freshClient.bind(target);
	releaseAndConfirm(freshClient, committed);
	assert.equal(freshHost.queryCount, 1);
});

test("Attached recovery preserves one target across every replacement-finalize response-loss cut", async () => {
	for (const [index, cut] of ["retired", "target_bound", "released"].entries()) {
		const hostGeneration = `host-attached-finalize-${cut}`;
		const oldHost = createSharedClaudeSdkHost({
			hostGeneration,
			createQuery: fakeQueryFactory(),
		});
		const oldClient = attach(oldHost, `client-attached-finalize-${cut}-1`);
		const source = binding(2_080 + index);
		const target = binding(2_080 + index, 2);
		await oldClient.bind(source);
		let authority = await retireAndAck(oldClient, source, target.identity);
		await oldClient.bind(target, { authority });
		if (cut !== "retired") {
			authority = oldClient.commitQueryReplacement(
				authority,
				target.identity,
			).authority;
		}
		if (cut === "released") {
			authority = oldClient.releaseQueryRetirement(authority).authority;
		}
		await oldHost.fail("host_process_exited");

		const freshHost = createSharedClaudeSdkHost({
			hostGeneration,
			createQuery: fakeQueryFactory(),
		});
		const freshClient = attach(freshHost, `client-attached-finalize-${cut}-2`);
		const receipt = await freshClient.bind(target);
		if (cut === "retired") {
			authority = freshClient.commitQueryReplacement(
				authority,
				target.identity,
			).authority;
		}
		if (cut !== "released") {
			authority = freshClient.releaseQueryRetirement(authority).authority;
		}
		assert.ok(
			new Set(["confirmed", "already_absent"]).has(
				freshClient.confirmQueryRetirementRelease(authority).outcome,
			),
		);
		assert.deepEqual(receipt.identity, target.identity);
		assert.equal(freshHost.queryCount, 1);
	}
});

test("more than 129 pre-bind repairs retarget one source authority without leaking tombstones", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-pre-bind-repairs-1",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-pre-bind-repairs-1");
	const source = binding(2_100);
	let target = binding(2_100, 2);
	await client.bind(source);
	let authority = await retireAndAck(client, source, target.identity);
	for (let generation = 3; generation < 143; generation += 1) {
		target = binding(2_100, generation);
		authority = client.retargetQueryRetirement(authority, target.identity).authority;
	}
	await client.bind(target, { authority });
	const committed = client.commitQueryReplacement(authority, target.identity).authority;
	releaseAndConfirm(client, committed);
	assert.equal(host.queryCount, 1);
});

test("an imported cross-host retirement authority admits its exact replacement bind", async () => {
	const oldHost = createSharedClaudeSdkHost({
		hostGeneration: "host-imported-authority-old",
		createQuery: fakeQueryFactory(),
	});
	const oldClient = attach(oldHost, "client-imported-authority-old");
	const source = binding(2_150);
	await oldClient.bind(source);
	const sourceAuthority = await retireAndAck(oldClient, source);

	const replacementHost = createSharedClaudeSdkHost({
		hostGeneration: "host-imported-authority-new",
		createQuery: fakeQueryFactory(),
	});
	const replacementClient = attach(
		replacementHost,
		"client-imported-authority-new",
	);
	const target = binding(2_150, 2);
	const replacementAuthority = replacementClient.retargetQueryRetirement(
		sourceAuthority,
		target.identity,
	).authority;
	const conflictingAuthority = {
		...replacementAuthority,
		sourceHost: {
			...replacementAuthority.sourceHost,
			hostInstanceId: `${replacementAuthority.sourceHost.hostInstanceId}-conflict`,
		},
	};

	await assert.rejects(
		replacementClient.bind(target, { authority: conflictingAuthority }),
		/dure_claude_sdk_host_replacement_authority_conflict/u,
	);
	const receipt = await replacementClient.bind(target, {
		authority: replacementAuthority,
	});

	assert.deepEqual(receipt.identity, target.identity);
	assert.equal(replacementHost.queryCount, 1);
	oldClient.detach();
	replacementClient.detach();
});

test("more than 129 post-bind failures transfer one exact retirement authority", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-post-bind-repairs-1",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-post-bind-repairs-1");
	const source = binding(2_200);
	await client.bind(source);
	let target = binding(2_200, 2);
	let sourceAuthority = await retireAndAck(client, source, target.identity);
	for (let generation = 2; generation < 142; generation += 1) {
		await client.bind(target, { authority: sourceAuthority });
		client.commitQueryReplacement(sourceAuthority, target.identity);
		const targetAuthority = await retireAndAck(client, target);
		releaseAndConfirm(client, sourceAuthority);
		if (generation === 141) {
			releaseAndConfirm(client, targetAuthority);
		} else {
			target = binding(2_200, generation + 1);
			sourceAuthority = client.retargetQueryRetirement(
				targetAuthority,
				target.identity,
			).authority;
		}
	}
	assert.equal(host.queryCount, 0);
});

test("pending interactions survive detach while exact answers and interrupts stay Query-fenced", async () => {
	let controller;
	let interruptCalls = 0;
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-interactions-1",
		createQuery: async ({ emit, terminal }) => {
			let activeClientMessageId;
			let activeTurnResolve;
			let pending = [];
			controller = {
				async answerInteraction(answer) {
					const request = pending.find(({ requestId }) => requestId === answer.requestId);
					if (!request) throw agentSdkError("interaction_stale");
					if (
						answer.clientMessageId !== request.clientMessageId ||
						answer.kind !== request.kind
					) {
						throw agentSdkError("interaction_identity_mismatch");
					}
					pending = [];
					emit("interaction_resolved", {
						clientMessageId: answer.clientMessageId,
						kind: answer.kind,
						outcome: answer.decision,
						requestId: answer.requestId,
					});
					activeTurnResolve({ stopReason: "end_turn" });
					return { outcome: answer.decision, requestId: answer.requestId };
				},
				async close() {
					terminal({ code: 0, signal: null });
				},
				async interruptTurn({ clientMessageId }) {
					if (clientMessageId !== activeClientMessageId) {
						throw new Error("dure_claude_agent_sdk_stale_turn_identity");
					}
					interruptCalls += 1;
					activeTurnResolve({ stopReason: "interrupted" });
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
							Object.freeze({
								clientMessageId,
								input: Object.freeze({ path: "/workspace/file.txt" }),
								kind: "permission",
								requestId: "interaction-request-1",
								toolName: "Read",
								toolUseId: "tool-use-1",
							}),
						];
						emit("interaction_requested", pending[0]);
					}
					return new Promise((resolve) => {
						activeTurnResolve = resolve;
					});
				},
			};
			return controller;
		},
	});
	const prepared = binding(11);
	const first = attach(host, "client-interactions-1");
	await first.bind(prepared);
	first.startTurn(prepared.identity, {
		clientMessageId: "message-interactions-1",
		input: "permission",
	});
	const requested = await waitForReplay(first, prepared.identity, ({ events }) =>
		events.some(({ kind }) => kind === "interaction_requested"),
	);
	const requestSequence = requested.events.find(
		({ kind }) => kind === "interaction_requested",
	).sequence;
	first.ack(prepared.identity, requestSequence);
	first.detach();

	const second = attach(host, "client-interactions-2", {
		[prepared.identity.runtimeGeneration]: requestSequence,
	});
	assert.equal(second.snapshot().queries[0].pendingInteractionCount, 1);
	assert.deepEqual(second.pendingInteractions(prepared.identity), [
		{
			clientMessageId: "message-interactions-1",
			input: { path: "/workspace/file.txt" },
			kind: "permission",
			requestId: "interaction-request-1",
			toolName: "Read",
			toolUseId: "tool-use-1",
		},
	]);
	await assert.rejects(
		second.answerInteraction(prepared.identity, {
			clientMessageId: "message-interactions-1",
			decision: "allow",
			kind: "permission",
			requestId: "interaction-request-stale",
		}),
		/dure_claude_sdk_host_interaction_stale/u,
	);
	await second.answerInteraction(prepared.identity, {
		clientMessageId: "message-interactions-1",
		decision: "allow",
		kind: "permission",
		requestId: "interaction-request-1",
	});
	await waitForReplay(second, prepared.identity, ({ events }) =>
		events.some(({ kind }) => kind === "turn_completed"),
	);
	assert.equal(second.snapshot().queries[0].pendingInteractionCount, 0);
	assert.deepEqual(second.pendingInteractions(prepared.identity), []);
	await assert.rejects(
		second.answerInteraction(prepared.identity, {
			clientMessageId: "message-interactions-1",
			decision: "allow",
			kind: "permission",
			requestId: "interaction-request-1",
		}),
		/dure_claude_sdk_host_interaction_stale/u,
	);

	second.startTurn(prepared.identity, {
		clientMessageId: "message-interrupt-1",
		input: "interrupt",
	});
	const interrupt = {
		clientMessageId: "message-interrupt-1",
		interruptRequestId: "interrupt-request-1",
	};
	assert.deepEqual(await second.interruptTurn(prepared.identity, interrupt), {
		cancelledMessageIds: [],
		clientMessageId: "message-interrupt-1",
		interruptRequestId: "interrupt-request-1",
		receiptAvailable: true,
		stillQueuedMessageIds: [],
	});
	assert.deepEqual(await second.interruptTurn(prepared.identity, interrupt), {
		cancelledMessageIds: [],
		clientMessageId: "message-interrupt-1",
		interruptRequestId: "interrupt-request-1",
		receiptAvailable: true,
		stillQueuedMessageIds: [],
	});
	assert.equal(interruptCalls, 1);
	await assert.rejects(
		second.interruptTurn(prepared.identity, {
			clientMessageId: "message-interrupt-1",
			interruptRequestId: "interrupt-request-2",
		}),
		/dure_claude_sdk_host_turn_interrupt_conflict/u,
	);
	second.detach();
});

test("replay pages fit the control frame instead of embedding a whole Query ring", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-page-1",
		createQuery: async ({ emit, terminal }) => ({
			...passiveInteractionControls(),
			async startTurn() {
				for (let index = 0; index < 140; index += 1) {
					emit("assistant_delta", { index, text: "x".repeat(1_024) });
				}
				return { stopReason: "end_turn" };
			},
			async close() {
				terminal({ code: 0, signal: null });
			},
			async invalidate(reason) {
				terminal({ reason });
			},
		}),
	});
	const client = attach(host, "client-page-1");
	const prepared = binding(9);
	await client.bind(prepared);
	client.startTurn(prepared.identity, {
		clientMessageId: "message-page-1",
		input: "page",
	});
	await waitForReplay(client, prepared.identity, ({ latestSequence }) => latestSequence === 143);

	const firstPage = client.replay(prepared.identity, 0);
	assert.equal(firstPage.hasMore, true);
	assert.ok(firstPage.events.length < firstPage.latestSequence);
	const secondPage = client.replay(prepared.identity, firstPage.nextAfterSequence);
	assert.equal(secondPage.events[0].sequence, firstPage.nextAfterSequence + 1);
	assert.equal(secondPage.latestSequence, firstPage.latestSequence);
	client.detach();
});

test("an ambiguously failed turn keeps one idempotent acceptance receipt", async () => {
	let starts = 0;
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-failed-turn-1",
		createQuery: async ({ terminal }) => ({
			...passiveInteractionControls(),
			async startTurn() {
				starts += 1;
				throw new Error("provider_turn_failed");
			},
			async close() {
				terminal({ code: 0, signal: null });
			},
			async invalidate(reason) {
				terminal({ reason });
			},
		}),
	});
	const client = attach(host, "client-failed-turn-1");
	const prepared = binding(7);
	await client.bind(prepared);
	const accepted = client.startTurn(prepared.identity, {
		clientMessageId: "message-failed-turn-1",
		input: "ambiguous",
	});
	await waitForReplay(client, prepared.identity, ({ events }) =>
		events.some(({ kind }) => kind === "turn_failed"),
	);
	assert.deepEqual(
		client.startTurn(prepared.identity, {
			clientMessageId: "message-failed-turn-1",
			input: "ambiguous",
		}),
		accepted,
	);
	await assert.rejects(
		async () =>
			client.startTurn(prepared.identity, {
				clientMessageId: "message-failed-turn-1",
				input: "different-input",
			}),
		/dure_claude_sdk_host_message_id_conflict/u,
	);
	assert.equal(starts, 1);
	client.detach();
});

test("uncommitted turn receipts are bounded and released by canonical acknowledgement", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-turn-receipts-1",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-turn-receipts-1");
	const prepared = binding(10);
	await client.bind(prepared);
	for (let index = 0; index < 128; index += 1) {
		client.startTurn(prepared.identity, {
			clientMessageId: `message-receipt-${index}`,
			input: `turn-${index}`,
		});
		await waitForReplay(
			client,
			prepared.identity,
			({ latestSequence }) => latestSequence === 1 + (index + 1) * 3,
		);
	}
	assert.throws(
		() =>
			client.startTurn(prepared.identity, {
				clientMessageId: "message-receipt-overflow",
				input: "overflow",
			}),
		/dure_claude_sdk_host_turn_receipt_capacity_exceeded/u,
	);
	const latestSequence = client.replay(prepared.identity, 0).latestSequence;
	client.ack(prepared.identity, latestSequence);
	assert.doesNotThrow(() =>
		client.startTurn(prepared.identity, {
			clientMessageId: "message-receipt-after-ack",
			input: "released",
		}),
	);
	client.detach();
});

test("owner loss retains a running turn and uncommitted replay until its successor releases them", async () => {
	let finishTurn;
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-owner-release",
		createQuery: async (options) => ({
			...await fakeQueryFactory()(options),
			startTurn: () => new Promise((resolve) => { finishTurn = resolve; }),
		}),
	});
	const original = attach(host, "controller-one");
	const prepared = binding(1);
	await original.bind(prepared);
	original.startTurn(prepared.identity, { clientMessageId: "surviving-turn", input: "continue" });
	await waitForReplay(original, prepared.identity, ({ latestSequence }) => latestSequence === 2);
	original.detach();
	let released = false;
	const release = host.releaseOwner().then(() => { released = true; });
	await Promise.resolve();
	assert.equal(released, false);
	finishTurn({ stopReason: "end_turn" });
	const successor = attach(host, "controller-two");
	await waitForReplay(successor, prepared.identity, ({ latestSequence }) => latestSequence === 3);
	assert.equal(host.queryCount, 1);
	await successor.closeQuery(prepared.identity);
	successor.detach();
	await Promise.resolve();
	assert.equal(released, false, "uncommitted terminal replay is still Host-owned");
	const reader = attach(host, "controller-three");
	const replay = reader.replay(prepared.identity, 0);
	assert.deepEqual(replay.events.map(({ kind }) => kind), [
		"initialized", "user_message_accepted", "turn_completed", "query_exited",
	]);
	reader.ack(prepared.identity, replay.latestSequence);
	await Promise.resolve();
	assert.equal(released, false, "an attached controller retains the Host");
	reader.detach();
	await release;
	assert.equal(released, true);
});

test("bounded replay reports an explicit gap instead of silently accepting a stale cursor", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-gap-1",
		createQuery: fakeQueryFactory(),
		replayLimits: { maxEvents: 3, maxBytes: 4_096 },
	});
	const client = attach(host, "client-gap-1");
	const prepared = binding(2);
	await client.bind(prepared);
	await client.startTurn(prepared.identity, {
		clientMessageId: "message-gap-1",
		input: "overflow",
	});

	const replay = await waitForReplay(
		client,
		prepared.identity,
		({ latestSequence }) => latestSequence === 4,
	);
	assert.deepEqual(replay.gap, { requestedAfter: 0, droppedThrough: 1 });
	assert.deepEqual(
		replay.events.map(({ sequence }) => sequence),
		[2, 3, 4],
	);
	client.detach();
});

test("rolling drain rejects new binds and retires old Queries one at a time", async () => {
	const oldHost = createSharedClaudeSdkHost({
		hostGeneration: "host-rolling-old",
		createQuery: fakeQueryFactory(),
	});
	const replacement = createSharedClaudeSdkHost({
		hostGeneration: "host-rolling-new",
		createQuery: fakeQueryFactory(),
	});
	const oldClient = attach(oldHost, "client-rolling-old");
	const newClient = attach(replacement, "client-rolling-new");
	for (let index = 0; index < 5; index += 1) await oldClient.bind(binding(index));

	assert.deepEqual(oldClient.beginDrain().map((value) => value.runtimeGeneration), [
		"runtime-0-g1",
		"runtime-1-g1",
		"runtime-2-g1",
		"runtime-3-g1",
		"runtime-4-g1",
	]);
	await assert.rejects(oldClient.bind(binding(99)), /dure_claude_sdk_host_draining/u);

	for (let index = 0; index < 5; index += 1) {
		await oldClient.closeQuery(identity(index));
		oldClient.ack(
			identity(index),
			oldClient.replay(identity(index), 0).latestSequence,
		);
		await newClient.bind(binding(index, 2));
		assert.equal(oldHost.queryCount, 4 - index);
		assert.equal(replacement.queryCount, index + 1);
	}
	assert.equal(oldHost.state, "drained");
	oldClient.detach();
	newClient.detach();
});

test("a fully committed exited Query releases its retained host record", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-record-release-1",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-record-release-1");
	const prepared = binding(6);
	await client.bind(prepared);
	client.beginDrain();
	await client.closeQuery(prepared.identity);
	const replay = client.replay(prepared.identity, 0);
	assert.equal(replay.latestSequence, 2);
	client.ack(prepared.identity, replay.latestSequence);
	assert.deepEqual(client.snapshot().queries, []);
	client.detach();
});

test("host crash invalidates every binding and replacements require new complete identities", async () => {
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-crash-old",
		createQuery: fakeQueryFactory(),
	});
	const client = attach(host, "client-crash-old");
	for (let index = 0; index < 5; index += 1) await client.bind(binding(index));

	const affected = await host.fail("host_process_exited");
	assert.equal(host.state, "failed");
	assert.equal(host.queryCount, 0);
	assert.deepEqual(
		affected.map((value) => value.runtimeGeneration),
		["runtime-0-g1", "runtime-1-g1", "runtime-2-g1", "runtime-3-g1", "runtime-4-g1"],
	);
	await assert.rejects(
		async () => client.startTurn(identity(0), { clientMessageId: "stale", input: "stale" }),
		/dure_claude_sdk_host_failed/u,
	);

	const replacement = createSharedClaudeSdkHost({
		hostGeneration: "host-crash-new",
		createQuery: fakeQueryFactory(),
		retiredIdentities: affected,
	});
	const replacementClient = attach(replacement, "client-crash-new");
	await assert.rejects(
		replacementClient.bind(binding(0)),
		/dure_claude_sdk_host_stale_runtime_generation/u,
	);
	const sourceAuthority = replacementClient.queryRetirementStatus(identity(0)).authority;
	const replacementBinding = binding(0, 2);
	const replacementAuthority = replacementClient.retargetQueryRetirement(
		sourceAuthority,
		replacementBinding.identity,
	).authority;
	await replacementClient.bind(replacementBinding, { authority: replacementAuthority });
	await assert.rejects(
		replacementClient.bind(binding(9, 3), { authority: replacementAuthority }),
		/dure_claude_sdk_host_replacement_authority_invalid/u,
	);
	assert.equal(replacement.queryCount, 1);
	replacementClient.detach();
});

test("host failure aborts a Query factory that is still binding", async () => {
	let invalidations = 0;
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-binding-crash-1",
		createQuery: ({ signal, terminal }) =>
			new Promise((resolve) => {
				signal.addEventListener(
					"abort",
					() => {
						resolve({
							...passiveInteractionControls(),
							async startTurn() {},
							async close() {},
							async invalidate() {
								invalidations += 1;
								terminal({ reason: "binding_aborted" });
							},
						});
					},
					{ once: true },
				);
			}),
	});
	const client = attach(host, "client-binding-crash-1");
	const prepared = binding(8);
	const bindingAttempt = client.bind(prepared);
	await Promise.resolve();
	assert.deepEqual(await host.fail("host_process_exited"), [prepared.identity]);
	await assert.rejects(bindingAttempt, /dure_claude_sdk_host_query_exited_during_bind/u);
	assert.equal(invalidations, 1);
});

test("history acquisition reserves one Query and host failure removes it before creation", async () => {
	const history = Promise.withResolvers();
	let queryCreations = 0;
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-history-binding-crash-1",
		createQuery: async () => {
			queryCreations += 1;
			return fakeQueryFactory()({});
		},
		readHistory: () => history.promise,
	});
	const client = attach(host, "client-history-binding-crash-1");
	const prepared = binding(18);
	const bindingAttempt = client.bind(prepared);
	await Promise.resolve();
	await assert.rejects(client.bind(prepared), /dure_claude_sdk_host_query_exited/u);
	assert.deepEqual(await host.fail("host_process_exited"), [prepared.identity]);
	history.resolve({ items: [], status: "complete" });
	await assert.rejects(bindingAttempt, /dure_claude_sdk_host_query_exited_during_bind/u);
	assert.equal(queryCreations, 0);
	assert.equal(host.queryCount, 0);
});

test("mid-turn steering pushes into the running turn exactly once", async () => {
	const steered = [];
	let releaseTurn;
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-steer-1",
		createQuery: async ({ terminal }) => ({
			...passiveInteractionControls(),
			async startTurn() {
				await new Promise((resolve) => {
					releaseTurn = resolve;
				});
				return { stopReason: "end_turn" };
			},
			steerTurn({ clientMessageId, input }) {
				steered.push({ clientMessageId, input });
			},
			async close() {
				terminal({ code: 0, signal: null });
			},
			async invalidate(reason) {
				terminal({ reason });
			},
		}),
	});
	const client = attach(host, "client-steer-1");
	const prepared = binding(31);
	await client.bind(prepared);

	assert.throws(
		() =>
			client.steerTurn(prepared.identity, {
				clientMessageId: "steer-early",
				input: "too soon",
			}),
		/dure_claude_sdk_host_turn_not_running/u,
	);

	client.startTurn(prepared.identity, {
		clientMessageId: "turn-steer-1",
		input: "go",
	});
	const accepted = client.steerTurn(prepared.identity, {
		clientMessageId: "steer-1",
		input: "also check the tests",
	});
	assert.deepEqual(
		client.steerTurn(prepared.identity, {
			clientMessageId: "steer-1",
			input: "also check the tests",
		}),
		accepted,
	);
	assert.throws(
		() =>
			client.steerTurn(prepared.identity, {
				clientMessageId: "steer-1",
				input: "different-input",
			}),
		/dure_claude_sdk_host_message_id_conflict/u,
	);
	assert.deepEqual(steered, [
		{ clientMessageId: "steer-1", input: "also check the tests" },
	]);
	const replay = client.replay(prepared.identity, 0);
	assert.ok(
		replay.events.some(
			({ kind, payload }) =>
				kind === "user_message_accepted" &&
				payload.clientMessageId === "steer-1",
		),
	);

	await new Promise((resolve) => setImmediate(resolve));
	releaseTurn();
	await waitForReplay(client, prepared.identity, ({ events }) =>
		events.some(({ kind }) => kind === "turn_completed"),
	);
	assert.throws(
		() =>
			client.steerTurn(prepared.identity, {
				clientMessageId: "steer-late",
				input: "after the turn",
			}),
		/dure_claude_sdk_host_turn_not_running/u,
	);
	client.detach();
});

test("a controller without a mid-turn channel refuses steering as unsupported", async () => {
	let releaseTurn;
	const host = createSharedClaudeSdkHost({
		hostGeneration: "host-steer-unsupported-1",
		createQuery: async ({ terminal }) => ({
			...passiveInteractionControls(),
			async startTurn() {
				await new Promise((resolve) => {
					releaseTurn = resolve;
				});
				return { stopReason: "end_turn" };
			},
			async close() {
				terminal({ code: 0, signal: null });
			},
			async invalidate(reason) {
				terminal({ reason });
			},
		}),
	});
	const client = attach(host, "client-steer-unsupported-1");
	const prepared = binding(32);
	await client.bind(prepared);
	client.startTurn(prepared.identity, {
		clientMessageId: "turn-steer-unsupported-1",
		input: "go",
	});
	assert.throws(
		() =>
			client.steerTurn(prepared.identity, {
				clientMessageId: "steer-unsupported-1",
				input: "mid-turn",
			}),
		/dure_claude_sdk_host_steer_unsupported/u,
	);
	await new Promise((resolve) => setImmediate(resolve));
	releaseTurn();
	await waitForReplay(client, prepared.identity, ({ events }) =>
		events.some(({ kind }) => kind === "turn_completed"),
	);
	client.detach();
});

test("a failed turn forwards the driver's classified reason and drops anything else", async () => {
	for (const [thrown, expected] of [
		[Object.assign(new Error("provider_turn_failed"), { reason: "usage_limit" }), "usage_limit"],
		[Object.assign(new Error("provider_turn_failed"), { reason: "provider secret text" }), null],
		[new Error("provider_turn_failed"), null],
	]) {
		const host = createSharedClaudeSdkHost({
			hostGeneration: `host-failed-reason-${expected ?? "none"}`,
			createQuery: async ({ terminal }) => ({
				...passiveInteractionControls(),
				async startTurn() {
					throw thrown;
				},
				async close() {
					terminal({ code: 0, signal: null });
				},
				async invalidate(reason) {
					terminal({ reason });
				},
			}),
		});
		const client = attach(host, `client-failed-reason-${expected ?? "none"}`);
		const prepared = binding(7);
		await client.bind(prepared);
		client.startTurn(prepared.identity, {
			clientMessageId: "message-failed-reason-1",
			input: "fail",
		});
		const replay = await waitForReplay(client, prepared.identity, ({ events }) =>
			events.some(({ kind }) => kind === "turn_failed"),
		);
		const failed = replay.events.find(({ kind }) => kind === "turn_failed");
		assert.deepEqual(failed.payload, {
			clientMessageId: "message-failed-reason-1",
			reason: expected,
		});
		client.detach();
	}
});
