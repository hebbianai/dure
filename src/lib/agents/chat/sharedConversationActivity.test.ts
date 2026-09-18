import { expect, it, vi } from "vitest";
import type { AgentTimelinePageV1 } from "@/lib/agents/chat/agentConversationContract";
import { readSharedConversationActivity } from "@/lib/agents/chat/sharedConversationActivity";
import { chatComposerSessionFixture } from "@/test/chatComposerSessionFixture";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const authority = testDureBackendRouteAuthority(
	"backend",
	"generation",
	"team",
);
const task = {
	agentId: "agent-1",
	backend: { backendId: "backend", scopeId: "scope" },
};

function fixture() {
	const page = chatComposerSessionFixture("codex").page!;
	page.rows = [];
	page.finalCursor.sequence = 0;
	const invokeCommand = vi.fn(async (_command, args) => {
		expect(args.route).toEqual({ kind: "exact", authority });
		let result: Record<string, unknown>;
		if (args.operation === "backend.scope") result = { scopeId: "scope" };
		else if (args.operation === "agent_conversation.inspect")
			result = { binding: page.binding };
		else if (args.operation === "agent_conversation.read") {
			page.queuedInputs = {
				interactionSessionId: page.binding.interactionSessionId,
				inputs: [],
				nextAfter: null,
			};
			expect(args.body).toEqual({
				schemaVersion: 1,
				interactionSessionId: page.binding.interactionSessionId,
				direction: "tail",
				cursor: null,
				limit: 1,
			});
			result = { read: { type: "page", page } };
		} else throw new Error(`Unexpected operation ${args.operation}`);
		return {
			schemaVersion: 1,
			backendId: "backend",
			backendGeneration: "generation",
			routeAuthority: authority,
			result: { schemaVersion: 1, ...result },
		};
	});
	return { page, invokeCommand };
}

it("observes an active turn using the current binding, without opening or starting work", async () => {
	const { page, invokeCommand } = fixture();
	page.binding.interactionSessionId = "replacement-conversation";
	page.activeTurn = { turnId: "turn", clientMessageId: "message" };
	const activity = await readSharedConversationActivity(
		[task, task],
		authority,
		{ invokeCommand },
	);
	expect(activity.get(task.agentId)).toBe(true);
	expect(invokeCommand).toHaveBeenCalledTimes(3);
});

it.each(["idle", "failed", "pending"])(
	"does not animate %s conversations",
	async (state) => {
		const { page, invokeCommand } = fixture();
		if (state === "failed")
			page.latestFailure = {
				itemId: "failed",
				createdAtMs: 1,
				reason: "usage_limit",
				userInput: "request",
			};
		if (state === "pending") {
			page.activeTurn = { turnId: "turn", clientMessageId: "message" };
			page.pendingRequests = [
				{
					interactionSessionId: page.binding.interactionSessionId,
					runtime: page.binding.runtime,
					request: {
						requestId: "approval",
						kind: "permission",
						turnId: "turn",
						clientMessageId: "message",
						payload: {},
						createdAtMs: 1,
					},
				},
			] as AgentTimelinePageV1["pendingRequests"];
		}
		const activity = await readSharedConversationActivity([task], authority, {
			invokeCommand,
		});
		expect(activity.get(task.agentId)).toBe(false);
	},
);

it("does not query a task belonging to another durable server scope", async () => {
	const { invokeCommand } = fixture();
	const activity = await readSharedConversationActivity(
		[{ ...task, backend: { ...task.backend, scopeId: "elsewhere" } }],
		authority,
		{ invokeCommand },
	);
	expect(activity.size).toBe(0);
	expect(invokeCommand).toHaveBeenCalledOnce();
});

it("leaves unavailable conversations unknown instead of marking them idle", async () => {
	const { invokeCommand } = fixture();
	const wrapped = vi.fn((command, args) =>
		args.operation === "agent_conversation.inspect"
			? Promise.reject(new Error("offline"))
			: invokeCommand(command, args),
	);
	const activity = await readSharedConversationActivity([task], authority, {
		invokeCommand: wrapped,
	});
	expect(activity.has(task.agentId)).toBe(false);
});

it("does not start observations after the view has been canceled", async () => {
	const { invokeCommand } = fixture();
	const controller = new AbortController();
	controller.abort();
	expect(
		(
			await readSharedConversationActivity([task], authority, {
				invokeCommand,
				signal: controller.signal,
			})
		).size,
	).toBe(0);
	expect(invokeCommand).not.toHaveBeenCalled();
});
