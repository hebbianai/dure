import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import type { DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	show,
	unminimize,
	setFocus,
	navigateToPanel,
	notificationActivationTake,
	listenWhenReady,
	unlisten,
} = vi.hoisted(() => ({
	show: vi.fn(),
	unminimize: vi.fn(),
	setFocus: vi.fn(),
	navigateToPanel: vi.fn(),
	notificationActivationTake: vi.fn(),
	listenWhenReady: vi.fn(),
	unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ label: "main", show, unminimize, setFocus }),
}));
vi.mock("@/lib/workspace/dock/panelFocusHandoff", () => ({ navigateToPanel }));
vi.mock("@/lib/ipc/notifications", () => ({
	NOTIFICATION_ACTIVATION_AVAILABLE_EVENT: "notification:activation-available",
	notificationActivationTake,
}));
vi.mock("@/lib/platform/tauriBridge", () => ({ listenWhenReady }));

import {
	focusNotificationActivation,
	installNotificationActivationHandler,
} from "@/lib/settings/notificationActivation";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";

const windowPermissions = new Set(
	(
		JSON.parse(
			readFileSync(
				fileURLToPath(
					new URL(
						"../../../src-tauri/capabilities/default.json",
						import.meta.url,
					),
				),
				"utf8",
			),
		) as { permissions?: (string | { identifier: string })[] }
	).permissions?.map((permission) =>
		typeof permission === "string" ? permission : permission.identifier,
	) ?? [],
);

function dockview(panelId: string) {
	return {
		getPanel: (candidate: string) =>
			candidate === panelId ? { id: candidate } : undefined,
	} as unknown as DockviewApi;
}

describe("focusNotificationActivation", () => {
	beforeEach(() => {
		show.mockReset().mockResolvedValue(undefined);
		unminimize.mockReset().mockResolvedValue(undefined);
		setFocus.mockReset().mockResolvedValue(undefined);
		navigateToPanel.mockReset();
		notificationActivationTake.mockReset();
		listenWhenReady.mockReset().mockResolvedValue(unlisten);
		unlisten.mockReset();
	});

	afterEach(() => {
		unregisterDockview("desktop-current", registeredApi);
	});

	const registeredApi = dockview("agent:codex");

	it("authorizes every window command used to restore a notification target", () => {
		expect([...windowPermissions]).toEqual(
			expect.arrayContaining([
				"core:window:allow-show",
				"core:window:allow-hide",
				"core:window:allow-minimize",
				"core:window:allow-unminimize",
				"core:window:allow-set-focus",
			]),
		);
	});

	it("activates the app and focuses the pane's current exact owner", async () => {
		registerDockview("desktop-current", registeredApi);
		useStore.setState({ activeSpaceId: "desktop-other", layouts: {} });

		await expect(
			focusNotificationActivation({
				activationId: "hmux:turn:9",
				paneTarget: {
					desktopId: "desktop-at-dispatch",
					panelId: "agent:codex",
				},
			}),
		).resolves.toBe(true);

		expect(show).toHaveBeenCalledTimes(1);
		expect(unminimize).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledTimes(1);
		expect(navigateToPanel).toHaveBeenCalledWith(
			"desktop-current",
			"agent:codex",
		);
	});

	it("does not guess when the pane no longer has an exact owner", async () => {
		useStore.setState({ activeSpaceId: "desktop-other", layouts: {} });

		await expect(
			focusNotificationActivation({
				activationId: "hmux:turn:10",
				paneTarget: {
					desktopId: "desktop-deleted",
					panelId: "agent:gone",
				},
			}),
		).resolves.toBe(false);

		expect(setFocus).not.toHaveBeenCalled();
		expect(navigateToPanel).not.toHaveBeenCalled();
	});

	it("does not consume a route owned by another native window", async () => {
		registerDockview("desktop-current", registeredApi);
		useStore.setState({ activeSpaceId: "desktop-current", layouts: {} });

		await expect(
			focusNotificationActivation({
				activationId: "hmux:turn:other-window",
				paneTarget: {
					windowLabel: "win-notification-click-target",
					desktopId: "desktop-current",
					panelId: "agent:codex",
				},
			}),
		).resolves.toBe(false);

		expect(show).not.toHaveBeenCalled();
		expect(navigateToPanel).not.toHaveBeenCalled();
	});

	it("installs the wake listener before draining a cold-start activation", async () => {
		registerDockview("desktop-current", registeredApi);
		useStore.setState({ activeSpaceId: "desktop-other", layouts: {} });
		notificationActivationTake
			.mockResolvedValueOnce({
				activationId: "hmux:turn:cold",
				paneTarget: {
					desktopId: "desktop-current",
					panelId: "agent:codex",
				},
			})
			.mockResolvedValueOnce(null);

		const dispose = installNotificationActivationHandler();

		await vi.waitFor(() => {
			expect(navigateToPanel).toHaveBeenCalledWith(
				"desktop-current",
				"agent:codex",
			);
		});
		expect(listenWhenReady.mock.invocationCallOrder[0]).toBeLessThan(
			notificationActivationTake.mock.invocationCallOrder[0],
		);

		dispose();
		expect(unlisten).toHaveBeenCalledTimes(1);
	});
});
