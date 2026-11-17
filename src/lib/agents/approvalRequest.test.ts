import { describe, expect, it } from "vitest";
import {
	type AgentApprovalRequest,
	approvalShown,
	parseAgentApprovalRequest,
	pendingApproval,
} from "@/lib/agents/approvalRequest";

const request: AgentApprovalRequest = {
	toolName: "Bash",
	summary: "cargo test",
	choices: ["approve", "approve_always", "deny"],
};

const asking = {
	lifecycle: "running",
	attention: "approval_required",
	attentionId: "attention-3",
	approvalRequest: request,
};

describe("parseAgentApprovalRequest", () => {
	it("reads the tool, its input summary and the offered answers", () => {
		expect(
			parseAgentApprovalRequest({
				toolName: "Bash",
				summary: "cargo test\n  --all",
				choices: ["approve", "approve_always", "deny"],
			}),
		).toEqual({
			toolName: "Bash",
			summary: "cargo test\n  --all",
			choices: ["approve", "approve_always", "deny"],
		});
		expect(
			parseAgentApprovalRequest({
				toolName: "Read",
				choices: ["approve", "deny"],
			}),
		).toEqual({ toolName: "Read", choices: ["approve", "deny"] });
	});

	it("drops formatting characters that could reorder what is approved", () => {
		expect(
			parseAgentApprovalRequest({
				toolName: "Bash",
				summary: "rm ‮fdp.txt",
				choices: ["approve", "deny"],
			})?.summary,
		).toBe("rm fdp.txt");
	});

	it("leaves anything malformed absent instead of failing the state", () => {
		for (const value of [
			undefined,
			null,
			"Bash",
			{ toolName: "", choices: ["approve", "deny"] },
			{ toolName: "Bash\u0007", choices: ["approve", "deny"] },
			{ toolName: "Bash", summary: "a\u001b[2J", choices: ["approve", "deny"] },
			{
				toolName: "Bash",
				summary: "x".repeat(2049),
				choices: ["approve", "deny"],
			},
			{ toolName: "Bash", choices: [] },
			{ toolName: "Bash", choices: ["approve"] },
			{ toolName: "Bash", choices: ["approve", "deny", "deny"] },
			{ toolName: "Bash", choices: ["approve", "maybe", "deny"] },
		]) {
			expect(parseAgentApprovalRequest(value)).toBeUndefined();
		}
	});
});

describe("pending approvals", () => {
	it("shows only a named approval whose provider said what it asks", () => {
		expect(pendingApproval(asking)).toEqual({
			attentionId: "attention-3",
			request,
		});
		for (const runtime of [
			{ ...asking, approvalRequest: undefined },
			{ ...asking, attentionId: undefined },
			{ ...asking, attention: "input_required" },
			{ ...asking, lifecycle: "exited" },
			undefined,
		]) {
			expect(pendingApproval(runtime)).toBeUndefined();
		}
	});

	it("stays until this chat's answer reached the terminal", () => {
		const approval = { attentionId: "attention-3", request };
		expect(approvalShown(approval, undefined)).toBe(true);
		expect(
			approvalShown(approval, { attentionId: "attention-3", state: "sending" }),
		).toBe(true);
		expect(
			approvalShown(approval, { attentionId: "attention-3", state: "sent" }),
		).toBe(false);
		// A later approval is shown even right after an answer to an earlier one.
		expect(
			approvalShown(approval, { attentionId: "attention-2", state: "sent" }),
		).toBe(true);
		expect(approvalShown(undefined, undefined)).toBe(false);
	});
});
