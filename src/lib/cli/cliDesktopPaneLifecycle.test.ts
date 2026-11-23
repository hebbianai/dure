import { describe, expect, it, vi } from "vitest";
import {
	type CliDesktopPaneDependencies,
	dispatchCliDesktopPaneRequest,
} from "@/lib/cli/cliDesktopPaneLifecycle";

function dependencies(
	overrides: Partial<CliDesktopPaneDependencies> = {},
): CliDesktopPaneDependencies {
	return {
		routeToSpaceOwner: vi.fn(async () => ({ kind: "local" as const })),
		claim: vi.fn(async () => true),
		complete: vi.fn(async () => undefined),
		closePanel: vi.fn(async () => null),
		movePanel: vi.fn(async (panelId, fromSpaceId, spaceId) => ({
			panelId,
			fromSpaceId,
			spaceId,
			moved: true,
		})),
		openMobile: vi.fn(async () => ({ panelId: "mobile-pane", reused: true })),
		openFile: vi.fn(async (_spaceId, path) => ({
			panelId: "file-pane",
			file: { source: "local", path },
			mounted: true,
		})),
		ownsFilePresentation: vi.fn(() => true),
		presentFile: vi.fn(async (path, presenterSessionId) => ({
			label: "win-presentation",
			file: { source: "local", path },
			reused: false,
			...(presenterSessionId
				? { presenter: { agentId: "agent-1", name: "Reviewer" } }
				: {}),
		})),
		addSpace: vi.fn(() => "desktop-new"),
		waitForSpace: vi.fn(async () => ({})),
		removeSpace: vi.fn(),
		spaceName: vi.fn(() => "Build"),
		...overrides,
	};
}

