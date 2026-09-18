import { describe, expect, it } from "vitest";
import {
	parseAgentInteractionBindingV1,
	parseAgentTimelineReadV1,
} from "@/lib/agents/chat/agentConversationContract";

function binding() {
	return {
		schemaVersion: 1,
		interactionSessionId: "interaction-1",
		agentId: "agent-1",
		providerId: "claude",
		executionProfile: { kind: "provider_default" },
		providerConversationRef: null,
		runtime: {
			runtimeGeneration: "runtime-1",
			providerEpoch: "query-1",
		},
		timelineEpoch: "timeline-1",
		bindingRevision: 1,
		historyComplete: true,
		createdAtMs: 10,
		updatedAtMs: 10,
	};
}

function read() {
	return {
		type: "page",
		page: {
			binding: binding(),
			rows: [
				{
					cursor: { epoch: "timeline-1", sequence: 1 },
					item: {
						itemId: "item-1",
						turnId: "turn-1",
						clientMessageId: "message-1",
						providerMessageId: null,
						body: { type: "message", role: "user", markdown: "hello" },
						createdAtMs: 11,
					},
				},
			],
			liveText: [
				{
					streamId: "stream-1",
					itemId: "item-live-1",
					kind: "assistant",
					text: "hi",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: "provider-message-1",
					updatedAtMs: 12,
				},
			],
			pendingRequests: [],
			activeTurn: null,
			latestFailure: null,
			goal: null,
			queuedInputs: {
				interactionSessionId: "interaction-1",
				inputs: [],
				nextAfter: null,
			},
			finalCursor: { epoch: "timeline-1", sequence: 1 },
			hasMore: false,
		},
	};
}

function request(direction: "after" | "before" | "tail" = "tail") {
	return {
		schemaVersion: 1 as const,
		interactionSessionId: "interaction-1",
		direction,
		cursor:
			direction === "tail"
				? null
				: { epoch: "timeline-1", sequence: direction === "before" ? 5 : 0 },
		limit: 128,
	};
}

