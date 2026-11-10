// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type RestoreAllDependencies,
	restoreAllManagedAgents,
} from "@/lib/sessions/managed/managedRestoreAll";
import type { ManagedRebootRecoveryAssessment } from "@/lib/sessions/managed/managedRebootRecovery";
import {
	getRestoreAllState,
	publishRestoreAllOffer,
	resetRestoreAllForTest,
} from "@/lib/sessions/managed/managedRestoreAllOffer";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";

vi.mock("@/lib/sessions/managed/automaticManagedRehostService", () => ({
	observeManagedRebootRecovery: vi.fn(),
	publishRebootRecoveryPaneState: vi.fn(),
	recoverRebootStaleManagedAgent: vi.fn(),
}));

function restorable(agentId: string): ManagedRebootRecoveryAssessment {
	return {
		outcome: "restorable",
		candidate: {
			identity: `identity-${agentId}`,
			agentId,
			desktopId: `space-${agentId}`,
			panelId: `agent:${agentId}`,
			conversationId: `conversation-${agentId}`,
		},
	};
}

function dependencies(
	patch: Partial<RestoreAllDependencies> = {},
): RestoreAllDependencies {
	return {
		observe: vi.fn(async () => []),
		recover: vi.fn(async () => true),
		inspectWorktree: vi.fn(async () => "present" as const),
		publishPaneState: vi.fn(),
		exclusive: (operation) => operation(),
		...patch,
	};
}

const named = (agentId: string) => ({
	identity: `identity-${agentId}`,
	agentId,
	name: `Agent ${agentId}`,
});

beforeEach(() => {
	resetRestoreAllForTest();
	useStore.setState({
		agents: ["a", "b", "c", "d", "e"].map((id) =>
			agentFixture({ id, name: `Agent ${id}` }),
		),
	});
});

describe("restore all agents", () => {
	it("restores each agent once and reports every one it could not, with the reason", async () => {
		const recover = vi.fn(async (candidate: { agentId: string }) => {
			if (candidate.agentId === "c") return false;
			if (candidate.agentId === "d") throw new Error("backend refused");
			return true;
		});
		const deps = dependencies({
			observe: vi.fn(async () => [
				restorable("a"),
				restorable("b"),
				restorable("c"),
				restorable("d"),
				{
					outcome: "skipped" as const,
					identity: "identity-e",
					agentId: "e",
					reason: "no_conversation_id" as const,
				},
			]),
			recover,
			inspectWorktree: vi.fn(async (agentId: string) =>
				agentId === "b" ? ("missing" as const) : ("present" as const),
			),
		});

		await restoreAllManagedAgents(deps);

		expect(recover.mock.calls.map(([candidate]) => candidate.agentId)).toEqual([
			"a",
			"c",
			"d",
		]);
		expect(getRestoreAllState()).toEqual({
			phase: "report",
			restored: [named("a")],
			skipped: [
				{ ...named("e"), reason: "no_conversation_id" },
				{ ...named("b"), reason: "worktree_missing" },
				{ ...named("c"), reason: "state_changed" },
			],
			failed: [named("d")],
		});
		expect(deps.publishPaneState).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "d" }),
			"error",
			"restore_all_failed",
		);
		expect(deps.publishPaneState).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "b" }),
			"error",
			"worktree_missing",
		);
	});

	it("does not mark a pane failed once its successor exists", async () => {
		const deps = dependencies({
			observe: vi.fn(async () => [restorable("a")]),
			recover: vi.fn(async (_candidate, progress) => {
				progress.replacement = { sessionId: "after" } as never;
				throw new Error("commit deferred");
			}),
		});

		await restoreAllManagedAgents(deps);

		expect(deps.publishPaneState).not.toHaveBeenCalledWith(
			expect.anything(),
			"error",
			expect.anything(),
		);
		expect(getRestoreAllState()).toMatchObject({ failed: [named("a")] });
	});

	it("changes nothing when the agents' state can't be read", async () => {
		const deps = dependencies({ observe: vi.fn(async () => undefined) });
		await restoreAllManagedAgents(deps);
		expect(deps.recover).not.toHaveBeenCalled();
		expect(getRestoreAllState()).toEqual({
			phase: "report",
			restored: [],
			skipped: [],
			failed: [],
			unavailable: true,
		});
	});

	it("runs once at a time, under the unattended pass's lock", async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let exclusiveCalls = 0;
		const exclusive: RestoreAllDependencies["exclusive"] = async (
			operation,
		) => {
			exclusiveCalls += 1;
			await held;
			return operation();
		};
		const deps = dependencies({
			observe: vi.fn(async () => [restorable("a")]),
			exclusive,
		});
		publishRestoreAllOffer({ restorable: [named("a")], skipped: [] });

		const first = restoreAllManagedAgents(deps);
		const second = restoreAllManagedAgents(deps);
		expect(getRestoreAllState()).toMatchObject({ phase: "restoring" });
		release();
		await Promise.all([first, second]);

		expect(exclusiveCalls).toBe(1);
		expect(deps.recover).toHaveBeenCalledOnce();
		expect(getRestoreAllState()).toMatchObject({ restored: [named("a")] });
	});
});
