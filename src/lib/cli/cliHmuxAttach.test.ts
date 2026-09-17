import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { describe, expect, it, vi } from "vitest";
import {
	type CliHmuxAttachDependencies,
	handleCliHmuxAttach,
} from "@/lib/cli/cliHmuxAttach";
import { HmuxPaneAttachmentTimeoutError } from "@/lib/hmux/hmuxPaneAttachment";
import type { HmuxPaneAttachmentStatus } from "@/lib/ipc";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";

const attachment: HmuxPaneAttachmentStatus = {
	ownerId: "window:main:desktop:space-active:pane:term:standalone-target",
	sessionId: "standalone-target",
	workspaceId: "workspace-target",
	state: "attached",
	observerAttached: true,
	controllerAttached: false,
};

function harness(existing = false) {
	const panel = { id: "term:standalone-target" } as IDockviewPanel;
	const getPanel = vi.fn((_panelId: string): unknown =>
		existing ? panel : undefined,
	);
	const removePanel = vi.fn((_panel: unknown) => undefined);
	const api = { getPanel, removePanel } as unknown as DockviewApi;
	const claim = vi.fn(async () => true);
	const resolveSession = vi.fn(async () => ({
		sessionId: "standalone-target",
		workspaceId: "workspace-target",
	}));
	const retarget = vi.fn(
		async (
			request: Parameters<CliHmuxAttachDependencies["retarget"]>[0],
			authorize: () => Promise<boolean>,
		) => {
			if (!(await authorize())) throw new Error("request expired");
			return {
				desktopId: "space-inactive",
				panelId: request.panelId,
				sessionId: request.sessionId,
				workspaceId: request.workspaceId,
				cwd: request.cwd,
				binding: hmuxStandaloneBinding(request.sessionId, request.workspaceId),
			};
		},
	);
	const resolvePlacement = vi.fn(async () => undefined);
	const activeSpaceId = vi.fn(() => "space-active");
	const getDockview = vi.fn(() => api);
	const openAndCommit = vi.fn<CliHmuxAttachDependencies["openAndCommit"]>(() => ({
		panel,
		paneOwnership: existing ? "pre_existing" : "created_by_request",
	}));
	const preparePaneRemoval = vi.fn(() => () => {
		removePanel(panel);
		return true;
	});
	const waitForActivation = vi.fn(async () => attachment);
	const dependencies: CliHmuxAttachDependencies = {
		claim,
		resolveSession,
		retarget,
		resolvePlacement,
		activeSpaceId,
		getDockview,
		openAndCommit,
		preparePaneRemoval,
		waitForActivation,
	};
	return {
		dependencies,
		api,
		panel,
		getPanel,
		removePanel,
		claim,
		resolveSession,
		retarget,
		resolvePlacement,
		activeSpaceId,
		getDockview,
		openAndCommit,
		preparePaneRemoval,
		waitForActivation,
	};
}

