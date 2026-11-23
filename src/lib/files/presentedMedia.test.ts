import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc/core", () => ({ convertFileSrc: vi.fn() }));

import { fileMediaSource, PRESENTED_MEDIA_SCHEME } from "@/lib/files/presentedMedia";

describe("fileMediaSource", () => {
	it("loads a streamed file from its presented-media URL, never its inline bytes", () => {
		const toStreamUrl = vi.fn((token: string, scheme: string) => `${scheme}://localhost/${token}`);
		expect(
			fileMediaSource({ stream: "abc123", mime: "video/mp4", content: "" }, toStreamUrl),
		).toBe("dure-media://localhost/abc123");
		expect(toStreamUrl).toHaveBeenCalledWith("abc123", PRESENTED_MEDIA_SCHEME);
	});

	it("keeps the inline data URI for files read with their bytes", () => {
		const toStreamUrl = vi.fn();
		expect(fileMediaSource({ mime: "image/png", content: "iVBOR" }, toStreamUrl)).toBe(
			"data:image/png;base64,iVBOR",
		);
		expect(fileMediaSource({ content: "text" }, toStreamUrl)).toBeUndefined();
		expect(toStreamUrl).not.toHaveBeenCalled();
	});
});
