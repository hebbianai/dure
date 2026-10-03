import { describe, expect, it, vi } from "vitest";
import { ManagedCreateRetrySameError } from "@/lib/hmux/managed/managedCreateResolution";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { Project } from "@/types";
import {
	isClosedManagedSourceLineage,
	type ManagedClosedLineageWakeDependencies,
	wakeClosedManagedLineage,
} from "./managedClosedLineageWake";

const project: Project = {
	id: "project-1",
	name: "Project",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

const routeAuthority = { profileId: "local" } as never;

function dependencies(
	responses: { inspect?: unknown; hibernate?: unknown; wake?: unknown } = {},
) {
	const client = {
		inspect: vi.fn().mockResolvedValue(
			responses.inspect ?? {
				state: "stable",
				selectionRevision: 3,
				routeAuthority,
			},
		),
		hibernate: vi.fn().mockResolvedValue(
			responses.hibernate ?? {
				state: "dormant",
				stage: "source_stopped",
				operationId: "runtime-transition-1",
				journalRevision: 2,
			},
		),
		wake: vi
			.fn()
			.mockResolvedValue(
				responses.wake ?? { state: "stable", sessionId: "session-woken" },
			),
	};
	const project_ = vi.fn();
	const deps: ManagedClosedLineageWakeDependencies = {
		snapshot: () => ({
			agents: [agentFixture({ runtimeBinding: managedBindingFixture() })],
			projects: [project],
		}),
		client: () => client as never,
		project: project_,
	};
	return { deps, client, project: project_ };
}

describe("closed managed source lineage", () => {
	it("recognizes only the checkout-closing refusal, wrapped or plain", () => {
		const message =
			"session_checkout_closing: checkout claim admission is closed";
		expect(
			isClosedManagedSourceLineage(
				new ManagedCreateRetrySameError(
					"create_retryable",
					"managed_create_outcome_unknown",
					message,
				),
			),
		).toBe(true);
		expect(isClosedManagedSourceLineage(message)).toBe(true);
		for (const other of [
			"session_checkout_unprepared: binding is not durable",
			"managed_create_outcome_unknown",
			new Error("worktree_identity_changed: replacement left its cwd"),
		]) {
			expect(isClosedManagedSourceLineage(other)).toBe(false);
		}
	});

	it("wakes the exact conversation on a new root through the backend and projects it", async () => {
		const { deps, client, project: projectRuntime } = dependencies();

		const woken = await wakeClosedManagedLineage(
			"agent-1",
			"conversation-1",
			deps,
		);

		expect(client.hibernate).toHaveBeenCalledWith({
			agentId: "agent-1",
			expectedSourceRevision: 3,
			routeAuthority,
		});
		expect(client.wake).toHaveBeenCalledWith(
			expect.objectContaining({
				state: "dormant",
				operationId: "runtime-transition-1",
			}),
			"conversation-1",
		);
		expect(projectRuntime).toHaveBeenCalledWith("agent-1", woken);
		expect(woken).toMatchObject({ sessionId: "session-woken" });
	});

	it("does not hibernate a runtime the backend no longer reports as stable", async () => {
		const {
			deps,
			client,
			project: projectRuntime,
		} = dependencies({
			inspect: { state: "closed" },
		});

		await expect(
			wakeClosedManagedLineage("agent-1", "conversation-1", deps),
		).rejects.toThrow("managed_runtime_recovery_source_closed");
		expect(client.hibernate).not.toHaveBeenCalled();
		expect(projectRuntime).not.toHaveBeenCalled();
	});

	it("uses the retained dormant operation without hibernating again", async () => {
		const dormant = {
			state: "dormant",
			stage: "source_stopped",
			agentId: "agent-1",
			operationId: "sleep-1",
			journalRevision: 4,
			routeAuthority,
		};
		const {
			deps,
			client,
			project: projectRuntime,
		} = dependencies({ inspect: dormant });
		const result = await wakeClosedManagedLineage(
			"agent-1",
			"conversation-1",
			deps,
		);
		expect(client.hibernate).not.toHaveBeenCalled();
		expect(client.wake).toHaveBeenCalledExactlyOnceWith(
			dormant,
			"conversation-1",
		);
		expect(projectRuntime).toHaveBeenCalledExactlyOnceWith("agent-1", result);
	});

	it.each(["transitioning", "closed", "unmanaged"])(
		"does not publish incomplete wake state %s",
		async (state) => {
			const {
				deps,
				client,
				project: projectRuntime,
			} = dependencies({ wake: { state } });
			await expect(
				wakeClosedManagedLineage("agent-1", "conversation-1", deps),
			).rejects.toThrow(`managed_runtime_recovery_wake_${state}`);
			expect(client.wake).toHaveBeenCalledOnce();
			expect(projectRuntime).not.toHaveBeenCalled();
		},
	);

	it("keeps a lost wake response uncertain without another stop or launch", async () => {
		const { deps, client, project: projectRuntime } = dependencies();
		const lost = new Error("response lost");
		client.wake.mockRejectedValueOnce(lost);
		await expect(
			wakeClosedManagedLineage("agent-1", "conversation-1", deps),
		).rejects.toBe(lost);
		expect(client.hibernate).toHaveBeenCalledOnce();
		expect(client.wake).toHaveBeenCalledOnce();
		expect(projectRuntime).not.toHaveBeenCalled();
	});

	it("leaves an Agent without a backend runtime route to the original failure", async () => {
		const { deps, client } = dependencies();
		deps.snapshot = () => ({ agents: [], projects: [project] });

		await expect(
			wakeClosedManagedLineage("agent-1", "conversation-1", deps),
		).resolves.toBeUndefined();
		expect(client.inspect).not.toHaveBeenCalled();
	});
});
