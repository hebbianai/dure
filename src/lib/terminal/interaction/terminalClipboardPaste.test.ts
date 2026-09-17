// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from "vitest";
import { createTerminalClipboardPasteHandler } from "./terminalClipboardPaste";

const mocks = vi.hoisted(() => ({
	image: vi.fn(),
	save: vi.fn(),
	upload: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({
	readClipboardImage: mocks.image,
	saveTempImage: mocks.save,
}));
vi.mock("@/lib/files/sessionFileTransfer", () => ({
	saveSessionFiles: mocks.upload,
}));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.image.mockResolvedValue({ dataB64: "aW1hZ2U=", ext: "png" });
});

it("uses the receiving session's file preparation for an SSH command inside a local pane", async () => {
	const prepareFiles = vi
		.fn()
		.mockResolvedValue(["/tmp/remote/pasted-image.png"]);
	mocks.save.mockResolvedValue("/tmp/mac/pasted-image.png");
	const forwardUserInput = vi.fn();
	const onError = vi.fn();
	createTerminalClipboardPasteHandler({
		hostId: undefined,
		prepareFiles,
		canForwardText: () => true,
		refreshControlState: () => {},
		bracketedPasteMode: () => false,
		forwardUserInput,
		onError,
	})({
		clipboardData: { items: [], getData: () => "" },
		preventDefault() {},
		stopImmediatePropagation() {},
	} as unknown as ClipboardEvent);
	await vi.waitFor(() => expect(forwardUserInput).toHaveBeenCalledOnce());
	expect(forwardUserInput).toHaveBeenCalledWith(
		"'/tmp/remote/pasted-image.png' ",
	);
	expect(prepareFiles).toHaveBeenCalledWith([
		{ fileName: "pasted-image.png", dataB64: "aW1hZ2U=" },
	]);
	expect(mocks.save).not.toHaveBeenCalled();
	expect(onError).not.toHaveBeenCalled();
});

it.each([
	{ result: new Error("upload failed"), message: "upload failed" },
	{ result: [], message: "invalid_backend_result" },
	{ result: ["/tmp/image.png\nexit"], message: "invalid_backend_result" },
])(
	"forwards no input when the remote image transfer fails: $message",
	async ({ result, message }) => {
		if (result instanceof Error) mocks.upload.mockRejectedValueOnce(result);
		else mocks.upload.mockResolvedValueOnce(result);
		const forwardUserInput = vi.fn();
		const onError = vi.fn();
		createTerminalClipboardPasteHandler({
			hostId: "remote-host",
			canForwardText: () => true,
			refreshControlState: () => {},
			bracketedPasteMode: () => false,
			forwardUserInput,
			onError,
		})({
			clipboardData: { items: [], getData: () => "" },
			preventDefault() {},
			stopImmediatePropagation() {},
		} as unknown as ClipboardEvent);
		await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message }));
		expect(mocks.upload).toHaveBeenCalledWith("remote-host", [
			{ fileName: "pasted-image.png", dataB64: "aW1hZ2U=" },
		]);
		expect(mocks.save).not.toHaveBeenCalled();
		expect(forwardUserInput).not.toHaveBeenCalled();
	},
);
