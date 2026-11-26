import { describe, expect, it, vi } from "vitest";
import {
	type DureAgentActivityEventV1,
	parseDureAgentActivityV1,
	subscribeDureAgentActivity,
} from "@/lib/ipc/dureAgentActivity";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const wire = (patch: Record<string, unknown> = {}) => ({
	agentId: "agent-1",
	interactionSessionId: "interaction-1",
	lifecycle: "running",
	activity: "waiting",
	attention: "approval_required",
	attentionId: "permission-1",
	timelineEpoch: "timeline-1",
	turnCompletedSequence: "12",
	...patch,
});

function envelope(agents: unknown[]) {
	return {
		schemaVersion: 1,
		backendId: "backend-local",
		backendGeneration: "generation-1",
		routeAuthority: testDureBackendRouteAuthority(
			"backend-local",
			"generation-1",
		),
		result: { schemaVersion: 1, agents },
	};
}

function event(body: Record<string, unknown>) {
	return {
		schemaVersion: 1,
		kind: "event",
		subscriptionId: "agent-activity-1",
		backendId: "backend-local",
		backendGeneration: "generation-1",
		event: {
			schemaVersion: 1,
			topic: "agent_conversation.activity",
			subscriptionRequestId: "request-1",
			...body,
		},
	};
}

describe("parseDureAgentActivityV1", () => {
	it("accepts the backend's reading and refuses anything else", () => {
		expect(parseDureAgentActivityV1(wire())).toEqual(wire());
		const { attentionId: _, ...withoutId } = wire({ attention: "none" });
		expect(parseDureAgentActivityV1(withoutId)).toEqual(withoutId);
		for (const invalid of [
			wire({ lifecycle: "stopped" }),
			wire({ activity: "idle" }),
			wire({ attention: "blocked" }),
			wire({ turnCompletedSequence: "012" }),
			wire({ turnCompletedSequence: 12 }),
			wire({ agentId: "" }),
			wire({ extra: true }),
		]) {
			expect(parseDureAgentActivityV1(invalid)).toBeUndefined();
		}
	});
});

describe("subscribeDureAgentActivity", () => {
	it("opens the tier on the profile's selected backend and applies events after its snapshot", async () => {
		const channel = { onmessage: (_message: unknown) => {} };
		const invokeCommand = vi.fn(async (command: string) => {
			if (command === "dure_backend_subscribe") {
				// An update that arrives before the snapshot is answered waits
				// for it.
				channel.onmessage(
					event({ changes: [wire({ attention: "none", attentionId: undefined })], removed: [] }),
				);
				return envelope([wire()]);
			}
			if (command === "dure_backend_unsubscribe") return true;
			throw new Error(command);
		});
		const events: DureAgentActivityEventV1[] = [];
		const subscription = await subscribeDureAgentActivity(
			"ssh-build",
			(next) => events.push(next),
			{
				invokeCommand,
				channelFactory: () => channel,
				subscriptionId: () => "agent-activity-1",
			},
		);
		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_subscribe", {
			route: { kind: "selected", profileId: "ssh-build" },
			subscriptionId: "agent-activity-1",
			operation: "agent_conversation.activity.subscribe",
			body: { schemaVersion: 1 },
			channel,
		});
		expect(events.map((next) => next.kind)).toEqual(["snapshot", "changes"]);
		expect(events[0]).toEqual({ kind: "snapshot", agents: [wire()] });

		channel.onmessage(event({ changes: [], removed: ["agent-1"] }));
		channel.onmessage(event({ agents: [] }));
		expect(events.slice(2)).toEqual([
			{ kind: "changes", changes: [], removed: ["agent-1"] },
			{ kind: "snapshot", agents: [] },
		]);
		// A malformed event or a terminal error ends the subscription's trust.
		channel.onmessage(event({ agents: [wire({ lifecycle: "gone" })] }));
		channel.onmessage({
			schemaVersion: 1,
			kind: "error",
			subscriptionId: "agent-activity-1",
			error: { code: "backend_unreachable", message: "gone" },
		});
		expect(events.slice(4).map((next) => next.kind)).toEqual(["error", "error"]);

		await subscription?.close();
		expect(invokeCommand).toHaveBeenLastCalledWith("dure_backend_unsubscribe", {
			subscriptionId: "agent-activity-1",
		});
		channel.onmessage(event({ agents: [] }));
		expect(events).toHaveLength(6);
	});

	it("answers null for a backend that predates the tier", async () => {
		const invokeCommand = vi.fn(async () => {
			throw {
				code: "backend_transport_capability_missing",
				message: "missing",
				details: { capability: "agent_conversation.activity.v1" },
			};
		});
		const onEvent = vi.fn();
		await expect(
			subscribeDureAgentActivity("local", onEvent, {
				invokeCommand,
				channelFactory: () => ({ onmessage: () => {} }),
			}),
		).resolves.toBeNull();
		expect(onEvent).not.toHaveBeenCalled();
	});

	it("refuses a malformed snapshot and releases the subscription", async () => {
		const invokeCommand = vi.fn(async (command: string) =>
			command === "dure_backend_subscribe"
				? envelope([wire({ lifecycle: "gone" })])
				: true,
		);
		await expect(
			subscribeDureAgentActivity("local", () => {}, {
				invokeCommand,
				channelFactory: () => ({ onmessage: () => {} }),
				subscriptionId: () => "agent-activity-1",
			}),
		).rejects.toMatchObject({ code: "agent_activity_response_invalid" });
		expect(invokeCommand).toHaveBeenLastCalledWith("dure_backend_unsubscribe", {
			subscriptionId: "agent-activity-1",
		});
	});
});
