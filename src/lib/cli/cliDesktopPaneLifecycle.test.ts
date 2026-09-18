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
		openMobile: vi.fn(async () => ({ panelId: "mobile-pane", reused: true })),
		addSpace: vi.fn(() => "desktop-new"),
		waitForSpace: vi.fn(async () => ({})),
		removeSpace: vi.fn(),
		spaceName: vi.fn(() => "Build"),
		...overrides,
	};
}

describe("dispatchCliDesktopPaneRequest", () => {
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

		expect(deps.addSpace).toHaveBeenCalledWith("Build");
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
