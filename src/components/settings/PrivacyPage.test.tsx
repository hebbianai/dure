// @vitest-environment jsdom
// The one control on this page is wired to the native consent record (#961):
// what the switch shows is what the app does. Every other row states a fact
// in a pill and offers nothing to press.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivacyPage } from "@/components/settings/PrivacyPage";
import { t } from "@/lib/i18n";
import { telemetrySetChoice, telemetryState } from "@/lib/ipc/telemetry";
import { openExternalUrl } from "@/lib/platform/externalOpen";
import { useStore } from "@/store";

vi.mock("@/lib/ipc/telemetry", () => ({
	telemetryState: vi.fn(),
	telemetrySetChoice: vi.fn(),
}));
vi.mock("@/lib/platform/externalOpen", () => ({
	openExternalUrl: vi.fn(async () => undefined),
}));

const stateMock = vi.mocked(telemetryState);
const setChoiceMock = vi.mocked(telemetrySetChoice);

beforeEach(() => {
	stateMock.mockReset();
	setChoiceMock.mockReset();
});

afterEach(() => {
	cleanup();
	useStore.setState({ language: "system" });
});

describe("PrivacyPage", () => {
	it("offers the switch off while the install is pending, and records Accept", async () => {
		stateMock.mockResolvedValue({ effective: "pending", choice: null });
		setChoiceMock.mockResolvedValue({
			effective: "enabled",
			choice: "accepted",
		});
		render(<PrivacyPage />);

		const control = await screen.findByRole("switch", {
			name: t("settings.privacy.usageData.title"),
		});
		expect(control.getAttribute("aria-checked")).toBe("false");
		fireEvent.click(control);
		expect(setChoiceMock).toHaveBeenCalledWith("accepted");
		await vi.waitFor(() =>
			expect(control.getAttribute("aria-checked")).toBe("true"),
		);
		expect(
			screen.getByRole("button", {
				name: t("settings.privacy.usageData.whatIsSent"),
			}),
		).toBeTruthy();
	});

	it("opens the public page in the reader's language", async () => {
		stateMock.mockResolvedValue({ effective: "pending", choice: null });
		useStore.setState({ language: "ko" });
		render(<PrivacyPage />);
		fireEvent.click(
			await screen.findByRole("button", {
				name: t("settings.privacy.usageData.whatIsSent"),
			}),
		);
		expect(openExternalUrl).toHaveBeenCalledWith(
			"https://docs.dureai.dev/ko/privacy-and-telemetry",
		);
	});

	it("records Decline from the switch", async () => {
		stateMock.mockResolvedValue({ effective: "enabled", choice: "accepted" });
		setChoiceMock.mockResolvedValue({
			effective: "disabled",
			reason: "declined",
			choice: "declined",
		});
		render(<PrivacyPage />);
		const control = await screen.findByRole("switch");
		expect(control.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(control);
		expect(setChoiceMock).toHaveBeenCalledWith("declined");
		await vi.waitFor(() =>
			expect(control.getAttribute("aria-checked")).toBe("false"),
		);
	});

	it("shows the environment's decision as an immovable switch with its reason", async () => {
		stateMock.mockResolvedValue({
			effective: "disabled",
			reason: "do_not_track",
			choice: "accepted",
		});
		render(<PrivacyPage />);
		const control = await screen.findByRole("switch");
		expect(control.getAttribute("aria-checked")).toBe("false");
		expect(control.hasAttribute("disabled")).toBe(true);
		expect(
			screen.getByText(t("settings.privacy.usageData.reason.doNotTrack")),
		).toBeTruthy();
	});

	it("shows a pill and no switch in a build without telemetry", async () => {
		stateMock.mockResolvedValue({
			effective: "disabled",
			reason: "no_key",
			choice: null,
		});
		render(<PrivacyPage />);
		expect(
			await screen.findByText(t("settings.privacy.usageData.notInBuild")),
		).toBeTruthy();
		expect(screen.queryByRole("switch")).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("renders the row but no control outside a Tauri webview", async () => {
		stateMock.mockRejectedValue(new Error("not a tauri webview"));
		const { container } = render(<PrivacyPage />);
		await vi.waitFor(() => expect(stateMock).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			screen.getByText(t("settings.privacy.usageData.title")),
		).toBeTruthy();
		expect(container.querySelector('[role="switch"]')).toBeNull();
		expect(container.querySelector("button")).toBeNull();
	});

	it("keeps the four rows and their three hairlines, with pills elsewhere", async () => {
		stateMock.mockResolvedValue({ effective: "pending", choice: null });
		const { container } = render(<PrivacyPage />);
		await screen.findByRole("switch");
		expect(container.querySelectorAll("section").length).toBe(4);
		expect(container.querySelectorAll("section.border-t").length).toBe(3);
		expect(
			screen.getByText(t("settings.privacy.diagnostics.onlyOnYourAction")),
		).toBeTruthy();
		expect(
			screen.getByText(t("settings.privacy.credentials.deviceOnly")),
		).toBeTruthy();
		expect(
			screen.getByText(t("settings.privacy.feedback.onlyWhenSent")),
		).toBeTruthy();
	});
});
