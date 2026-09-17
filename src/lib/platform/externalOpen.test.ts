import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	isUserCancelledExternalOpen,
	openExternalUrl,
} from "@/lib/platform/externalOpen";

const mocks = vi.hoisted(() => ({
	openUrl: vi.fn<(url: string) => Promise<void>>(),
	showErrorToast: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

vi.mock("@/lib/toast", () => ({
	showErrorToast: mocks.showErrorToast,
	showToast: vi.fn(),
}));

beforeEach(() => {
	mocks.openUrl.mockReset();
	mocks.showErrorToast.mockReset();
});

describe("openExternalUrl", () => {
	it("opens the url and stays silent on success", async () => {
		mocks.openUrl.mockResolvedValue(undefined);

		await openExternalUrl("https://example.com/docs");

		expect(mocks.openUrl).toHaveBeenCalledWith("https://example.com/docs");
		expect(mocks.showErrorToast).not.toHaveBeenCalled();
	});

	it("toasts the failure detail instead of swallowing it", async () => {
		// Tauri invoke rejects with the Rust error serialized as a string.
		mocks.openUrl.mockRejectedValue("Not allowed to open url file:///etc");

		await openExternalUrl("file:///etc");

		expect(mocks.showErrorToast).toHaveBeenCalledWith(
			"링크를 열지 못했습니다: Not allowed to open url file:///etc",
		);
	});

	it("stays silent when the user cancelled the open", async () => {
		mocks.openUrl.mockRejectedValue(
			new Error("The operation was canceled by the user."),
		);

		await openExternalUrl("https://example.com");

		expect(mocks.showErrorToast).not.toHaveBeenCalled();
	});

	it("still toasts a scope denial whose url contains 'cancel'", async () => {
		mocks.openUrl.mockRejectedValue(
			"Not allowed to open url https://example.com/cancel",
		);

		await openExternalUrl("https://example.com/cancel");

		expect(mocks.showErrorToast).toHaveBeenCalledTimes(1);
	});
});

describe("isUserCancelledExternalOpen", () => {
	it.each([
		["The operation was canceled by the user.", true],
		["Portal request Cancelled", true],
		["LSOpenURLsWithRole() failed with error -128.", true],
		["Not allowed to open url https://example.com/cancel", false],
		["Not allowed to open path /tmp/cancel", false],
		["No such file or directory (os error 2)", false],
	])("classifies %j as cancel=%s", (text, expected) => {
		expect(isUserCancelledExternalOpen(text)).toBe(expected);
		expect(isUserCancelledExternalOpen(new Error(text))).toBe(expected);
	});
});