describe("handleCliHmuxAttach", () => {
	it("accepts one inactive Space retarget commit without starting a native presentation path", async () => {
		const run = harness();

		const result = await handleCliHmuxAttach(
			{
				spaceId: "space-inactive",
				targetPanelId: " term:existing ",
				cwd: "/repo/inactive",
			},
			"request-retarget",
			run.dependencies,
		);

		expect(run.resolveSession).toHaveBeenCalledOnce();
		expect(run.claim).toHaveBeenCalledOnce();
		expect(run.claim).toHaveBeenCalledWith("request-retarget");
		expect(run.retarget).toHaveBeenCalledOnce();
		expect(run.retarget).toHaveBeenCalledWith(
			{
				panelId: "term:existing",
				sessionId: "standalone-target",
				workspaceId: "workspace-target",
				cwd: "/repo/inactive",
			},
			expect.any(Function),
		);
		expect(result).toMatchObject({
			ok: true,
			pane: {
				desktopId: "space-inactive",
				panelId: "term:existing",
				sessionId: "standalone-target",
				workspaceId: "workspace-target",
				cwd: "/repo/inactive",
				binding: hmuxStandaloneBinding("standalone-target", "workspace-target"),
			},
		});
		expect((result as { pane: object }).pane).not.toHaveProperty("attachment");
		expect(run.resolvePlacement).not.toHaveBeenCalled();
		expect(run.activeSpaceId).not.toHaveBeenCalled();
		expect(run.getDockview).not.toHaveBeenCalled();
		expect(run.getPanel).not.toHaveBeenCalled();
		expect(run.openAndCommit).not.toHaveBeenCalled();
		expect(run.waitForActivation).not.toHaveBeenCalled();
		expect(run.removePanel).not.toHaveBeenCalled();
	});

	it("does not retry a lost claim after an explicit retarget declines mutation", async () => {
		const run = harness();
		run.claim.mockResolvedValue(false);

		await expect(
			handleCliHmuxAttach(
				{
					spaceId: "space-inactive",
					targetPanelId: "term:existing",
				},
				"request-retarget-lost",
				run.dependencies,
			),
		).resolves.toBeNull();
		expect(run.resolveSession).toHaveBeenCalledOnce();
		expect(run.retarget).toHaveBeenCalledOnce();
		expect(run.claim).toHaveBeenCalledOnce();
		expect(run.resolvePlacement).not.toHaveBeenCalled();
		expect(run.openAndCommit).not.toHaveBeenCalled();
		expect(run.waitForActivation).not.toHaveBeenCalled();
		expect(run.removePanel).not.toHaveBeenCalled();
	});

	it("waits for the exact native attachment after opening a non-target pane", async () => {
		const run = harness();

		const result = await handleCliHmuxAttach(
			{ spaceId: "space-active", cwd: "/repo/active" },
			"request-open",
			run.dependencies,
		);

		expect(run.claim).toHaveBeenCalledOnce();
		expect(run.retarget).not.toHaveBeenCalled();
		expect(run.getDockview).toHaveBeenCalledWith("space-active");
		expect(run.openAndCommit).toHaveBeenCalledOnce();
		expect(run.openAndCommit).toHaveBeenCalledWith(
			"space-active",
			run.api,
			"standalone-target",
			"workspace-target",
			"/repo/active",
			undefined,
		);
		expect(run.waitForActivation).toHaveBeenCalledOnce();
		expect(run.waitForActivation).toHaveBeenCalledWith({
			desktopId: "space-active",
			panelId: "term:standalone-target",
			sessionId: "standalone-target",
			workspaceId: "workspace-target",
		});
		expect(result).toMatchObject({
			ok: true,
			pane: { attachment },
		});
		expect(run.removePanel).not.toHaveBeenCalled();
	});

	it("removes only a newly opened pane when native acknowledgement fails", async () => {
		const run = harness();
		run.waitForActivation.mockRejectedValue(new Error("native timeout"));

		await expect(
			handleCliHmuxAttach(
				{ spaceId: "space-active" },
				"request-timeout",
				run.dependencies,
			),
		).resolves.toEqual({
			ok: false,
			error: { code: "hmux_attach_failed", message: "native timeout" },
		});
		expect(run.claim).toHaveBeenCalledOnce();
		expect(run.removePanel).toHaveBeenCalledOnce();
		expect(run.removePanel).toHaveBeenCalledWith(run.panel);
	});

	it("preserves a pre-existing pane when native acknowledgement fails", async () => {
		const run = harness(true);
		const timeout = new HmuxPaneAttachmentTimeoutError({
			ownerId: attachment.ownerId,
			sessionId: attachment.sessionId,
			workspaceId: attachment.workspaceId,
		});
		run.waitForActivation.mockRejectedValue(timeout);

		await expect(
			handleCliHmuxAttach(
				{ spaceId: "space-active" },
				"request-existing",
				run.dependencies,
			),
		).resolves.toEqual({
			ok: false,
			error: {
				code: "hmux_pane_attachment_timeout",
				message: timeout.message,
			},
		});

		expect(run.claim).toHaveBeenCalledOnce();
		expect(run.retarget).not.toHaveBeenCalled();
		expect(run.openAndCommit).toHaveBeenCalledOnce();
		expect(run.waitForActivation).toHaveBeenCalledOnce();
		expect(run.removePanel).not.toHaveBeenCalled();
	});

	it("returns null without presentation when another WebView owns the request", async () => {
		const run = harness();
		run.claim.mockResolvedValue(false);

		await expect(
			handleCliHmuxAttach(
				{ spaceId: "space-active" },
				"request-lost",
				run.dependencies,
			),
		).resolves.toBeNull();
		expect(run.resolvePlacement).toHaveBeenCalledOnce();
		expect(run.activeSpaceId).not.toHaveBeenCalled();
		expect(run.getDockview).not.toHaveBeenCalled();
		expect(run.openAndCommit).not.toHaveBeenCalled();
		expect(run.waitForActivation).not.toHaveBeenCalled();
		expect(run.removePanel).not.toHaveBeenCalled();
	});
});
