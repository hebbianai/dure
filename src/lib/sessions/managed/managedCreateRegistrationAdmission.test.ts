import { beforeEach, describe, expect, it } from "vitest";
import { ManagedCreateRetrySameError } from "@/lib/hmux/managed/managedCreateResolution";
import { admitManagedCreateRegistration } from "@/lib/sessions/managed/managedCreateRegistrationAdmission";
import { useStore } from "@/store";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

function stagedAgent(patch: Partial<Agent> = {}): Agent {
	return agentFixture({
		id: "agent-staged",
		sessionId: "session-retired",
		started: false,
		worktreePath: "/repo/worktree",
		runtimeBinding: managedBindingFixture({
			sessionId: "session-retired",
			workspaceId: "workspace-1",
			createIdempotencyKey: "session-retired",
			stopFence: undefined,
		}),
		...patch,
	});
}

beforeEach(() => {
	useStore.setState({
		agents: [stagedAgent()],
		sessionCwd: { "session-retired": "/repo/worktree" },
	});
});

describe("managed create registration admission", () => {
	it("retains uncertain identity without mutating its registration", async () => {
		const source = stagedAgent();
		const pending = new ManagedCreateRetrySameError(
			"pending",
			"hmux_managed_create_pending",
			"still pending",
		);

		const outcome = await admitManagedCreateRegistration(source, async () => {
			throw pending;
		});

		expect(outcome).toEqual({
			state: "retained",
			agent: source,
			error: pending,
		});
		expect(useStore.getState().agents).toEqual([source]);
	});

	it("rejects an ordinary pre-effect error without mutating registration", async () => {
		const source = stagedAgent();
		const rejected = new Error("preflight rejected");

		const outcome = await admitManagedCreateRegistration(source, async () => {
			throw rejected;
		});

		expect(outcome).toEqual({
			state: "rejected",
			agent: source,
			error: rejected,
		});
		expect(useStore.getState().agents).toEqual([source]);
	});
});
