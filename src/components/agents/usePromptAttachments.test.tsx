// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePromptAttachments } from "./usePromptAttachments";
import { useState } from "react";
import type { DroppedFilePayload } from "@/lib/files/externalFileDrop";

const ports = vi.hoisted(() => ({ image: vi.fn(), text: vi.fn(), onText: vi.fn(), onError: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ readClipboardImage: ports.image }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: ports.text }));
function Input() {
	const [attachments, setAttachments] = useState<DroppedFilePayload[]>([]);
	const { inputProps } = usePromptAttachments({
		attachments, setAttachments,
		scope: "input", imageName: (ext) => `capture.${ext}`, onText: ports.onText, onError: ports.onError,
	});
	return <><textarea {...inputProps} /><output>{attachments.map((file) => `${file.fileName}:${file.dataB64}`).join(",")}</output></>;
}
beforeEach(() => { vi.resetAllMocks(); ports.image.mockResolvedValue(null); ports.text.mockResolvedValue(""); });
afterEach(cleanup);

it("leaves ordinary text insertion and selection to the browser", () => {
	render(<Input />);
	const event = createEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ type: "text/plain" }] } });
	fireEvent(screen.getByRole("textbox"), event);
	expect(event.defaultPrevented).toBe(false);
	expect(ports.image).not.toHaveBeenCalled();
	expect(ports.onText).not.toHaveBeenCalled();
});

it.each(["image", "text", "event"])("uses the existing %s paste source priority and event extension", async (source) => {
	if (source === "image") ports.image.mockResolvedValue({ dataB64: "native", ext: "png" });
	if (source === "text") ports.text.mockResolvedValue("native text");
	const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2]).buffer);
	render(<Input />);
	const event = createEvent.paste(screen.getByRole("textbox"), { clipboardData: {
		items: [{ type: "image/svg+xml", getAsFile: () => ({ arrayBuffer }) }],
	} });
	await act(async () => { fireEvent(screen.getByRole("textbox"), event); });
	expect(event.defaultPrevented).toBe(true);
	if (source === "text") expect(ports.onText).toHaveBeenCalledWith("native text");
	else expect(screen.getByRole("status").textContent).toBe(source === "image" ? "capture.png:native" : "capture.svg:AQI=");
	expect(arrayBuffer).toHaveBeenCalledTimes(source === "event" ? 1 : 0);
});

it("decodes an accepted drop and reports batch rejection without replacing attachments", async () => {
	render(<Input />);
	const file = { name: "note.txt", size: 2, arrayBuffer: async () => new Uint8Array([1, 2]).buffer };
	await act(async () => { fireEvent.drop(screen.getByRole("textbox"), { dataTransfer: { types: ["Files"], files: [file] } }); });
	expect(screen.getByRole("status").textContent).toBe("note.txt:AQI=");
	await act(async () => { fireEvent.drop(screen.getByRole("textbox"), { dataTransfer: { types: ["Files"], files: Array(6).fill(file) } }); });
	expect(ports.onError).toHaveBeenCalledTimes(1);
	expect(screen.getByRole("status").textContent).toBe("note.txt:AQI=");
});

it("does not publish captured text after unmount", async () => {
	let finish!: (text: string) => void;
	ports.text.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
	const view = render(<Input />);
	fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] } });
	view.unmount();
	await act(async () => { finish("retired"); });
	expect(ports.onText).not.toHaveBeenCalled();
});

it("moves keyboard focus to the composer on drop so Enter submits immediately", async () => {
	render(<Input />);
	const composer = screen.getByRole("textbox");
	expect(document.activeElement).not.toBe(composer);
	const file = { name: "shot.png", size: 2, arrayBuffer: async () => new Uint8Array([1, 2]).buffer };
	await act(async () => { fireEvent.drop(composer, { dataTransfer: { types: ["Files"], files: [file] } }); });
	expect(document.activeElement).toBe(composer);
});
