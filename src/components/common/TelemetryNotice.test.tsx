// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryNotice } from "@/components/common/TelemetryNotice";
import { t } from "@/lib/i18n";
import { telemetrySetChoice, telemetryState } from "@/lib/ipc/telemetry";
import { openSettingsPage } from "@/lib/settings/settingsBus";
import { DEFAULT_UI_PREFS, useStore } from "@/store";

vi.mock("@/lib/ipc/telemetry", () => ({
	telemetryState: vi.fn(),
	telemetrySetChoice: vi.fn(),
}));
vi.mock("@/lib/settings/settingsBus", () => ({ openSettingsPage: vi.fn() }));

const stateMock = vi.mocked(telemetryState);
const setChoiceMock = vi.mocked(telemetrySetChoice);

beforeEach(() => {
	stateMock.mockReset();
	setChoiceMock.mockReset();
	vi.mocked(openSettingsPage).mockClear();
	// Past the first-run guide, which otherwise has the corner.
	useStore.setState({
		uiPrefs: { ...DEFAULT_UI_PREFS, onboardingDismissed: true },
	});
});

afterEach(() => {
	cleanup();
	useStore.setState({ uiPrefs: { ...DEFAULT_UI_PREFS } });
});

describe("TelemetryNotice", () => {
	it("asks only while the install is pending, and goes away once answered", async () => {
		stateMock.mockResolvedValue({ effective: "pending", choice: null });
		setChoiceMock.mockResolvedValue({
			effective: "enabled",
			choice: "accepted",
		});
		render(<TelemetryNotice />);
		const accept = await screen.findByRole("button", {
			name: t("settings.privacy.notice.accept"),
		});
		expect(
			screen.getByRole("button", {
				name: t("settings.privacy.notice.decline"),
			}),
		).toBeTruthy();
		fireEvent.click(accept);
		expect(setChoiceMock).toHaveBeenCalledWith("accepted");
		await vi.waitFor(() => expect(screen.queryByRole("status")).toBeNull());
	});

	it("records Decline the same way", async () => {
		stateMock.mockResolvedValue({ effective: "pending", choice: null });
		setChoiceMock.mockResolvedValue({
			effective: "disabled",
			reason: "declined",
			choice: "declined",
		});
		render(<TelemetryNotice />);
		fireEvent.click(
			await screen.findByRole("button", {
				name: t("settings.privacy.notice.decline"),
			}),
		);
		expect(setChoiceMock).toHaveBeenCalledWith("declined");
		await vi.waitFor(() => expect(screen.queryByRole("status")).toBeNull());
	});

	it("opens the Privacy page for the full list", async () => {
		stateMock.mockResolvedValue({ effective: "pending", choice: null });
		render(<TelemetryNotice />);
		fireEvent.click(
			await screen.findByRole("button", {
				name: t("settings.privacy.usageData.whatIsSent"),
			}),
		);
		expect(openSettingsPage).toHaveBeenCalledWith("privacy");
	});

	it("renders nothing once decided, when the environment decided, or without a key", async () => {
		// Positive control first: the same render path shows the card while
		// pending, so an empty result below means the state was applied.
		stateMock.mockResolvedValue({ effective: "pending", choice: null });
		const control = render(<TelemetryNotice />);
		expect(await screen.findByRole("status")).toBeTruthy();
		control.unmount();
		for (const state of [
			{ effective: "enabled" as const, choice: "accepted" as const },
			{ effective: "disabled" as const, reason: "ci" as const, choice: null },
			{
				effective: "disabled" as const,
				reason: "no_key" as const,
				choice: null,
			},
		]) {
			stateMock.mockClear();
			stateMock.mockResolvedValue(state);
			const { container, unmount } = render(<TelemetryNotice />);
			await vi.waitFor(() => expect(stateMock).toHaveBeenCalledTimes(1));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(container.innerHTML).toBe("");
			unmount();
		}
	});

	it("waits until the first-run guide is closed or a project exists", async () => {
		stateMock.mockResolvedValue({ effective: "pending", choice: null });
		useStore.setState({ uiPrefs: { ...DEFAULT_UI_PREFS } });
		const { container } = render(<TelemetryNotice />);
		await vi.waitFor(() => expect(stateMock).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(container.innerHTML).toBe("");
		useStore.setState({
			uiPrefs: { ...DEFAULT_UI_PREFS, onboardingDismissed: true },
		});
		expect(await screen.findByRole("status")).toBeTruthy();
		expect(stateMock).toHaveBeenCalledTimes(1);
	});

	it("stays mounted but draws nothing while hidden, without asking again", async () => {
		stateMock.mockResolvedValue({ effective: "pending", choice: null });
		const { container, rerender } = render(<TelemetryNotice hidden />);
		await vi.waitFor(() => expect(stateMock).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(container.innerHTML).toBe("");
		rerender(<TelemetryNotice />);
		expect(await screen.findByRole("status")).toBeTruthy();
		expect(stateMock).toHaveBeenCalledTimes(1);
	});

	it("renders nothing outside a Tauri webview", async () => {
		stateMock.mockRejectedValue(new Error("not a tauri webview"));
		const { container } = render(<TelemetryNotice />);
		await vi.waitFor(() => expect(stateMock).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(container.innerHTML).toBe("");
	});
});
