import { describe, expect, it, vi } from "vitest";
import {
	createTerminalPaste,
	MAX_PASTE_IMAGE_BYTES,
	readTerminalClipboard,
} from "./terminalPaste";

const image = () => {
	const bytes = new Uint8Array([137, 80, 78, 71]);
	const blob = new Blob([bytes], { type: "image/png" });
	Object.defineProperty(blob, "arrayBuffer", {
		value: async () => bytes.buffer,
	});
	return blob;
};
const setup = () => {
	let active = true;
	const deps = {
		active: () => active,
		send: vi.fn(),
		notice: vi.fn(),
		stageImage: vi.fn(async () => ["/tmp/private/pasted image.png"]),
		read: vi.fn(),
	};
	return {
		deps,
		paste: createTerminalPaste(deps),
		leave: () => {
			active = false;
		},
	};
};

describe("attachment-owned paste", () => {
	it("keeps text verbatim without submitting or applying bracketed paste twice", async () => {
		const { deps, paste } = setup();
		await paste({ kind: "text", text: "한글\nsecond line\t" });
		expect(deps.send).toHaveBeenCalledExactlyOnceWith("한글\nsecond line\t");
		expect(deps.stageImage).not.toHaveBeenCalled();
		expect(deps.read).not.toHaveBeenCalled();
	});
	it("saves image bytes before inserting the quoted receiving-computer path", async () => {
		const { deps, paste } = setup();
		await paste({ kind: "image", image: image() });
		expect(deps.stageImage).toHaveBeenCalledExactlyOnceWith({
			fileName: "pasted-image.png",
			dataB64: "iVBORw==",
		});
		expect(deps.send).toHaveBeenCalledExactlyOnceWith(
			"'/tmp/private/pasted image.png' ",
		);
		expect(deps.stageImage.mock.invocationCallOrder[0]).toBeLessThan(
			deps.send.mock.invocationCallOrder[0],
		);
	});
	it("does not stage clipboard contents after leaving the attachment during system permission", async () => {
		const { deps, paste, leave } = setup();
		let read!: (value: unknown) => void;
		deps.read.mockReturnValue(
			new Promise((resolve) => {
				read = resolve;
			}),
		);
		const pending = paste();
		expect(deps.read).toHaveBeenCalledOnce();
		leave();
		read({ kind: "image", image: image() });
		await pending;
		expect(deps.stageImage).not.toHaveBeenCalled();
		expect(deps.send).not.toHaveBeenCalled();
	});
	it("does not paste a late upload receipt or start a second transfer", async () => {
		const { deps, paste, leave } = setup();
		let uploaded!: (paths: string[]) => void;
		deps.stageImage.mockImplementation(
			() =>
				new Promise((resolve) => {
					uploaded = resolve;
				}),
		);
		const pending = paste({ kind: "image", image: image() });
		await vi.waitFor(() => expect(deps.stageImage).toHaveBeenCalledOnce());
		await paste({ kind: "image", image: image() });
		expect(deps.stageImage).toHaveBeenCalledOnce();
		leave();
		uploaded(["/tmp/exact-session/image.png"]);
		await pending;
		expect(deps.send).not.toHaveBeenCalled();
	});
	it("does not read the clipboard for an inactive or read-only attachment", async () => {
		const { deps, paste, leave } = setup();
		leave();
		await paste();
		expect(deps.read).not.toHaveBeenCalled();
	});
	it("refuses oversized images before serialization or upload", async () => {
		const { deps, paste } = setup();
		const blob = image();
		Object.defineProperty(blob, "size", { value: MAX_PASTE_IMAGE_BYTES + 1 });
		await paste({ kind: "image", image: blob });
		expect(deps.stageImage).not.toHaveBeenCalled();
		expect(deps.send).not.toHaveBeenCalled();
		expect(deps.notice).toHaveBeenCalledWith(
			"Images must be 10 MB or smaller.",
		);
	});
	it("refuses invalid paths rather than injecting a line break into the terminal", async () => {
		const { deps, paste } = setup();
		deps.stageImage.mockResolvedValue(["/tmp/image\nrun command"]);
		await paste({ kind: "image", image: image() });
		expect(deps.send).not.toHaveBeenCalled();
	});
	it("reads image representation before accompanying text", async () => {
		const getType = vi.fn(async () => image());
		const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				read: async () => [{ types: ["text/plain", "image/png"], getType }],
			},
		});
		try {
			expect((await readTerminalClipboard())?.kind).toBe("image");
			expect(getType).toHaveBeenCalledExactlyOnceWith("image/png");
		} finally {
			if (previous) Object.defineProperty(navigator, "clipboard", previous);
			else Reflect.deleteProperty(navigator, "clipboard");
		}
	});
});
