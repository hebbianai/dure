import { beforeEach, describe, expect, it, vi } from "vitest";
import { stopFenceFixture } from "@/test/agentFixtures";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { hmux } from "./hmux";

beforeEach(() => {
	mocks.invoke.mockReset();
});

describe("permanent managed retirement IPC", () => {
	const receipt = {
		schema: "hmux-managed-stop-v1",
		schemaVersion: 2,
		stopId: "accepted-stop",
		sessionId: "session",
		workspaceId: "workspace",
		...stopFenceFixture(),
		channelEpoch: 1,
		outcome: "stopped",
		exitReason: "managed_provider_stopped",
	};

	it("reads the permanent owner without requiring a saved generation or operation ID", async () => {
		const result = { kind: "finalized", receipt };
		mocks.invoke.mockResolvedValue(result);
		await expect(
			hmux.readManagedSessionRetirement("session", "workspace"),
		).resolves.toEqual(result);
		expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
			"hmux_managed_session_retirement",
			{ sessionId: "session", workspaceId: "workspace" },
		);
	});

	it.each(["no_ledger", "not_finalized"])(
		"preserves the owner's %s observation without manufacturing a completion",
		async (kind) => {
			mocks.invoke.mockResolvedValue({ kind });
			await expect(
				hmux.readManagedSessionRetirement("session", "workspace"),
			).resolves.toEqual({ kind });
		},
	);

	it.each([
		null,
		undefined,
		{},
		{ kind: "pending" },
		{ kind: "not_finalized", receipt },
		{ kind: "finalized" },
		{ kind: "finalized", receipt: { ...receipt, sessionId: "different" } },
		{ kind: "finalized", receipt: { ...receipt, workspaceId: "different" } },
		{ kind: "finalized", receipt: { ...receipt, schemaVersion: 1 } },
	])(
		"rejects an invalid or differently targeted observation (%j)",
		async (value) => {
			mocks.invoke.mockResolvedValue(value);
			await expect(
				hmux.readManagedSessionRetirement("session", "workspace"),
			).rejects.toThrow("managed_session_retirement_observation_invalid");
		},
	);

	it("propagates unreadable retirement rather than selecting legacy fallback", async () => {
		mocks.invoke.mockRejectedValue(new Error("ledger unreadable"));
		await expect(
			hmux.readManagedSessionRetirement("session", "workspace"),
		).rejects.toThrow("ledger unreadable");
		expect(mocks.invoke).toHaveBeenCalledOnce();
	});
});

describe("completed managed stop IPC", () => {
	it("carries the complete native fence without rounding a u64 epoch or invoking stop", async () => {
		const fence = stopFenceFixture({ channelEpoch: "18446744073709551615" });
		mocks.invoke.mockResolvedValue(null);
		await expect(
			hmux.readCompletedManagedStop(
				"stop-exact",
				"session",
				"workspace",
				fence,
			),
		).resolves.toBeNull();
		expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
			"hmux_managed_stop_completed",
			{
				stopId: "stop-exact",
				fence: {
					session_id: "session",
					workspace_id: "workspace",
					runner_principal: fence.runnerPrincipal,
					runner_instance: fence.runnerInstance,
					channel_epoch: "18446744073709551615",
					host_instance_id: fence.hostInstanceId,
					terminal_epoch: fence.terminalEpoch,
				},
			},
		);
	});

	it("does not substitute a stop command when completion observation is unavailable", async () => {
		mocks.invoke.mockRejectedValue(new Error("journal unreadable"));
		await expect(
			hmux.readCompletedManagedStop(
				"stop-exact",
				"session",
				"workspace",
				stopFenceFixture(),
			),
		).rejects.toThrow("journal unreadable");
		expect(mocks.invoke).toHaveBeenCalledOnce();
		expect(mocks.invoke.mock.calls[0][0]).toBe("hmux_managed_stop_completed");
	});
});
