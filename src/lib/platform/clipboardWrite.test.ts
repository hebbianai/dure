import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CopyTextToClipboardOptions,
	copyTextToClipboard,
} from "@/lib/platform/clipboardWrite";

const mocks = vi.hoisted(() => ({
	writeText: vi.fn<(text: string) => Promise<void>>(),
	showToast: vi.fn(),
	showErrorToast: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: mocks.writeText,
}));

vi.mock("@/lib/toast", () => ({
	showToast: mocks.showToast,
	showErrorToast: mocks.showErrorToast,
}));

beforeEach(() => {
	mocks.writeText.mockReset();
	mocks.showToast.mockReset();
	mocks.showErrorToast.mockReset();
});

describe("copyTextToClipboard", () => {
	it("writes the text and shows the shared success toast", async () => {
		mocks.writeText.mockResolvedValue(undefined);

		const copied = await copyTextToClipboard("host-42");

		expect(copied).toBe(true);
		expect(mocks.writeText).toHaveBeenCalledWith("host-42");
		expect(mocks.showToast).toHaveBeenCalledWith("클립보드에 복사됨");
		expect(mocks.showErrorToast).not.toHaveBeenCalled();
	});

	it("shows the shared error toast when the write fails", async () => {
		mocks.writeText.mockRejectedValue(new Error("denied"));

		const copied = await copyTextToClipboard("host-42");

		expect(copied).toBe(false);
		expect(mocks.showErrorToast).toHaveBeenCalledWith(
			"클립보드에 복사하지 못했습니다",
		);
		expect(mocks.showToast).not.toHaveBeenCalled();
	});

	it("prefers caller-provided messages over the shared copy", async () => {
		const options: CopyTextToClipboardOptions = {
			successMessage: "진단 복사 완료",
			errorMessage: "진단 복사 실패",
		};

		mocks.writeText.mockResolvedValue(undefined);
		await copyTextToClipboard("diag", options);
		expect(mocks.showToast).toHaveBeenCalledWith("진단 복사 완료");

		mocks.writeText.mockRejectedValue(new Error("denied"));
		await copyTextToClipboard("diag", options);
		expect(mocks.showErrorToast).toHaveBeenCalledWith("진단 복사 실패");
	});
});
