// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { saveTempImage } from "@/lib/ipc/system";
import { copyTextToClipboard } from "@/lib/platform/clipboardWrite";
import { MobileSimulatorCaptureButton } from "./MobileSimulatorCaptureButton";

vi.mock("@/lib/ipc/system", () => ({ saveTempImage: vi.fn() }));
vi.mock("@/lib/platform/clipboardWrite", () => ({
	copyTextToClipboard: vi.fn(),
}));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});
it("saves the inspected frame and copies its artifact path for the agent", async () => {
	vi.mocked(saveTempImage).mockResolvedValue("/tmp/qa-screen.png");
	vi.mocked(copyTextToClipboard).mockResolvedValue(true);
	render(
		<MobileSimulatorCaptureButton
			paneId="pane-one"
			frame={{
				dataUrl: "data:image/png;base64,aGVsbG8=",
				width: 400,
				height: 800,
			}}
		/>,
	);
	fireEvent.click(screen.getByRole("button"));
	await waitFor(() =>
		expect(copyTextToClipboard).toHaveBeenCalledWith(
			"/tmp/qa-screen.png",
			expect.objectContaining({ paneId: "pane-one" }),
		),
	);
	expect(saveTempImage).toHaveBeenCalledWith({
		dataB64: "aGVsbG8=",
		ext: "png",
	});
});
it("retains an artifact failure without copying a nonexistent path", async () => {
	vi.mocked(saveTempImage).mockRejectedValue("No space left");
	render(
		<MobileSimulatorCaptureButton
			paneId="pane-one"
			frame={{ dataUrl: "data:image/png;base64,aA==", width: 400, height: 800 }}
		/>,
	);
	fireEvent.click(screen.getByRole("button"));
	expect((await screen.findByRole("alert")).textContent).toContain(
		"No space left",
	);
	expect(copyTextToClipboard).not.toHaveBeenCalled();
});
