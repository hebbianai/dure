import { describe, expect, it } from "vitest";
import {
	agentRunParentKey,
	createAgentRunLeadResolver,
	parseAgentRunParentSessionV1,
	parseAgentRunParentV1,
	parseRequestedAgentRunParent,
	presentedAgentRunParent,
} from "@/lib/agents/agentRunParent";
import type { Agent } from "@/types";

function agent(
	id: string,
	sessionId: string | undefined,
	runParent?: Agent["runParent"],
): Agent {
	return {
		id,
		name: id,
		provider: "claude",
		projectId: "project",
		worktreePath: `/repo/${id}`,
		branch: id,
		sessionId: sessionId ?? id,
		sessionKind: "pty",
		...(sessionId
			? {
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "hmux_managed_v1",
						source: "local",
						hostId: "local",
						sessionId,
						workspaceId: "ws",
					},
				}
			: {}),
		...(runParent ? { runParent } : {}),
	} as Agent;
}

describe("parseAgentRunParent", () => {
	it("accepts exactly the receipt's parent on the wire", () => {
		expect(
			parseAgentRunParentSessionV1({ sessionId: "s-lead", workspaceId: "ws" }),
		).toEqual({ sessionId: "s-lead", workspaceId: "ws" });
		expect(
			parseAgentRunParentSessionV1({
				sessionId: "s-lead",
				workspaceId: "ws",
				leadAgentId: "lead",
			}),
		).toBeUndefined();
		expect(
			parseAgentRunParentSessionV1({ sessionId: "s lead", workspaceId: "ws" }),
		).toBeUndefined();
	});

	it("keeps the recorded lead in the persisted projection and drops anything malformed", () => {
		expect(
			parseAgentRunParentV1({
				sessionId: "s-lead",
				workspaceId: "ws",
				leadAgentId: "lead",
			}),
		).toEqual({ sessionId: "s-lead", workspaceId: "ws", leadAgentId: "lead" });
		expect(parseAgentRunParentV1({ sessionId: "s-lead" })).toBeUndefined();
		expect(parseAgentRunParentV1("s-lead")).toBeUndefined();
	});

	it("refuses a present but malformed parent on a request", () => {
		const refuse = (message: string): never => {
			throw new Error(message);
		};
		expect(parseRequestedAgentRunParent(undefined, refuse)).toBeUndefined();
		expect(
			parseRequestedAgentRunParent({ sessionId: "s-lead", workspaceId: "ws" }, refuse),
		).toEqual({ sessionId: "s-lead", workspaceId: "ws" });
		expect(() => parseRequestedAgentRunParent({ sessionId: "s-lead" }, refuse)).toThrow(
			"parent is invalid",
		);
	});
});

describe("createAgentRunLeadResolver", () => {
	const parent = { sessionId: "s-lead", workspaceId: "ws", leadAgentId: "lead" };

	it("resolves the Agent whose runtime binding is the parent Session", () => {
		const lead = agent("lead", "s-lead");
		const worker = agent("work-1", "s-1", parent);
		expect(createAgentRunLeadResolver([lead, worker])(worker)).toBe(lead);
	});

	it("falls back to the recorded lead after the lead was rehosted", () => {
		const rehosted = agent("lead", "s-lead-2");
		const worker = agent("work-1", "s-1", parent);
		expect(createAgentRunLeadResolver([rehosted, worker])(worker)).toBe(rehosted);
	});

	it("degrades to no lead when it is gone, ambiguous, or the worker itself", () => {
		const worker = agent("work-1", "s-1", parent);
		expect(createAgentRunLeadResolver([worker])(worker)).toBeUndefined();
		const twins = [agent("a", "s-lead"), agent("b", "s-lead"), worker];
		expect(createAgentRunLeadResolver(twins)(worker)).toBeUndefined();
		const self = agent("work-1", "s-lead", {
			sessionId: "s-lead",
			workspaceId: "ws",
			leadAgentId: "work-1",
		});
		expect(createAgentRunLeadResolver([self])(self)).toBeUndefined();
		const plain = agent("plain", "s-plain");
		expect(createAgentRunLeadResolver([plain])(plain)).toBeUndefined();
	});

	it("records the current owner of the parent Session at first projection", () => {
		const lead = agent("lead", "s-lead");
		const requested = { sessionId: "s-lead", workspaceId: "ws" };
		expect(presentedAgentRunParent({ id: "work-1" }, requested, [lead])).toEqual({
			runParent: parent,
		});
		expect(
			presentedAgentRunParent(
				{ id: "work-1" },
				{ sessionId: "s-shell", workspaceId: "ws" },
				[lead],
			),
		).toEqual({ runParent: { sessionId: "s-shell", workspaceId: "ws" } });
		expect(presentedAgentRunParent({ id: "work-1" }, undefined, [lead])).toEqual({});
	});

	it("keeps a recorded parent when the Run is presented again", () => {
		const recorded = { sessionId: "s-old", workspaceId: "ws", leadAgentId: "lead" };
		expect(
			presentedAgentRunParent(
				{ id: "work-1", runParent: recorded },
				{ sessionId: "s-lead", workspaceId: "ws" },
				[agent("other", "s-lead")],
			),
		).toEqual({ runParent: recorded });
	});
});

describe("a Chat agent as a Run's parent", () => {
	const refuse = (message: string): never => {
		throw new Error(message);
	};

	it("accepts exactly an Agent parent on a request and in the persisted projection", () => {
		expect(
			parseRequestedAgentRunParent({ agentId: "agent-coordinator" }, refuse),
		).toEqual({ agentId: "agent-coordinator" });
		expect(() =>
			parseRequestedAgentRunParent(
				{ agentId: "agent-coordinator", sessionId: "s-lead" },
				refuse,
			),
		).toThrow("parent is invalid");
		expect(() =>
			parseRequestedAgentRunParent({ agentId: "has space" }, refuse),
		).toThrow("parent is invalid");
		expect(parseAgentRunParentV1({ agentId: "agent-coordinator" })).toEqual({
			agentId: "agent-coordinator",
		});
		// A malformed parent only ungroups the Agent.
		expect(
			parseAgentRunParentV1({ agentId: "agent-coordinator", leadAgentId: "x" }),
		).toBeUndefined();
	});

	it("records the Agent as it is and lists no Session lead for it", () => {
		const coordinator = agent("agent-coordinator", undefined);
		expect(
			presentedAgentRunParent(
				{ id: "work-1" },
				{ agentId: "agent-coordinator" },
				[coordinator],
			),
		).toEqual({ runParent: { agentId: "agent-coordinator" } });
		// The relation facts read an Agent parent as it is; it names no
		// Session for this resolver to look up.
		const worker = agent("work-1", "s-1", { agentId: "agent-coordinator" });
		expect(createAgentRunLeadResolver([coordinator, worker])(worker)).toBeUndefined();
	});

	it("keys an Agent parent apart from any Session parent", () => {
		for (const [workspaceId, sessionId] of [
			["agent", "a"],
			["a", "agent"],
			["ws", "a"],
		]) {
			expect(agentRunParentKey({ agentId: "a" })).not.toBe(
				agentRunParentKey({ sessionId, workspaceId }),
			);
		}
		expect(agentRunParentKey({ agentId: "a" })).toBe(
			agentRunParentKey({ agentId: "a" }),
		);
	});
});
