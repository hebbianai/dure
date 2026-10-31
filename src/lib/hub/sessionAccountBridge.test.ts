import { describe, expect, it, vi } from "vitest";
import type { AgentCredentialTransitionResult } from "@/lib/agents/agentCredentialTransition";
import { DureAgentRuntimeSourceActiveError } from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import type { AccountProfile, Agent } from "@/types";
import {
	createHubSessionAccountAnswerer,
	type SessionAccountPorts,
} from "./sessionAccountBridge";
import type {
	HubSessionAccountDispatch,
	HubSessionAccountReply,
} from "./sessionAccountWire";

const accounts: AccountProfile[] = [
	{ id: "acct-work", provider: "claude", name: "Work", dir: "/profiles/work" },
	{
		id: "acct-spare",
		provider: "claude",
		name: "Spare",
		dir: "/profiles/spare",
	},
];

function agent(credentialId = "acct-work"): Agent {
	return {
		id: "agent-1",
		provider: "claude",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
			sessionId: "hmux-1",
			workspaceId: "ws-1",
			credentialId,
		},
	} as Agent;
}

function harness(overrides: Partial<SessionAccountPorts> = {}) {
	const replies: HubSessionAccountReply[] = [];
	let current = agent();
	const ports: SessionAccountPorts = {
		agentForSession: (sessionId) =>
			sessionId === "hmux-1" ? current : undefined,
		agentById: (agentId) => (agentId === current.id ? current : undefined),
		accounts: () => accounts,
		usage: async () => {
			throw new Error("usage is advisory");
		},
		switchAccount: async (_agentId, target) => {
			current = agent(target ?? undefined);
			return { kind: "completed", conversationId: "conv-1" };
		},
		report: async (_requestId, reply) => {
			replies.push(reply);
			return true;
		},
		now: () => 1_000_000,
		...overrides,
	};
	return { answer: createHubSessionAccountAnswerer(ports), replies };
}

const read: HubSessionAccountDispatch = {
	request_id: "session-account-1",
	session_id: "hmux-1",
};

function press(
	account_id: string | null,
	action_id = "press-1",
): HubSessionAccountDispatch {
	return {
		request_id: "session-account-2",
		session_id: "hmux-1",
		switch: { action_id, account_id },
	};
}

describe("createHubSessionAccountAnswerer", () => {
	it("lists the selector's accounts without usage when usage cannot be read", async () => {
		const { answer, replies } = harness();
		await answer(read);
		expect(replies).toEqual([
			{
				outcome: "listed",
				accounts: [
					{ accountId: null, current: false, pending: false },
					{
						accountId: "acct-work",
						label: "Work",
						current: true,
						pending: false,
					},
					{
						accountId: "acct-spare",
						label: "Spare",
						current: false,
						pending: false,
					},
				],
			},
		]);
	});

	it("switches through the selector's transition and answers with the new state", async () => {
		const switchAccount = vi.fn(
			async (): Promise<AgentCredentialTransitionResult> => ({
				kind: "completed",
				conversationId: "conv-1",
			}),
		);
		const { answer, replies } = harness({ switchAccount });
		await answer(press("acct-spare"));
		expect(switchAccount).toHaveBeenCalledWith("agent-1", "acct-spare");
		expect(replies[0].outcome).toBe("switched");
	});

	it("reports a switch queued behind a running turn as scheduled", async () => {
		const { answer, replies } = harness({
			switchAccount: async () => ({
				kind: "scheduled",
				conversationId: "conv-1",
			}),
		});
		await answer(press(null));
		expect(replies[0].outcome).toBe("scheduled");
	});

	it("hands a retry of the same press the switch already taken", async () => {
		const switchAccount = vi.fn(
			async (): Promise<AgentCredentialTransitionResult> => ({
				kind: "completed",
				conversationId: "conv-1",
			}),
		);
		const { answer, replies } = harness({ switchAccount });
		await answer(press("acct-spare"));
		await answer(press("acct-spare"));
		expect(switchAccount).toHaveBeenCalledTimes(1);
		expect(replies.map((reply) => reply.outcome)).toEqual([
			"switched",
			"switched",
		]);
	});

	it("says in_progress rather than failing when the restart outlasts the watch", async () => {
		let finish: (value: AgentCredentialTransitionResult) => void = () => {};
		const switchAccount = vi.fn(
			() =>
				new Promise<AgentCredentialTransitionResult>((resolve) => {
					finish = resolve;
				}),
		);
		const { answer, replies } = harness({ switchAccount, watchDeadlineMs: 5 });
		await answer(press("acct-spare"));
		expect(replies[0]).toMatchObject({
			outcome: "in_progress",
			code: "still_switching",
		});
		finish({ kind: "completed", conversationId: "conv-1" });
		await answer(press("acct-spare"));
		expect(switchAccount).toHaveBeenCalledTimes(1);
		expect(replies[1].outcome).toBe("switched");
	});

	it("refuses an account outside the provider's pool and the account in use", async () => {
		const switchAccount = vi.fn();
		const { answer, replies } = harness({ switchAccount });
		await answer(press("acct-unknown", "press-a"));
		await answer(press("acct-work", "press-b"));
		expect(replies.map((reply) => reply.code)).toEqual([
			"account_missing",
			"already_current",
		]);
		expect(switchAccount).not.toHaveBeenCalled();
	});

	it("refuses a session this computer does not hold", async () => {
		const { answer, replies } = harness();
		await answer({ ...read, session_id: "hmux-gone" });
		expect(replies[0]).toMatchObject({
			outcome: "refused",
			code: "session_missing",
		});
	});

	it("keeps busy apart from failure, and never interrupts", async () => {
		const busy = new DureAgentRuntimeSourceActiveError(
			new DureBackendRequestError("agent_runtime_source_active", "busy", {
				kind: "authority_changed",
			}),
		);
		const { answer, replies } = harness({
			switchAccount: async () => {
				throw busy;
			},
		});
		await answer(press("acct-spare", "press-busy"));
		const failing = harness({
			switchAccount: async () => {
				throw new Error("agent_runtime_provider_conversation_unavailable");
			},
		});
		await failing.answer(press("acct-spare", "press-fail"));
		expect(replies[0]).toMatchObject({ outcome: "refused", code: "busy" });
		expect(failing.replies[0]).toMatchObject({
			outcome: "refused",
			code: "failed",
		});
	});
});