describe("dispatchCliDesktopPaneRequest", () => {
	it("routes local file opening before claiming and calls only the file owner", async () => {
		const request = {
			reqId: "file",
			action: "pane.open",
			params: { tool: "file", path: "/reports/a b.md", spaceId: "review" },
		};
		const forwarded = dependencies({
			routeToSpaceOwner: vi.fn(async () => ({ kind: "forwarded" as const })),
		});
		await dispatchCliDesktopPaneRequest(request, forwarded);
		expect(forwarded.claim).not.toHaveBeenCalled();
		expect(forwarded.openFile).not.toHaveBeenCalled();
		const owner = dependencies();
		await dispatchCliDesktopPaneRequest(request, owner);
		expect(owner.openFile).toHaveBeenCalledWith("review", "/reports/a b.md");
		expect(owner.openMobile).not.toHaveBeenCalled();
		expect(owner.complete).toHaveBeenCalledWith(
			"file",
			expect.objectContaining({
				ok: true,
				pane: expect.objectContaining({
					spaceId: "review",
					panelId: "file-pane",
					mounted: true,
				}),
			}),
			"pane.open",
		);
	});

	it.each([
		{ path: "relative.md" },
		{ path: "file:///reports/a.html" },
		{ path: "https://example.com/a.md" },
		{ source: "ssh" },
		{ hostId: "remote" },
		{ sessionId: "remote-session" },
		{ path: "" },
	])(
		"refuses non-local file coordinates before routing: %j",
		async (invalid) => {
			const deps = dependencies();
			await dispatchCliDesktopPaneRequest(
				{
					reqId: "invalid-file",
					action: "pane.open",
					params: {
						tool: "file",
						spaceId: "review",
						path: "/reports/a.md",
						...invalid,
					},
				},
				deps,
			);
			expect(deps.routeToSpaceOwner).not.toHaveBeenCalled();
			expect(deps.openFile).not.toHaveBeenCalled();
			expect(deps.complete).toHaveBeenCalledWith(
				"invalid-file",
				expect.objectContaining({
					ok: false,
					error: expect.objectContaining({ code: "invalid_request" }),
				}),
				"pane.open",
			);
		},
	);

	it("presents a window file from the owning window without routing to a Space", async () => {
		const request = {
			reqId: "present",
			action: "pane.open",
			params: {
				tool: "file",
				placement: "window",
				path: "/recordings/demo run.mp4",
				presenterSessionId: "session-1",
			},
		};
		const other = dependencies({ ownsFilePresentation: vi.fn(() => false) });
		await dispatchCliDesktopPaneRequest(request, other);
		expect(other.claim).not.toHaveBeenCalled();
		expect(other.presentFile).not.toHaveBeenCalled();
		expect(other.complete).not.toHaveBeenCalled();

		const owner = dependencies();
		await dispatchCliDesktopPaneRequest(request, owner);
		expect(owner.routeToSpaceOwner).not.toHaveBeenCalled();
		expect(owner.openFile).not.toHaveBeenCalled();
		expect(owner.presentFile).toHaveBeenCalledWith(
			"/recordings/demo run.mp4",
			"session-1",
		);
		expect(owner.complete).toHaveBeenCalledWith(
			"present",
			{
				ok: true,
				window: {
					label: "win-presentation",
					file: { source: "local", path: "/recordings/demo run.mp4" },
					reused: false,
					presenter: { agentId: "agent-1", name: "Reviewer" },
				},
			},
			"pane.open",
		);
	});

	it("does not present when another window claimed the request first", async () => {
		const deps = dependencies({ claim: vi.fn(async () => false) });
		await dispatchCliDesktopPaneRequest(
			{
				reqId: "present",
				action: "pane.open",
				params: { tool: "file", placement: "window", path: "/a.png" },
			},
			deps,
		);
		expect(deps.presentFile).not.toHaveBeenCalled();
		expect(deps.complete).not.toHaveBeenCalled();
	});

	it.each([
		{ tool: "mobile" },
		{ spaceId: "review" },
		{ desktopId: "review" },
		{ path: "relative.png" },
		{ path: "https://example.com/a.png" },
		{ source: "ssh" },
		{ hostId: "remote" },
		{ sessionId: "remote-session" },
		{ presenterSessionId: "" },
		{ presenterSessionId: "bad\nid" },
		{ presenterSessionId: 7 },
	])("refuses an invalid window presentation before presenting: %j", async (invalid) => {
		const deps = dependencies();
		await dispatchCliDesktopPaneRequest(
			{
				reqId: "invalid-present",
				action: "pane.open",
				params: { tool: "file", placement: "window", path: "/a.png", ...invalid },
			},
			deps,
		);
		expect(deps.presentFile).not.toHaveBeenCalled();
		expect(deps.openFile).not.toHaveBeenCalled();
		expect(deps.complete).toHaveBeenCalledWith(
			"invalid-present",
			{
				ok: false,
				error: expect.objectContaining({ code: "invalid_request" }),
			},
			"pane.open",
		);
	});

	it("refuses an unknown placement and reports a presentation failure", async () => {
		const unknown = dependencies();
		await dispatchCliDesktopPaneRequest(
			{
				reqId: "tab",
				action: "pane.open",
				params: { tool: "file", placement: "tab", path: "/a.md", spaceId: "review" },
			},
			unknown,
		);
		expect(unknown.openFile).not.toHaveBeenCalled();
		expect(unknown.complete).toHaveBeenCalledWith(
			"tab",
			{ ok: false, error: expect.objectContaining({ code: "invalid_request" }) },
			"pane.open",
		);
		const failed = dependencies({
			presentFile: vi.fn(async () => {
				throw new Error("window creation failed");
			}),
		});
		await dispatchCliDesktopPaneRequest(
			{
				reqId: "present",
				action: "pane.open",
				params: { tool: "file", placement: "window", path: "/a.md" },
			},
			failed,
		);
		expect(failed.complete).toHaveBeenCalledWith(
			"present",
			{
				ok: false,
				error: {
					code: "file_presentation_failed",
					message: "window creation failed",
				},
			},
			"pane.open",
		);
	});

	it("does not open an unclaimed file and returns the opener's failure", async () => {
		const request = {
			reqId: "file",
			action: "pane.open",
			params: { tool: "file", path: "/reports/a.md", spaceId: "review" },
		};
		const unclaimed = dependencies({ claim: vi.fn(async () => false) });
		await dispatchCliDesktopPaneRequest(request, unclaimed);
		expect(unclaimed.openFile).not.toHaveBeenCalled();
		expect(unclaimed.complete).not.toHaveBeenCalled();
		const failed = dependencies({
			openFile: vi.fn(async () => {
				throw Object.assign(new Error("Space absent"), {
					code: "space_not_found",
				});
			}),
		});
		await dispatchCliDesktopPaneRequest(request, failed);
		expect(failed.complete).toHaveBeenCalledWith(
			"file",
			{
				ok: false,
				error: { code: "space_not_found", message: "Space absent" },
			},
			"pane.open",
		);
	});

	it("preserves the selected Space for explicit background creation", async () => {
		let selected = "working";
		const deps = dependencies({
			addSpace: (_name, select) => {
				if (select !== false) selected = "desktop-new";
				return "desktop-new";
			},
		});
		await dispatchCliDesktopPaneRequest(
			{
				reqId: "background",
				action: "space.create",
				params: { select: false },
			},
			deps,
		);
		expect(selected).toBe("working");
		expect(deps.waitForSpace).not.toHaveBeenCalled();
	});
	it("routes moves before claiming and passes exact source and destination identities", async () => {
		const request = {
			reqId: "move",
			action: "pane.move",
			params: {
				targetPanelId: " pane ",
				fromSpaceId: " source ",
				spaceId: " target ",
			},
		};
		const forwarded = dependencies({
			routeToSpaceOwner: vi.fn(async () => ({ kind: "forwarded" as const })),
		});
		await dispatchCliDesktopPaneRequest(request, forwarded);
		expect(forwarded.claim).not.toHaveBeenCalled();
		expect(forwarded.movePanel).not.toHaveBeenCalled();
		const owner = dependencies();
		await dispatchCliDesktopPaneRequest(request, owner);
		expect(owner.movePanel).toHaveBeenCalledWith("pane", "source", "target");
		expect(owner.complete).toHaveBeenCalledWith(
			"move",
			{
				ok: true,
				pane: {
					panelId: "pane",
					fromSpaceId: "source",
					spaceId: "target",
					desktopId: "target",
					moved: true,
				},
			},
			"pane.move",
		);
	});
	it.each([
		{},
		{ targetPanelId: "pane", spaceId: "target" },
		{ targetPanelId: "pane", fromSpaceId: "source" },
	])(
		"refuses incomplete move identities before mutation: %o",
		async (params) => {
			const deps = dependencies();
			await dispatchCliDesktopPaneRequest(
				{ reqId: "invalid", action: "pane.move", params },
				deps,
			);
			expect(deps.movePanel).not.toHaveBeenCalled();
			expect(deps.complete).toHaveBeenCalledWith(
				"invalid",
				expect.objectContaining({ ok: false }),
				"pane.move",
			);
		},
	);
	it("leaves a routed close unclaimed instead of closing a persisted projection", async () => {
		const deps = dependencies({
			routeToSpaceOwner: vi.fn(async () => ({ kind: "forwarded" as const })),
		});
		const request = {
			reqId: "close-secondary",
			action: "pane.close",
			params: { targetPanelId: "term:a", spaceId: "desktop-a" },
		};
		expect(await dispatchCliDesktopPaneRequest(request, deps)).toBe(true);
		expect(deps.routeToSpaceOwner).toHaveBeenCalledExactlyOnceWith(request);
		expect(deps.claim).not.toHaveBeenCalled();
		expect(deps.closePanel).not.toHaveBeenCalled();
		expect(deps.complete).not.toHaveBeenCalled();
	});

	it("ignores actions outside its lifecycle subset", async () => {
		const deps = dependencies();

		expect(
			await dispatchCliDesktopPaneRequest(
				{ reqId: "request-1", action: "hmux.attach", params: {} },
				deps,
			),
		).toBe(false);
		expect(deps.claim).not.toHaveBeenCalled();
	});

	it("closes the exact pane in its canonical Space and projects the legacy alias", async () => {
		const closePanel = vi.fn(async () => ({
			desktopId: "desktop-a",
			mode: "live",
		}));
		const deps = dependencies({ closePanel });

		expect(
			await dispatchCliDesktopPaneRequest(
				{
					reqId: "request-close",
					action: "pane.close",
					params: { targetPanelId: " term:a ", spaceId: " desktop-a " },
				},
				deps,
			),
		).toBe(true);
		expect(closePanel).toHaveBeenCalledWith("term:a", "desktop-a");
		expect(deps.complete).toHaveBeenCalledWith(
			"request-close",
			{
				ok: true,
				closed: {
					panelId: "term:a",
					spaceId: "desktop-a",
					desktopId: "desktop-a",
					mode: "live",
				},
			},
			"pane.close",
		);
	});

	it("rejects conflicting canonical and legacy Space identities before mutation", async () => {
		const closePanel = vi.fn(async () => null);
		const deps = dependencies({ closePanel });

		await dispatchCliDesktopPaneRequest(
			{
				reqId: "request-conflict",
				action: "pane.close",
				params: {
					targetPanelId: "term:a",
					spaceId: "space-a",
					desktopId: "space-b",
				},
			},
			deps,
		);

		expect(closePanel).not.toHaveBeenCalled();
		expect(deps.complete).toHaveBeenCalledWith(
			"request-conflict",
			{
				ok: false,
				error: {
					code: "invalid_request",
					message: "spaceId and desktopId must identify the same Space",
				},
			},
			"pane.close",
		);
	});

	it("creates a Space through the canonical action with compatible receipt keys", async () => {
		const deps = dependencies();

		expect(
			await dispatchCliDesktopPaneRequest(
				{
					reqId: "request-create-space",
					action: "space.create",
					params: { name: " Build " },
				},
				deps,
			),
		).toBe(true);
		expect(deps.complete).toHaveBeenCalledWith(
			"request-create-space",
			{
				ok: true,
				space: {
					spaceId: "desktop-new",
					desktopId: "desktop-new",
					name: "Build",
					mounted: true,
				},
				desktop: {
					spaceId: "desktop-new",
					desktopId: "desktop-new",
					name: "Build",
					mounted: true,
				},
			},
			"space.create",
		);
	});

	it("rolls back an unmounted desktop and reports the exact timeout", async () => {
		const deps = dependencies({
			waitForSpace: vi.fn(async () => undefined),
		});

		await dispatchCliDesktopPaneRequest(
			{
				reqId: "request-create",
				action: "desktop.create",
				params: { name: " Build " },
			},
			deps,
		);

		expect(deps.addSpace).toHaveBeenCalledWith("Build", true);
		expect(deps.removeSpace).toHaveBeenCalledWith("desktop-new");
		expect(deps.complete).toHaveBeenCalledWith(
			"request-create",
			{
				ok: false,
				error: {
					code: "desktop_mount_timeout",
					message: "desktop desktop-new did not publish its Dockview",
				},
			},
			"desktop.create",
		);
	});
});

