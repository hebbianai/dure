// @vitest-environment jsdom

import { createDockview } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hmux } from "@/lib/ipc";
import { replaceManagedAgentPaneWithShell } from "@/lib/sessions/managed/managedAgentPaneToShell";
import { useStore } from "@/store";

const disposals: (() => void)[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dispose of disposals.splice(0)) dispose();
	useStore.setState({ hmuxSessionMetadata: {} });
});

function receipt(request: Parameters<typeof hmux.createManagedShell>[0]) {
	return {
		idempotencyKey: request.idempotencyKey,
		outcome: "created" as const,
		session: {
			sessionId: request.sessionId,
			workspaceId: request.workspaceId,
			sessionClass: "managed" as const,
			lifecycle: "ready" as const,
			manifestLifecycle: "ready" as const,
			health: "current_healthy" as const,
			inputAllowed: true,
			terminalEpoch: "epoch-shell",
			outputSeq: "0",
			capabilities: ["ansi_redraw_v1"],
			stopFence: {
				runnerPrincipal: "principal-shell",
				runnerInstance: "runner-shell",
				channelEpoch: "1",
				hostInstanceId: "host-shell",
				terminalEpoch: "epoch-shell",
			},
		},
	};
}

function setup(panelId: string) {
	const container = document.createElement("div");
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	disposals.push(() => {
		api.dispose();
		container.remove();
	});
	api.layout(1200, 800);
	const peer = api.addPanel({ id: "neighbor", component: "terminal" });
	const source = api.addPanel({
		id: panelId,
		component: "agent",
		params: { agentRef: { agentId: "uiux-dev" } },
		position: { referencePanel: peer.id, direction: "right" },
	});
	return { api, peer, source };
}

describe("replaceManagedAgentPaneWithShell", () => {
	it.each(["slot", "agent:uiux-dev", "launcher:previous"])(
		"keeps the replacement terminal in the same pane %s",
		async (panelId) => {
			let sessionId = "";
			vi.spyOn(hmux, "createManagedShell").mockImplementation(
				async (request) => {
					sessionId = request.sessionId;
					return receipt(request);
				},
			);

			const { api, source: agentPanel, peer } = setup(panelId);
			const sourceGroup = agentPanel.group;
			const removed = vi.fn();
			api.onDidRemovePanel(removed);

			const created = await replaceManagedAgentPaneWithShell({
				api,
				panelApi: agentPanel.api,
				cwd: "/repo",
			});

			const terminal = api.getPanel(panelId);
			expect(terminal).toBeDefined();
			expect(terminal!.api.component).toBe("terminal");
			expect(terminal!.params?.sessionId).toBe(sessionId);
			expect(created).toMatchObject({ panelId });
			expect(terminal?.group).toBe(sourceGroup);
			expect(api.getPanel(peer.id)).toBe(peer);
			expect(removed).not.toHaveBeenCalled();
			expect(api.groups).toHaveLength(2);
			expect(api.panels.map((panel) => panel.id).sort()).toEqual(
				["neighbor", panelId].sort(),
			);
		},
	);

	it.each(["replace", "close", "reopen"] as const)(
		"preserves newer user work when shell creation finishes after %s",
		async (change) => {
			const { api, source, peer } = setup("slot");
			let finish!: () => void;
			const create = vi.spyOn(hmux, "createManagedShell").mockImplementation(
				(request) =>
					new Promise((resolve) => {
						finish = () => resolve(receipt(request));
					}),
			);
			const stop = vi
				.spyOn(hmux, "stopManagedCreateChain")
				.mockResolvedValue({} as never);
			const pending = replaceManagedAgentPaneWithShell({
				api,
				panelApi: source.api,
				cwd: "/repo",
			});
			await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
			if (change === "replace")
				api.replacePanel(source.api, {
					component: "launcher",
					params: { cwd: "/new-work" },
				});
			else {
				api.removePanel(source);
				if (change === "reopen")
					api.addPanel({
						id: source.id,
						component: "launcher",
						params: { cwd: "/new-work" },
					});
			}
			const current = api.getPanel(source.id);
			const layout = api.toJSON();
			finish();
			await expect(pending).rejects.toMatchObject({ code: "pane_changed" });
			expect(api.getPanel(source.id)).toBe(current);
			expect(api.getPanel(peer.id)).toBe(peer);
			expect(api.toJSON()).toEqual(layout);
			const request = create.mock.calls[0]![0];
			expect(stop).toHaveBeenCalledExactlyOnceWith(
				request.idempotencyKey,
				request.sessionId,
				request.workspaceId,
			);
		},
	);
});
