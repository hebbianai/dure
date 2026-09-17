import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, isPermissionGranted, requestPluginPermission } = vi.hoisted(
	() => ({
		invoke: vi.fn(),
		isPermissionGranted: vi.fn(),
		requestPluginPermission: vi.fn(),
	}),
);

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-notification", () => ({
	isPermissionGranted,
	requestPermission: requestPluginPermission,
}));
vi.mock("@/lib/workspace/desktop/desktopPlatform", () => ({
	isMacPlatform: () => false,
}));

import {
	notificationBackendFailure,
	notificationClickQaArm,
	notificationClickQaAuthorize,
	notificationClickQaBegin,
	notificationClickQaComplete,
	notificationClickQaContext,
	notificationClickQaExit,
	notificationClickQaFail,
	notificationClickQaTargetIsReady,
	notificationClickQaTargetReady,
	notificationRequestAuthorization,
	notificationStatus,
} from "./notifications";

describe("notificationBackendFailure", () => {
	beforeEach(() => {
		invoke.mockReset();
		isPermissionGranted.mockReset();
		requestPluginPermission.mockReset();
	});

	it("preserves a typed receipt when the native IPC itself is unavailable", () => {
		expect(notificationBackendFailure(new Error("backend skew"))).toEqual({
			accepted: false,
			authorization: "unknown",
			sender: "unknown",
			bundleIdentifier: "io.hebbian.ade",
			presentation: "unknown",
			reason: "backend-error",
			detail: "Error: backend skew",
		});
	});

	it("uses the existing notification plugin for non-macOS permission status", async () => {
		invoke.mockResolvedValue({
			authorization: "unknown",
			sender: "dure-app",
			bundleIdentifier: "io.hebbian.ade",
		});
		isPermissionGranted.mockResolvedValue(true);

		await expect(notificationStatus()).resolves.toMatchObject({
			authorization: "authorized",
		});
	});

	it("maps a non-macOS permission request into the shared authorization model", async () => {
		invoke.mockResolvedValue({
			authorization: "unknown",
			sender: "dure-app",
			bundleIdentifier: "io.hebbian.ade",
		});
		requestPluginPermission.mockResolvedValue("denied");

		await expect(notificationRequestAuthorization()).resolves.toMatchObject({
			authorization: "denied",
		});
	});

	it("keeps every signed click QA command behind the typed IPC boundary", async () => {
		invoke.mockResolvedValue({ stage: "preparing" });
		const observation = {
			windowLabel: "win-notification-click-controller",
			activeSpaceId: "desktop-b",
			panelId: "agent:qa",
			panelActiveCount: 1,
			activationQueueEmpty: true,
			window: { visible: true, minimized: false, focused: true },
		};

		await notificationClickQaContext();
		await notificationClickQaTargetReady("a".repeat(32));
		await notificationClickQaTargetIsReady("a".repeat(32), "win-target");
		await notificationClickQaAuthorize("a".repeat(32));
		await notificationClickQaBegin("a".repeat(32), "cold-start");
		await notificationClickQaArm("a".repeat(32), "terminating", "agent:decoy");
		await notificationClickQaComplete("a".repeat(32), observation);
		await notificationClickQaFail("a".repeat(32), "failure");
		await notificationClickQaExit("a".repeat(32));

		expect(invoke.mock.calls).toEqual([
			["notification_click_qa_context"],
			["notification_click_qa_target_ready", { runId: "a".repeat(32) }],
			[
				"notification_click_qa_target_is_ready",
				{ runId: "a".repeat(32), windowLabel: "win-target" },
			],
			[
				"notification_click_qa_authorize",
				{ runId: "a".repeat(32), explicitUserOptIn: true },
			],
			[
				"notification_click_qa_begin",
				{ runId: "a".repeat(32), scenario: "cold-start" },
			],
			[
				"notification_click_qa_arm",
				{
					runId: "a".repeat(32),
					presentation: "terminating",
					activePanelId: "agent:decoy",
				},
			],
			[
				"notification_click_qa_complete",
				{ runId: "a".repeat(32), observation },
			],
			[
				"notification_click_qa_fail",
				{ runId: "a".repeat(32), reason: "failure" },
			],
			["notification_click_qa_exit", { runId: "a".repeat(32) }],
		]);
	});
});
