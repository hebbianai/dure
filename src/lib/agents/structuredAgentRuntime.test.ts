import { describe, expect, it } from "vitest";
import {
	type AgentAttentionSource,
	deriveAttentionResolution,
} from "@/lib/agents/agentAttentionWatch";
import { resolveAgentDisplayFromTiers } from "@/lib/agents/agentStateModel";
import {
	applyStructuredAgentRuntimeUpdate,
	structuredAgentBackendProfiles,
	structuredAgentHmuxState,
	structuredAgentTierInputs,
} from "@/lib/agents/structuredAgentRuntime";
import type { DureAgentActivityV1 } from "@/lib/ipc/dureAgentActivity";

const activity = (
	patch: Partial<DureAgentActivityV1> = {},
): DureAgentActivityV1 => ({
	agentId: "agent-1",
	interactionSessionId: "interaction-1",
	lifecycle: "running",
	activity: "waiting",
	attention: "none",
	timelineEpoch: "timeline-1",
	turnCompletedSequence: "0",
	...patch,
});

const chatAgent = {
	id: "agent-1",
	interactionProfile: {
		schemaVersion: 1,
		kind: "structured_protocol",
		backendProfileId: "local",
		interactionSessionId: "interaction-1",
	},
} as const;

describe("structuredAgentHmuxState", () => {
	it("reads a chat Agent's state as a Host's, keyed by its conversation's timeline", () => {
		expect(
			structuredAgentHmuxState(
				activity({
					attention: "approval_required",
					attentionId: "permission-1",
					turnCompletedSequence: "12",
				}),
			),
		).toEqual({
			terminalEpoch: "interaction-1:timeline-1",
			lifecycle: "running",
			activity: "waiting",
			attention: "approval_required",
			attentionId: "permission-1",
			source: "provider_event",
			turnCompletedCount: "12",
		});
	});

	it("resolves approval, input, error, work and exit like a Host's state", () => {
		const resolve = (patch: Partial<DureAgentActivityV1>) =>
			resolveAgentDisplayFromTiers({
				heuristic: "exited",
				hmux: structuredAgentHmuxState(activity(patch)),
				hmuxObserved: true,
			});
		expect(resolve({ attention: "approval_required" })).toBe("blocked");
		expect(resolve({ attention: "input_required" })).toBe("input");
		expect(resolve({ attention: "error" })).toBe("error");
		expect(resolve({ activity: "working" })).toBe("working");
		expect(resolve({})).toBe("waiting");
		expect(resolve({ lifecycle: "starting" })).toBe("connecting");
		expect(resolve({ lifecycle: "exited" })).toBe("exited");
	});
});

describe("structuredAgentTierInputs", () => {
	it("leaves an Agent on a terminal to its Host", () => {
		expect(
			structuredAgentTierInputs({ id: "agent-1" }, { local: {} }, undefined),
		).toBeUndefined();
	});

	it("uses the backend's reading of the exact conversation", () => {
		expect(
			structuredAgentTierInputs(
				chatAgent,
				{ local: { "agent-1": activity({ attention: "input_required" }) } },
				undefined,
			),
		).toEqual({
			hmux: expect.objectContaining({ attention: "input_required" }),
			hmuxObserved: true,
		});
		// A reading of another conversation of the same Agent is not this one's.
		expect(
			structuredAgentTierInputs(
				chatAgent,
				{
					local: {
						"agent-1": activity({ interactionSessionId: "interaction-2" }),
					},
				},
				undefined,
			),
		).toEqual({ hmuxObserved: false });
	});

	it("reads unknown, never exited, without a reading or a pane, and keeps an open pane's presentation", () => {
		const unobserved = structuredAgentTierInputs(chatAgent, {}, undefined);
		expect(unobserved).toEqual({ hmuxObserved: false });
		// The watch passes the lifecycle the store holds: none here.
		expect(
			resolveAgentDisplayFromTiers({ heuristic: undefined, ...unobserved }),
		).toBe("unknown");
		// An older backend with a pane open: the pane's lifecycle shows as today.
		const paned = structuredAgentTierInputs(chatAgent, {}, "working");
		expect(paned).toEqual({ hmuxObserved: undefined });
		expect(resolveAgentDisplayFromTiers({ heuristic: "working", ...paned })).toBe(
			"working",
		);
	});
});

describe("applyStructuredAgentRuntimeUpdate", () => {
	it("replaces the tier with a snapshot and applies changes on top", () => {
		const first = activity();
		const second = activity({ agentId: "agent-2" });
		const snapshot = applyStructuredAgentRuntimeUpdate(
			{ stale: activity({ agentId: "stale" }) },
			{ kind: "snapshot", agents: [first, second] },
		);
		expect(Object.keys(snapshot).sort()).toEqual(["agent-1", "agent-2"]);
		const changed = applyStructuredAgentRuntimeUpdate(snapshot, {
			kind: "changes",
			changes: [activity({ activity: "working" })],
			removed: ["agent-2"],
		});
		expect(changed).toEqual({ "agent-1": activity({ activity: "working" }) });
		expect(snapshot["agent-2"]).toBe(second);
	});
});

describe("structuredAgentBackendProfiles", () => {
	it("names each backend that hosts a chat Agent once", () => {
		expect(
			structuredAgentBackendProfiles([
				chatAgent,
				{
					interactionProfile: {
						...chatAgent.interactionProfile,
						interactionSessionId: "interaction-2",
					},
				},
				{
					interactionProfile: {
						...chatAgent.interactionProfile,
						backendProfileId: "ssh-build",
					},
				},
				{},
			]),
		).toEqual(new Set(["local", "ssh-build"]));
	});
});

describe("a chat Agent's finished turns", () => {
	const source = (patch: Partial<DureAgentActivityV1>): AgentAttentionSource => ({
		agentId: "agent-1",
		sessionId: "session-1",
		tiers: {
			heuristic: "exited",
			...structuredAgentTierInputs(
				chatAgent,
				{ local: { "agent-1": activity(patch) } },
				undefined,
			),
		},
	});

	it("are one completed-turn episode each, however long the turn ran", () => {
		let display = new Map();
		let counts: ReadonlyMap<string, string> = new Map();
		const round = (patch: Partial<DureAgentActivityV1>, baseline = false) => {
			const resolution = deriveAttentionResolution(display, [source(patch)], {}, {
				baseline,
				turnCompletedCounts: counts,
			});
			display = new Map(Object.entries(resolution.displayStates));
			counts = resolution.turnCompletedCounts;
			return resolution.bumps.map((bump) => bump.kind);
		};
		// A new Run's first turn: nothing has finished yet.
		expect(round({ activity: "working" }, true)).toEqual([]);
		expect(round({ attention: "approval_required", attentionId: "p-1" })).toEqual([
			"approval",
		]);
		expect(round({ activity: "working" })).toEqual([]);
		expect(round({ turnCompletedSequence: "57" })).toEqual(["done"]);
		// Read again (a reconnect's snapshot): no second episode.
		expect(round({ turnCompletedSequence: "57" })).toEqual([]);
		expect(round({ activity: "working", turnCompletedSequence: "57" })).toEqual([]);
		expect(round({ turnCompletedSequence: "93" })).toEqual(["done"]);
	});
});
