import { describe, expect, it } from "vitest";
import {
	createAgentRunLeadResolver,
	parseAgentRunParentSessionV1,
	parseAgentRunParentV1,
	projectAgentRunParent,
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
		expect(
			projectAgentRunParent(
				{ sessionId: "s-lead", workspaceId: "ws" },
				[lead],
				"work-1",
			),
		).toEqual(parent);
		expect(
			projectAgentRunParent({ sessionId: "s-shell", workspaceId: "ws" }, [lead], "work-1"),
		).toEqual({ sessionId: "s-shell", workspaceId: "ws" });
		expect(projectAgentRunParent(undefined, [lead], "work-1")).toBeUndefined();
	});
});
