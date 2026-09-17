import type { DockviewApi } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { hmux } from "@/lib/ipc";
import { useStore } from "@/store";
import {
	createHmuxManagedShellTerminalOn,
	openHmuxManagedTerminalOn,
} from "./managedShellTerminal";

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ label: "main" }),
}));

const created = {
	idempotencyKey: "shell_managed-created",
	outcome: "created" as const,
	session: {
		sessionId: "managed-created",
		workspaceId: "dure-local-shells-v1",
		sessionClass: "managed" as const,
		lifecycle: "ready" as const,
		manifestLifecycle: "ready" as const,
		health: "current_healthy" as const,
		inputAllowed: true,
		terminalEpoch: "epoch-created",
		outputSeq: "0",
		capabilities: ["ansi_redraw_v1"],
		stopFence: {
			runnerPrincipal: "principal-managed-created",
			runnerInstance: "runner-managed-created",
			channelEpoch: "1",
			hostInstanceId: "host-managed-created",
			terminalEpoch: "epoch-created",
		},
	},
};

afterEach(() => {
	vi.restoreAllMocks();
	useStore.setState({ hmuxSessionMetadata: {}, layouts: {} });
});

describe("createHmuxManagedShellTerminalOn", () => {
	it("lifts a requested rail width out of Dockview's position", () => {
		const railWidth = 576;
		const addPanel = vi.fn();
		const api = {
			panels: [{ api: { component: "launcher" } }],
			getPanel: () => undefined,
			addPanel,
		} as unknown as DockviewApi;
		openHmuxManagedTerminalOn(
			api,
			"managed-created",
			"dure-local-shells-v1",
			"/repo",
			{ direction: "right", initialWidth: railWidth },
		);
		expect(addPanel).toHaveBeenCalledWith(
			expect.objectContaining({
				initialWidth: railWidth,
				position: { direction: "right" },
			}),
		);
	});

	it("publishes the managed receipt before mounting an ordinary shell pane", async () => {
		const addPanel = vi.fn(({ id }: { id: string }) => {
			expect(
				useStore.getState().hmuxSessionMetadata[
					hmuxSessionMetadataKey(
						created.session.workspaceId,
						created.session.sessionId,
					)
				],
			).toMatchObject(created.session);
			return { id };
		});
		vi.spyOn(hmux, "createManagedShell").mockResolvedValue(created);
		const api = {
			panels: [],
			getPanel: () => undefined,
			addPanel,
		} as unknown as DockviewApi;
		const result = await createHmuxManagedShellTerminalOn(
			api,
			"/repo",
			undefined,
			undefined,
			undefined,
			"managed-created",
		);
		expect(result).toMatchObject(created);
		expect(result.panelId).not.toMatch(/^(agent|term|terminal|launcher):/);
		expect(addPanel).toHaveBeenCalledWith(
			expect.objectContaining({
				id: result.panelId,
				params: expect.objectContaining({
					sessionId: "managed-created",
					binding: expect.objectContaining({
						runtime: "hmux_managed_v1",
						createIdempotencyKey: "shell_managed-created",
					}),
				}),
			}),
		);
	});

	it.each(["created", "reused"] as const)(
		"closes only the newly created lifetime after presentation failure (%s)",
		async (outcome) => {
			vi.spyOn(hmux, "createManagedShell").mockResolvedValue({
				...created,
				outcome,
			});
			const exactStop = vi
				.spyOn(hmux, "stopManaged")
				.mockRejectedValue(new Error("generation-only cleanup"));
			const close = vi.spyOn(hmux, "stopManagedCreateChain").mockResolvedValue({
				schema: "hmux-managed-create-chain-stop-v2",
				schemaVersion: 2,
				chain: [
					{
						schema: "hmux-managed-create-reconcile-v1",
						schemaVersion: 1,
						idempotencyKey: created.idempotencyKey,
						sessionId: created.session.sessionId,
						workspaceId: created.session.workspaceId,
					},
				],
			});
			const api = {
				panels: [],
				getPanel: () => undefined,
				addPanel: vi.fn(),
			} as unknown as DockviewApi;
			await expect(
				createHmuxManagedShellTerminalOn(
					api,
					"/repo",
					undefined,
					undefined,
					"removed-desktop",
					"managed-created",
				),
			).rejects.toMatchObject({ code: "pane_changed" });
			if (outcome === "created") {
				expect(close).toHaveBeenCalledWith(
					created.idempotencyKey,
					created.session.sessionId,
					created.session.workspaceId,
				);
			} else {
				expect(close).not.toHaveBeenCalled();
			}
			expect(exactStop).not.toHaveBeenCalled();
		},
	);
});