it("routes a mobile open before claim and preserves exact Space authority", async () => {
	const request = {
		reqId: "open-mobile",
		action: "pane.open",
		params: { spaceId: "space", tool: "mobile" },
	};
	const forwarded = dependencies({
		routeToSpaceOwner: vi.fn(async () => ({ kind: "forwarded" as const })),
	});
	await dispatchCliDesktopPaneRequest(request, forwarded);
	expect(forwarded.claim).not.toHaveBeenCalled();
	expect(forwarded.openMobile).not.toHaveBeenCalled();
	const owner = dependencies();
	await dispatchCliDesktopPaneRequest(request, owner);
	expect(owner.openMobile).toHaveBeenCalledExactlyOnceWith("space");
	expect(owner.complete).toHaveBeenCalledWith(
		"open-mobile",
		{
			ok: true,
			pane: {
				panelId: "mobile-pane",
				reused: true,
				spaceId: "space",
				desktopId: "space",
			},
		},
		"pane.open",
	);
});
it("refuses unscoped or unknown tool opens without creating any pane", async () => {
	for (const params of [
		{ tool: "mobile" },
		{ spaceId: "space", tool: "shell" },
	]) {
		const deps = dependencies();
		await dispatchCliDesktopPaneRequest(
			{ reqId: "invalid", action: "pane.open", params },
			deps,
		);
		expect(deps.openMobile).not.toHaveBeenCalled();
		expect(deps.complete).toHaveBeenCalledWith(
			"invalid",
			expect.objectContaining({ ok: false }),
			"pane.open",
		);
	}
});
