import { describe, expect, it, vi } from "vitest";
import {
	answerHubStartAgent,
	type HubStartAgentReply,
	type StartAgentPorts,
	StartAgentStillRunningError,
} from "./startAgentBridge";

function ports(overrides: Partial<StartAgentPorts> = {}) {
	const replies: HubStartAgentReply[] = [];
	const base: StartAgentPorts = {
		seat: () => ({ spaceId: "s1", projectId: "p1", startable: true }),
		space: () => true,
		folder: async () => ({ projectId: "p2", startable: true }),
		kindAllowed: () => true,
		reveal: async () => true,
		start: async () => ({ agentId: "a1" }),
		session: () => "sess-1",
		report: async (_requestId, reply) => {
			replies.push(reply);
			return true;
		},
		...overrides,
	};
	return { ports: base, replies };
}

const press = {
	request_id: "start-agent-1",
	target_id: "s1 p1",
	kind_id: "claude",
	action_id: "act-1",
};

describe("answerHubStartAgent", () => {
	it("starts the agent at the seat the phone pressed", async () => {
		const start = vi.fn(async () => ({ agentId: "a1" }));
		const { ports: p, replies } = ports({ start });
		await answerHubStartAgent(press, p);

		expect(start).toHaveBeenCalledWith({
			projectId: "p1",
			spaceId: "s1",
			kindId: "claude",
			actionId: "act-1",
			// Absent on the wire means yes — an older phone that says nothing
			// must not have its agent put inside somebody's own checkout.
			useWorktree: true,
		});
		expect(replies).toEqual([
			{ started: true, agentId: "a1", sessionId: "sess-1" },
		]);
	});

	it("registers a browsed folder and keeps the chosen space", async () => {
		const folder = vi.fn(async () => ({ projectId: "p-new", startable: true }));
		const start = vi.fn(async () => ({ agentId: "a1" }));
		const { ports: p } = ports({ seat: () => undefined, folder, start });

		await answerHubStartAgent(
			{ ...press, folder_path: "/Users/me/dev/new" },
			p,
		);

		expect(folder).toHaveBeenCalledWith("/Users/me/dev/new");
		expect(start).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "p-new", spaceId: "s1" }),
		);
	});

	/**
	 * The saga registers the agent before its session exists. Calling that a
	 * failure would send somebody to press again, and a second press is a
	 * second agent.
	 */
	it("reports a started agent that has no session yet as started", async () => {
		const { ports: p, replies } = ports({ session: () => undefined });
		await answerHubStartAgent(press, p);

		expect(replies[0]).toEqual({ started: true, agentId: "a1" });
	});

	/**
	 * The offer is a snapshot. Between the phone reading it and somebody
	 * pressing, the folder can be gone — and "nothing happened" is the one
	 * answer a phone cannot act on.
	 */
	/**
	 * The phone's worktree switch and the branch somebody typed reach the saga
	 * unchanged. An empty branch is "they left it alone", not an empty name, so
	 * it is dropped rather than forwarded as "".
	 */
	it("carries the worktree choice and a typed branch through", async () => {
		const seen: unknown[] = [];
		const { ports: p } = ports({
			start: async (plan) => {
				seen.push(plan);
				return { agentId: "a1" };
			},
		});
		await answerHubStartAgent({ ...press, use_worktree: false }, p);
		await answerHubStartAgent({ ...press, branch: "  agent/x  " }, p);
		await answerHubStartAgent({ ...press, branch: "   " }, p);

		expect(seen).toEqual([
			expect.objectContaining({ useWorktree: false }),
			expect.objectContaining({ useWorktree: true, branch: "agent/x" }),
			expect.not.objectContaining({ branch: expect.anything() }),
		]);
	});

	it("refuses a seat that is no longer there, with a reason", async () => {
		const start = vi.fn();
		const { ports: p, replies } = ports({ seat: () => undefined, start });
		await answerHubStartAgent(press, p);

		expect(start).not.toHaveBeenCalled();
		expect(replies[0]?.started).toBe(false);
		expect(replies[0]?.code).toBe("target_missing");
		expect(replies[0]?.detail).toBeTruthy();
	});

	it("refuses an id that names no seat at all", async () => {
		const start = vi.fn();
		const { ports: p, replies } = ports({ start });
		await answerHubStartAgent({ ...press, target_id: "nonsense" }, p);

		expect(start).not.toHaveBeenCalled();
		expect(replies[0]?.code).toBe("target_missing");
	});

	it("refuses a folder whose host is unavailable", async () => {
		const start = vi.fn();
		const { ports: p, replies } = ports({
			seat: () => ({ spaceId: "s1", projectId: "p2", startable: false }),
			start,
		});
		await answerHubStartAgent(press, p);

		expect(start).not.toHaveBeenCalled();
		expect(replies[0]?.code).toBe("target_missing");
	});

	it("refuses an agent this computer does not have", async () => {
		const start = vi.fn();
		const { ports: p, replies } = ports({ kindAllowed: () => false, start });
		await answerHubStartAgent(press, p);

		expect(start).not.toHaveBeenCalled();
		expect(replies[0]?.code).toBe("kind_missing");
	});

	/**
	 * A space with no mounted dock has nowhere to put a pane. Refusing is what
	 * keeps the agent from landing in whichever space happened to be in front.
	 */
	it("refuses when the chosen space cannot be brought up", async () => {
		const start = vi.fn();
		const { ports: p, replies } = ports({ reveal: async () => false, start });
		await answerHubStartAgent(press, p);

		expect(start).not.toHaveBeenCalled();
		expect(replies[0]?.code).toBe("space_unavailable");
	});

	/**
	 * "아직 도는 중" 은 실패가 아니다. 실패로 접으면 폰이 "다시 고르기" 를
	 * 내밀고, 그 누름은 이미 뜨고 있는 에이전트 옆에 하나를 더 만든다.
	 */
	it("a run that has not stopped moving is not reported as a failure", async () => {
		const { ports: p, replies } = ports({
			start: async () => {
				throw new StartAgentStillRunningError();
			},
		});
		await answerHubStartAgent(press, p);

		expect(replies[0]?.started).toBe(false);
		expect(replies[0]?.code).toBe("still_starting");
	});

	it("turns a saga failure into a refusal the phone can read", async () => {
		const { ports: p, replies } = ports({
			start: async () => {
				throw new Error("worktree_locked");
			},
		});
		await answerHubStartAgent(press, p);

		expect(replies[0]?.started).toBe(false);
		expect(replies[0]?.code).toBe("failed");
		expect(replies[0]?.detail).toContain("worktree_locked");
	});

	/**
	 * The phone retries with the press's own name, and that name is the saga's
	 * idempotency key — so a retry rejoins the run already in flight instead of
	 * starting a second agent. This asserts the name is carried; the journal
	 * enforces what it means.
	 */
	it("carries the press's own name into the saga, so a retry is not a second agent", async () => {
		const seen: string[] = [];
		const { ports: p } = ports({
			start: async (plan) => {
				seen.push(plan.actionId);
				return { agentId: "a1" };
			},
		});
		await answerHubStartAgent(press, p);
		await answerHubStartAgent(press, p);

		expect(seen).toEqual(["act-1", "act-1"]);
	});
});