describe("agent conversation contract", () => {
	it.each(["tail", "before", "after"] as const)(
		"reads the current failed input independently of a %s row window",
		(direction) => {
			const payload = read();
			const latestFailure = {
				itemId: "current-failure",
				createdAtMs: 50,
				reason: "usage_limit",
				userInput: "Original request outside these rows",
			};
			expect(
				parseAgentTimelineReadV1(
					{ ...payload, page: { ...payload.page, latestFailure } },
					request(direction),
				),
			).toMatchObject({
				type: "page",
				page: { latestFailure },
			});
		},
	);

	it.each([
		undefined,
		{},
		{
			itemId: "failure",
			createdAtMs: 1,
			reason: "provider prose",
			userInput: "retained",
		},
		{ itemId: "failure", createdAtMs: 1, reason: "usage_limit", userInput: 42 },
	])(
		"does not treat an invalid failure snapshot as permission to recover",
		(latestFailure) => {
			const payload = read();
			expect(
				parseAgentTimelineReadV1(
					{ ...payload, page: { ...payload.page, latestFailure } },
					request(),
				),
			).toBeUndefined();
		},
	);

	it("does not treat a missing queue projection as an empty accepted queue", () => {
		const payload = read();
		const { queuedInputs: _queue, ...page } = payload.page;
		expect(
			parseAgentTimelineReadV1({ ...payload, page }, request()),
		).toBeUndefined();
	});

	it("keeps queued input across runtime changes while preserving conversation scope", () => {
		const value = read();
		const queued = {
			interactionSessionId: "interaction-1",
			inputs: [
				{
					clientMessageId: "queued-message",
					sequence: 1,
					preview: "Keep this instruction",
				},
			],
			nextAfter: null,
		};
		const payload = {
			...value,
			page: {
				...value.page,
				queuedInputs: queued,
				rows: [
					{
						...value.page.rows[0],
						item: {
							...value.page.rows[0].item,
							body: { type: "queued_input", state: "queued" },
						},
					},
				],
			},
		};
		const parsed = parseAgentTimelineReadV1(payload, request());
		expect(parsed?.type === "page" && parsed.page.queuedInputs).toEqual(queued);
		expect(parsed?.type === "page" && parsed.page.rows[0].item.body).toEqual({
			type: "queued_input",
			state: "queued",
		});
		queued.interactionSessionId = "another-conversation";
		expect(parseAgentTimelineReadV1(payload, request())).toBeUndefined();
	});

	it("keeps automatic goal continuation distinct from a human message", () => {
		const value = read();
		const parsed = parseAgentTimelineReadV1(
			{
				...value,
				page: {
					...value.page,
					rows: [
						{
							...value.page.rows[0],
							item: {
								...value.page.rows[0].item,
								body: {
									type: "goal_continuation",
									objective: "Finish the report",
									goal_revision: 2,
								},
							},
						},
					],
				},
			},
			request(),
		);
		expect(parsed?.type === "page" && parsed.page.rows[0].item.body).toEqual({
			type: "goal_continuation",
			objective: "Finish the report",
			goalRevision: 2,
		});
	});

	it("reads a confirmed answer with its retained request and runtime", () => {
		const value = read();
		const pending = {
			interactionSessionId: "interaction-1",
			runtime: binding().runtime,
			request: {
				requestId: "question-1",
				clientMessageId: "message-1",
				turnId: "turn-1",
				kind: "question",
				createdAtMs: 10,
				payload: { input: { questions: [] } },
			},
		};
		const body = {
			type: "pending_answer",
			idempotency_key: "answer-1",
			request: pending,
			answer: { answers: { stack: "SQLite" } },
		};
		const parsed = parseAgentTimelineReadV1(
			{
				...value,
				page: {
					...value.page,
					rows: [
						{
							...value.page.rows[0],
							item: { ...value.page.rows[0].item, body },
						},
					],
				},
			},
			request(),
		);
		expect(parsed?.type).toBe("page");
		if (parsed?.type !== "page") throw new Error("expected page");
		expect(parsed.page.rows[0].item.body).toEqual({
			type: "pending_answer",
			idempotencyKey: "answer-1",
			request: pending,
			answer: body.answer,
		});
	});
	it("parses one bounded provider-neutral page", () => {
		const parsed = parseAgentTimelineReadV1(read(), request());
		expect(parsed?.type).toBe("page");
		if (parsed?.type !== "page") throw new Error("expected page");
		expect(parsed.page.rows[0]?.item.body).toEqual({
			type: "message",
			role: "user",
			markdown: "hello",
		});
		expect(parsed.page.liveText[0]?.text).toBe("hi");
	});

	it("requires the complete active-turn snapshot", () => {
		const active = {
			...read(),
			page: {
				...read().page,
				activeTurn: {
					turnId: "turn-1",
					clientMessageId: "message-1",
				},
			},
		};
		const parsed = parseAgentTimelineReadV1(active, request());
		expect(parsed?.type).toBe("page");
		if (parsed?.type !== "page") throw new Error("expected active page");
		expect(parsed.page.activeTurn).toEqual(active.page.activeTurn);

		const missing = read();
		Reflect.deleteProperty(missing.page, "activeTurn");
		expect(parseAgentTimelineReadV1(missing, request())).toBeUndefined();
		expect(
			parseAgentTimelineReadV1(
				{
					...read(),
					page: {
						...read().page,
						activeTurn: { turnId: "turn-1" },
					},
				},
				request(),
			),
		).toBeUndefined();
	});

	it("parses the canonical oldest cursor of a multi-row before page", () => {
		const before = read();
		before.page.rows = [3, 4].map((sequence) => ({
			...before.page.rows[0]!,
			cursor: { epoch: "timeline-1", sequence },
			item: {
				...before.page.rows[0]!.item,
				itemId: `item-${sequence}`,
				createdAtMs: 10 + sequence,
			},
		}));
		before.page.finalCursor.sequence = 3;

		const parsed = parseAgentTimelineReadV1(before, request("before"));
		expect(parsed?.type).toBe("page");
		if (parsed?.type !== "page") throw new Error("expected before page");
		expect(parsed.page.rows.map((row) => row.cursor.sequence)).toEqual([3, 4]);
		expect(parseAgentTimelineReadV1(before, request("after"))).toBeUndefined();
	});

	it("rejects stale runtime and timeline fences", () => {
		const stalePending = {
			...read(),
			page: {
				...read().page,
				pendingRequests: [
					{
						interactionSessionId: "interaction-1",
						runtime: {
							runtimeGeneration: "runtime-stale",
							providerEpoch: "query-1",
						},
						request: {
							requestId: "request-1",
							kind: "permission",
							turnId: "turn-1",
							clientMessageId: "message-1",
							payload: { tool: "Bash" },
							createdAtMs: 12,
						},
					},
				],
			},
		};
		expect(parseAgentTimelineReadV1(stalePending, request())).toBeUndefined();

		const staleCursor = read();
		staleCursor.page.finalCursor.epoch = "timeline-stale";
		expect(parseAgentTimelineReadV1(staleCursor, request())).toBeUndefined();
	});

	it("parses credential identity and strips unconsumed metadata", () => {
		const credentialBinding = {
			...binding(),
			executionProfile: {
				kind: "credential_reference",
				reference_id: "credential.account-a",
				credential_generation: "credential-generation-1",
			},
		};
		expect(
			parseAgentInteractionBindingV1(credentialBinding)?.executionProfile,
		).toEqual(credentialBinding.executionProfile);
		expect(
			parseAgentInteractionBindingV1({
				...binding(),
				providerSocket: "/tmp/private",
			}),
		).toEqual(binding());
		expect(
			parseAgentInteractionBindingV1({
				...credentialBinding,
				executionProfile: {
					...credentialBinding.executionProfile,
					reference_id: "credential+profile",
				},
			}),
		).toBeUndefined();
	});
});

it("projects the goal of this agent and rejects another agent's goal", () => {
	const initial = read();
	const goal = {
		schemaVersion: 1,
		agentId: initial.page.binding.agentId,
		objective: "Complete shared work",
		revision: 1,
		status: "active",
		detail: null,
		activationCursor: { epoch: "timeline-1", sequence: 0 },
		createdAtMs: 1,
		updatedAtMs: 1,
	};
	const snapshot = { ...initial, page: { ...initial.page, goal } };
	const parsed = parseAgentTimelineReadV1(snapshot, request());
	expect(parsed?.type === "page" && parsed.page.goal).toEqual(goal);
	expect(
		parseAgentTimelineReadV1(
			{
				...snapshot,
				page: { ...snapshot.page, goal: { ...goal, agentId: "another-agent" } },
			},
			request(),
		),
	).toBeUndefined();
});
