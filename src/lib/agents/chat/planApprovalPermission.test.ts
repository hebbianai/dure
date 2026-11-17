import { describe, expect, it } from "vitest";
import type { AgentTimelineRowV1 } from "@/lib/agents/chat/agentConversationContract";
import { approvedPlanPermission } from "@/lib/agents/chat/planApprovalPermission";

let sequence = 0;

function row(
	itemId: string,
	body: AgentTimelineRowV1["item"]["body"],
): AgentTimelineRowV1 {
	sequence += 1;
	return {
		cursor: { epoch: "timeline-1", sequence },
		item: {
			itemId,
			turnId: "turn-1",
			clientMessageId: null,
			providerMessageId: null,
			body,
			createdAtMs: sequence,
		},
	};
}

function evidence(itemId: string, kind: string, value: unknown) {
	return row(itemId, {
		type: "provider_evidence",
		namespace: "provider.claude",
		kind,
		value,
	});
}

const init = (itemId = "init", permissionMode = "plan") =>
	evidence(itemId, "provider_session_initialized", { permissionMode });

const reported = (
	itemId: string,
	permissionMode: string | null,
	providerPermissionMode = "default",
) =>
	evidence(itemId, "provider_permission_mode", {
		permissionMode,
		providerPermissionMode,
	});

function answer(
	itemId: string,
	decision: "allow" | "deny",
	toolName = "ExitPlanMode",
) {
	return row(itemId, {
		type: "pending_answer",
		idempotencyKey: `key-${itemId}`,
		request: {
			interactionSessionId: "interaction-1",
			runtime: { runtimeGeneration: "runtime-1", providerEpoch: "query-1" },
			request: {
				requestId: `request-${itemId}`,
				kind: "permission",
				turnId: "turn-1",
				clientMessageId: "message-1",
				payload: { toolName, input: { plan: "# Plan" } },
				createdAtMs: 1,
			},
		},
		answer: { decision },
	});
}

describe("approvedPlanPermission", () => {
	it("follows the mode Claude reports after the plan is approved", () => {
		expect(
			approvedPlanPermission(
				[
					init(),
					answer("approve", "allow"),
					reported("mode", "auto_edit", "acceptEdits"),
				],
				{ turnActive: true },
			),
		).toEqual({ approvalItemId: "approve", permissionMode: "auto_edit" });
	});

	it("accepts the report even when it is recorded before the approval", () => {
		expect(
			approvedPlanPermission(
				[init(), reported("mode", "default"), answer("approve", "allow")],
				{ turnActive: true },
			),
		).toEqual({ approvalItemId: "approve", permissionMode: "default" });
	});

	it("waits for Claude's report while the turn runs, then uses the restored mode", () => {
		const rows = [init(), answer("approve", "allow")];
		expect(approvedPlanPermission(rows, { turnActive: true })).toBeNull();
		expect(approvedPlanPermission(rows, { turnActive: false })).toEqual({
			approvalItemId: "approve",
			permissionMode: "default",
		});
	});

	it("uses the restored mode when Claude reports one Dure cannot select", () => {
		expect(
			approvedPlanPermission(
				[init(), answer("approve", "allow"), reported("mode", null, "auto")],
				{ turnActive: true },
			),
		).toEqual({ approvalItemId: "approve", permissionMode: "default" });
	});

	it("keeps plan mode when the person keeps planning", () => {
		expect(
			approvedPlanPermission([init(), answer("keep", "deny")], {
				turnActive: false,
			}),
		).toBeNull();
		expect(
			approvedPlanPermission(
				[
					init(),
					answer("approve", "allow"),
					reported("mode", "default"),
					answer("keep", "deny"),
				],
				{ turnActive: false },
			),
		).toBeNull();
	});

	it("keeps plan mode while Claude still reports it", () => {
		expect(
			approvedPlanPermission(
				[
					init(),
					answer("first", "allow"),
					reported("left", "default"),
					reported("again", "plan", "plan"),
					answer("second", "allow"),
				],
				{ turnActive: true },
			),
		).toBeNull();
	});

	it("ignores approvals from an earlier launch", () => {
		expect(
			approvedPlanPermission(
				[
					init("old"),
					answer("approve", "allow"),
					reported("mode", "default"),
					init("new"),
				],
				{ turnActive: false },
			),
		).toBeNull();
	});

	it("ignores other permission answers", () => {
		expect(
			approvedPlanPermission([init(), answer("bash", "allow", "Bash")], {
				turnActive: false,
			}),
		).toBeNull();
	});
});
