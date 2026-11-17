import { describe, expect, it } from "vitest";
import type { AgentApprovalRequest } from "@/lib/agents/approvalRequest";
import {
	nativeAgentApprovalCardRequest,
	nativeAgentApprovalChoice,
	nativeAgentApprovalDecisions,
	presentNativeAgentApprovalError,
} from "@/lib/agents/chat/nativeAgentApproval";

const request: AgentApprovalRequest = {
	toolName: "Bash",
	summary: "cargo test",
	choices: ["approve", "approve_always", "deny"],
};

describe("native agent approvals", () => {
	it("offers exactly the provider's answers and maps them back", () => {
		expect(nativeAgentApprovalDecisions(request)).toEqual([
			"allow",
			"allow_always",
			"deny",
		]);
		expect(nativeAgentApprovalChoice(request, { decision: "allow" })).toBe(
			"approve",
		);
		expect(
			nativeAgentApprovalChoice(request, { decision: "allow_always" }),
		).toBe("approve_always");
		const onlyOnce = { ...request, choices: ["approve", "deny"] as const };
		expect(
			nativeAgentApprovalChoice(onlyOnce, { decision: "allow_always" }),
		).toBeUndefined();
		for (const answer of [undefined, "allow", { decision: "toString" }, {}]) {
			expect(nativeAgentApprovalChoice(request, answer)).toBeUndefined();
		}
	});

	it("renders as a permission request named by the approval", () => {
		const card = nativeAgentApprovalCardRequest(
			{ attentionId: "attention-3", request },
			{ agentId: "agent-1", terminalEpoch: "terminal-1" },
		);
		expect(card.request).toMatchObject({
			requestId: "attention-3",
			kind: "permission",
			payload: {
				toolName: "Bash",
				presentation: { description: "cargo test" },
			},
		});
		expect(card.runtime.runtimeGeneration).toBe("terminal-1");
	});

	it("names a stale or undeliverable answer and keeps its token", () => {
		const changed = presentNativeAgentApprovalError({
			code: "agent_runtime_native_answer_changed",
		});
		expect(changed.detail).toBe("agent_runtime_native_answer_changed");
		expect(changed.message).not.toBe(changed.detail);
		const unknown = presentNativeAgentApprovalError({ code: "something_else" });
		expect(unknown.message).not.toBe("something_else");
	});
});
