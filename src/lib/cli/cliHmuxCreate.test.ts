import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CliHmuxCreateDependencies,
	handleCliHmuxCreate,
} from "@/lib/cli/cliHmuxCreate";
import { resolveCliSpaceId } from "@/lib/cli/cliSpaceIdentity";
import { routeCliRequestToSpaceOwner } from "@/lib/cli/cliSpaceOwnerRouting";
import { HmuxPaneAttachmentTimeoutError } from "@/lib/hmux/hmuxPaneAttachment";
import { RemoteHmuxOpenError } from "@/lib/hmux/remote/remoteHmuxTerminalSession";
import type { HmuxPaneAttachmentStatus } from "@/lib/ipc";
import { remoteHmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";

const created = {
	sessionId: "standalone-created",
	workspaceId: "workspace-created",
};

const attachment: HmuxPaneAttachmentStatus = {
	ownerId: "window:main:desktop:space-placement:pane:term:standalone-created",
	sessionId: created.sessionId,
	workspaceId: created.workspaceId,
	state: "attached",
	observerAttached: true,
	controllerAttached: false,
};

const terminalDefaultColors = {
	foregroundRgb: 0xffffff,
	backgroundRgb: 0x000000,
};

function harness() {
	const events: string[] = [];
	const api = {} as DockviewApi;
	const placementApi = {} as DockviewApi;
	const panel = { id: "term:standalone-created" } as IDockviewPanel;
	const claim = vi.fn(async () => {
		events.push("claim");
		return true;
	});
	const routeToSpaceOwner = vi.fn<
		CliHmuxCreateDependencies["routeToSpaceOwner"]
	>(async ({ params }) => {
		const spaceId = resolveCliSpaceId(params);
		return { kind: "local", ...(spaceId ? { spaceId } : {}) };
	});
	const resolvePlacement = vi.fn<CliHmuxCreateDependencies["resolvePlacement"]>(
		async () => undefined,
	);
	const activeSpaceId = vi.fn(() => "space-active");
	const spaceExists = vi.fn(() => true);
	const getDockview = vi.fn<CliHmuxCreateDependencies["getDockview"]>(
		() => api,
	);
	const homeDir = vi.fn(async () => "/home/test");
	const readTerminalDefaultColors = vi.fn(() => terminalDefaultColors);
	const createStandalone = vi.fn(async () => {
		events.push("create");
		return created;
	});
	const openAndCommit = vi.fn<CliHmuxCreateDependencies["openAndCommit"]>(() => {
		events.push("open");
		return { panel, paneOwnership: "created_by_request" };
	});
	const waitForActivation = vi.fn(async () => {
		events.push("wait");
		return attachment;
	});
	const removePane = vi.fn(() => {
		events.push("remove");
		return true;
	});
	const preparePaneRemoval = vi.fn(() => removePane);
	const abandonUnpresentedCreation = vi.fn(async () => {
		events.push("abandon");
		return undefined;
	});
	const dependencies: CliHmuxCreateDependencies = {
		claim,
		routeToSpaceOwner,
		spaceExists,
		resolvePlacement,
		activeSpaceId,
		getDockview,
		homeDir,
		terminalDefaultColors: readTerminalDefaultColors,
		createStandalone,
		openAndCommit,
		openRemote: vi.fn(),
		waitForActivation,
		preparePaneRemoval,
		abandonUnpresentedCreation,
	};
	return {
		dependencies,
		events,
		api,
		placementApi,
		panel,
		claim,
		routeToSpaceOwner,
		spaceExists,
		resolvePlacement,
		activeSpaceId,
		getDockview,
		homeDir,
		readTerminalDefaultColors,
		createStandalone,
		openAndCommit,
		waitForActivation,
		removePane,
		preparePaneRemoval,
		abandonUnpresentedCreation,
	};
}

function arrangePlacement(
	run: ReturnType<typeof harness>,
	direction: "right" | "below" = "right",
) {
	const placement = {
		desktopId: "space-placement",
		api: run.placementApi,
		panelId: "term:reference",
		cwd: "/repo/reference",
		direction,
		position: { referencePanel: "term:reference", direction },
	};
	run.resolvePlacement.mockResolvedValue(placement);
	return placement;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("handleCliHmuxCreate", () => {
	it("uses the GUI remote creation owner without starting a local session", async () => {
		const run = harness();
		const remote = {
			...created,
			panelId: `term:${created.sessionId}`,
			cwd: "/srv/plain",
			binding: remoteHmuxStandaloneBinding(
				created.sessionId,
				created.workspaceId,
				"ssh-1",
				"bridge-1",
			),
			readiness: { pane: "mounted" as const, session: "ready" as const },
		};
		const openRemote = vi.fn(async () => remote);
		const dependencies = { ...run.dependencies, openRemote };
		const result = await handleCliHmuxCreate(
			{ hostId: "ssh-1", cwd: "/srv/plain" },
			"remote-create",
			dependencies,
		);
		expect(result).toMatchObject({
			ok: true,
			pane: {
				...remote,
				hostId: "ssh-1",
				source: "ssh",
				desktopId: "space-active",
			},
		});
		expect(openRemote).toHaveBeenCalledExactlyOnceWith({
			api: run.api,
			desktopId: "space-active",
			hostId: "ssh-1",
			cwd: "/srv/plain",
		});
		expect(run.createStandalone).not.toHaveBeenCalled();
		expect(run.homeDir).not.toHaveBeenCalled();
		expect(run.waitForActivation).not.toHaveBeenCalled();
		expect(run.abandonUnpresentedCreation).not.toHaveBeenCalled();
	});

	it("keeps missing remote hosts and native failures on the remote path", async () => {
		const run = harness();
		const error = new RemoteHmuxOpenError(
			"remote_hmux_host_not_registered",
			"SSH host missing is not registered",
		);
		const openRemote = vi.fn().mockRejectedValue(error);
		const result = await handleCliHmuxCreate(
			{ hostId: "missing" },
			"missing-host",
			{ ...run.dependencies, openRemote },
		);
		expect(result).toEqual({
			ok: false,
			error: { code: error.code, message: error.message },
		});
		expect(openRemote).toHaveBeenCalledExactlyOnceWith({
			api: run.api,
			desktopId: "space-active",
			hostId: "missing",
		});
		expect(run.homeDir).not.toHaveBeenCalled();
		expect(run.createStandalone).not.toHaveBeenCalled();
		expect(run.removePane).not.toHaveBeenCalled();
		expect(run.abandonUnpresentedCreation).not.toHaveBeenCalled();
	});

	it("leaves a routed request unclaimed for the mounted target window", async () => {
		const run = harness();
		run.getDockview.mockReturnValue(undefined);
		const routeToSpaceOwner = vi.fn(async () => ({
			kind: "forwarded" as const,
		}));
		const dependencies = {
			...run.dependencies,
			routeToSpaceOwner,
		};

		await expect(
			handleCliHmuxCreate(
				{ spaceId: "space-in-other-window" },
				"request-routed",
				dependencies,
			),
		).resolves.toBeNull();

		expect(routeToSpaceOwner).toHaveBeenCalledWith({
			reqId: "request-routed",
			params: { spaceId: "space-in-other-window" },
		});
		expect(run.claim).not.toHaveBeenCalled();
		expect(run.getDockview).not.toHaveBeenCalled();
		expect(run.createStandalone).not.toHaveBeenCalled();
	});

	it("creates once after the target window receives the routed request", async () => {
		const source = harness();
		let forwarded:
			| { reqId: string; action: string; params: Record<string, unknown> }
			| undefined;
		source.routeToSpaceOwner.mockImplementation((request) =>
			routeCliRequestToSpaceOwner(
				{ ...request, action: "hmux.create" },
				{
					currentWindowLabel: () => "main",
					activeSpaceId: () => "space-active",
					resolveOwner: async () => "win-100-2",
					forward: async (_windowLabel, routed) => {
						forwarded = routed;
					},
				},
			),
		);
		source.getDockview.mockReturnValue(undefined);
		const target = harness();
		const params = { spaceId: "space-in-other-window" };

		await expect(
			handleCliHmuxCreate(params, "request-handoff", source.dependencies),
		).resolves.toBeNull();
		if (!forwarded) throw new Error("request was not forwarded");
		await expect(
			handleCliHmuxCreate(
				forwarded.params,
				forwarded.reqId,
				target.dependencies,
			),
		).resolves.toMatchObject({
			ok: true,
			pane: {
				desktopId: "space-in-other-window",
				sessionId: created.sessionId,
				workspaceId: created.workspaceId,
			},
		});

		expect(source.claim).not.toHaveBeenCalled();
		expect(source.createStandalone).not.toHaveBeenCalled();
		expect(forwarded).toMatchObject({
			reqId: "request-handoff",
			action: "hmux.create",
			params: { ...params, windowLabel: "win-100-2" },
		});
		expect(target.claim).toHaveBeenCalledOnce();
		expect(target.createStandalone).toHaveBeenCalledOnce();
		expect(target.createStandalone).toHaveBeenCalledWith(
			expect.objectContaining({ operationId: "request-handoff" }),
		);
		expect(target.openAndCommit).toHaveBeenCalledOnce();
	});

	it("claims once after routing and before mutating state", async () => {
		const run = harness();
		run.claim.mockImplementation(async () => {
			run.events.push("claim");
			return false;
		});

		await expect(
			handleCliHmuxCreate(
				{ spaceId: "space-a", desktopId: "space-b" },
				"request-lost",
				run.dependencies,
			),
		).resolves.toBeNull();

		expect(run.events).toEqual(["claim"]);
		expect(run.claim).toHaveBeenCalledOnce();
		expect(run.claim).toHaveBeenCalledWith("request-lost");
		expect(run.activeSpaceId).not.toHaveBeenCalled();
		expect(run.getDockview).not.toHaveBeenCalled();
		expect(run.resolvePlacement).not.toHaveBeenCalled();
		expect(run.homeDir).not.toHaveBeenCalled();
		expect(run.createStandalone).not.toHaveBeenCalled();
		expect(run.openAndCommit).not.toHaveBeenCalled();
		expect(run.waitForActivation).not.toHaveBeenCalled();
		expect(run.removePane).not.toHaveBeenCalled();
		expect(run.abandonUnpresentedCreation).not.toHaveBeenCalled();
	});

	it("rejects a conflicting Space identity without starting creation", async () => {
		const run = harness();

		await expect(
			handleCliHmuxCreate(
				{ spaceId: "space-a", desktopId: "space-b" },
				"request-invalid-space",
				run.dependencies,
			),
		).resolves.toEqual({
			ok: false,
			error: {
				code: "invalid_request",
				message: "spaceId and desktopId must identify the same Space",
			},
		});
		expect(run.claim).toHaveBeenCalledOnce();
		expect(run.activeSpaceId).not.toHaveBeenCalled();
		expect(run.getDockview).not.toHaveBeenCalled();
		expect(run.resolvePlacement).not.toHaveBeenCalled();
		expect(run.createStandalone).not.toHaveBeenCalled();
		expect(run.removePane).not.toHaveBeenCalled();
		expect(run.abandonUnpresentedCreation).not.toHaveBeenCalled();
	});

	it("creates, commits, and acknowledges one exact placed pane", async () => {
		const run = harness();
		arrangePlacement(run);

		const result = await handleCliHmuxCreate(
			{
				spaceId: "space-requested",
				terminalEnv: { TERM: "xterm-256color", COLORTERM: null },
			},
			"request-create",
			run.dependencies,
		);

		expect(run.claim).toHaveBeenCalledOnce();
		expect(run.getDockview).toHaveBeenCalledWith("space-requested");
		expect(run.homeDir).not.toHaveBeenCalled();
		expect(run.createStandalone).toHaveBeenCalledOnce();
		expect(run.createStandalone).toHaveBeenCalledWith({
			operationId: "request-create",
			cwd: "/repo/reference",
			columns: 120,
			rows: 30,
			terminalEnv: { TERM: "xterm-256color", COLORTERM: null },
			terminalDefaultColors,
		});
		expect(run.openAndCommit).toHaveBeenCalledWith(
			"space-placement",
			run.placementApi,
			created.sessionId,
			created.workspaceId,
			"/repo/reference",
			{
				referencePanel: "term:reference",
				direction: "right",
			},
		);
		expect(run.waitForActivation).toHaveBeenCalledWith({
			desktopId: "space-placement",
			panelId: "term:standalone-created",
			sessionId: created.sessionId,
			workspaceId: created.workspaceId,
		});
		expect(result).toMatchObject({
			ok: true,
			pane: {
				desktopId: "space-placement",
				panelId: "term:standalone-created",
				sessionId: created.sessionId,
				workspaceId: created.workspaceId,
				cwd: "/repo/reference",
				sessionOwnership: "created_by_request",
				paneOwnership: "created_by_request",
				referencePanelId: "term:reference",
				direction: "right",
				attachment,
			},
		});
		expect(run.events).toEqual(["claim", "create", "open", "wait"]);
		expect(run.removePane).not.toHaveBeenCalled();
		expect(run.abandonUnpresentedCreation).not.toHaveBeenCalled();
	});

	it("prefers an explicit cwd over placement and home defaults", async () => {
		const run = harness();
		arrangePlacement(run, "below");

		await handleCliHmuxCreate(
			{ spaceId: "space-requested", cwd: "/repo/explicit" },
			"request-explicit-cwd",
			run.dependencies,
		);

		expect(run.createStandalone).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/repo/explicit" }),
		);
		expect(run.openAndCommit).toHaveBeenCalledWith(
			"space-placement",
			run.placementApi,
			created.sessionId,
			created.workspaceId,
			"/repo/explicit",
			expect.any(Object),
		);
		expect(run.homeDir).not.toHaveBeenCalled();
	});

	it("uses home for creation, presentation, and the receipt when no cwd exists", async () => {
		const run = harness();

		const result = await handleCliHmuxCreate(
			{ spaceId: "space-active" },
			"request-home-cwd",
			run.dependencies,
		);

		expect(run.homeDir).toHaveBeenCalledOnce();
		expect(run.createStandalone).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/home/test" }),
		);
		expect(run.openAndCommit).toHaveBeenCalledWith(
			"space-active",
			run.api,
			created.sessionId,
			created.workspaceId,
			"/home/test",
			undefined,
		);
		expect(result).toMatchObject({
			ok: true,
			pane: { cwd: "/home/test" },
		});
	});

	it("does not create or compensate when placement resolution fails", async () => {
		const run = harness();
		run.resolvePlacement.mockRejectedValue(
			new PaneCommandError("invalid_request", "placement is invalid"),
		);

		await expect(
			handleCliHmuxCreate(
				{ spaceId: "space-active", placement: {} },
				"request-placement-failed",
				run.dependencies,
			),
		).resolves.toEqual({
			ok: false,
			error: { code: "invalid_request", message: "placement is invalid" },
		});
		expect(run.createStandalone).not.toHaveBeenCalled();
		expect(run.openAndCommit).not.toHaveBeenCalled();
		expect(run.removePane).not.toHaveBeenCalled();
		expect(run.abandonUnpresentedCreation).not.toHaveBeenCalled();
	});

	it("fails before placement or session creation when the requested Space is not mounted", async () => {
		const run = harness();
		run.getDockview.mockReturnValue(undefined);

		await expect(
			handleCliHmuxCreate(
				{ spaceId: "space-missing" },
				"request-missing",
				run.dependencies,
			),
		).resolves.toEqual({
			ok: false,
			error: {
				code: "pane_not_found",
				message: "desktop space-missing is not mounted",
			},
		});
		expect(run.resolvePlacement).not.toHaveBeenCalled();
		expect(run.createStandalone).not.toHaveBeenCalled();
		expect(run.removePane).not.toHaveBeenCalled();
		expect(run.abandonUnpresentedCreation).not.toHaveBeenCalled();
	});

	it("does not create through a Dockview retained after its Space was deleted", async () => {
		const run = harness();
		const spaceExists = vi.fn(() => false);
		const dependencies = { ...run.dependencies, spaceExists };

		await expect(
			handleCliHmuxCreate(
				{ spaceId: "space-deleted" },
				"request-deleted",
				dependencies,
			),
		).resolves.toEqual({
			ok: false,
			error: {
				code: "pane_not_found",
				message: "desktop space-deleted is not mounted",
			},
		});
		expect(spaceExists).toHaveBeenCalledWith("space-deleted");
		expect(run.resolvePlacement).not.toHaveBeenCalled();
		expect(run.createStandalone).not.toHaveBeenCalled();
	});

	it("does not compensate a session lifetime that creation never returned", async () => {
		const run = harness();
		run.createStandalone.mockImplementation(async () => {
			run.events.push("create");
			throw new Error("host unavailable");
		});

		await expect(
			handleCliHmuxCreate(
				{ spaceId: "space-active", cwd: "/repo/explicit" },
				"request-create-failed",
				run.dependencies,
			),
		).resolves.toEqual({
			ok: false,
			error: { code: "hmux_create_failed", message: "host unavailable" },
		});
		expect(run.openAndCommit).not.toHaveBeenCalled();
		expect(run.waitForActivation).not.toHaveBeenCalled();
		expect(run.removePane).not.toHaveBeenCalled();
		expect(run.abandonUnpresentedCreation).not.toHaveBeenCalled();
	});

	it("abandons without closing when the durable pane commit fails", async () => {
		const run = harness();
		run.openAndCommit.mockImplementation(() => {
			run.events.push("open");
			throw new PaneCommandError("pane_changed", "layout commit failed");
		});

		await expect(
			handleCliHmuxCreate(
				{ spaceId: "space-active", cwd: "/repo/explicit" },
				"request-commit-failed",
				run.dependencies,
			),
		).resolves.toEqual({
			ok: false,
			error: { code: "pane_changed", message: "layout commit failed" },
		});
		expect(run.events).toEqual(["claim", "create", "open", "abandon"]);
		expect(run.waitForActivation).not.toHaveBeenCalled();
		expect(run.removePane).not.toHaveBeenCalled();
		expect(run.abandonUnpresentedCreation).toHaveBeenCalledOnce();
		expect(run.abandonUnpresentedCreation).toHaveBeenCalledWith(
			created.sessionId,
			created.workspaceId,
		);
	});

	it("removes the owned view before abandoning when attachment acknowledgement fails", async () => {
		const run = harness();
		arrangePlacement(run);
		const timeout = new HmuxPaneAttachmentTimeoutError({
			ownerId: attachment.ownerId,
			sessionId: created.sessionId,
			workspaceId: created.workspaceId,
		});
		run.waitForActivation.mockImplementation(async () => {
			run.events.push("wait");
			throw timeout;
		});

		await expect(
			handleCliHmuxCreate(
				{ spaceId: "space-active", cwd: "/repo/explicit" },
				"request-ack-failed",
				run.dependencies,
			),
		).resolves.toEqual({
			ok: false,
			error: {
				code: "hmux_pane_attachment_timeout",
				message: timeout.message,
			},
		});
		expect(run.events).toEqual([
			"claim",
			"create",
			"open",
			"wait",
			"remove",
			"abandon",
		]);
		expect(run.removePane).toHaveBeenCalledOnce();
		expect(run.preparePaneRemoval).toHaveBeenCalledWith(
			"space-placement",
			run.placementApi,
			run.panel,
		);
		expect(run.abandonUnpresentedCreation).toHaveBeenCalledOnce();
	});

	it("preserves the presentation error when both cleanup attempts fail", async () => {
		const run = harness();
		const timeout = new HmuxPaneAttachmentTimeoutError({
			ownerId: attachment.ownerId,
			sessionId: created.sessionId,
			workspaceId: created.workspaceId,
		});
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		run.waitForActivation.mockImplementation(async () => {
			run.events.push("wait");
			throw timeout;
		});
		run.removePane.mockImplementation(() => {
			run.events.push("remove");
			throw new Error("close failed");
		});
		run.abandonUnpresentedCreation.mockImplementation(async () => {
			run.events.push("abandon");
			throw new Error("abandon failed");
		});

		await expect(
			handleCliHmuxCreate(
				{ spaceId: "space-active", cwd: "/repo/explicit" },
				"request-cleanup-failed",
				run.dependencies,
			),
		).resolves.toEqual({
			ok: false,
			error: {
				code: "hmux_pane_attachment_timeout",
				message: timeout.message,
			},
		});
		expect(run.events.slice(-2)).toEqual(["remove", "abandon"]);
		expect(run.removePane).toHaveBeenCalledOnce();
		expect(run.abandonUnpresentedCreation).toHaveBeenCalledOnce();
	});
});
