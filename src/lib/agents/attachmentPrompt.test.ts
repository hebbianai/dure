import { describe, expect, it } from "vitest";
import {
	buildPromptWithAttachments,
	splitPromptAttachments,
} from "@/lib/agents/attachmentPrompt";

describe("buildPromptWithAttachments", () => {
	it("returns the trimmed body untouched without attachments", () => {
		expect(buildPromptWithAttachments("  fix it  ", [])).toBe("fix it");
	});

	it("references each saved path after the body", () => {
		expect(
			buildPromptWithAttachments("look", ["/a/1.png", "/a/2.png"]),
		).toBe(
			"look\n\nRead the attached image 1 before starting: /a/1.png\n" +
				"Read the attached image 2 before starting: /a/2.png",
		);
	});

	it("sends references alone for an image-only message", () => {
		expect(buildPromptWithAttachments("   ", ["/a/1.png"])).toBe(
			"Read the attached image 1 before starting: /a/1.png",
		);
	});
});

describe("splitPromptAttachments", () => {
	it("round-trips a built prompt back into body and references", () => {
		const prompt = buildPromptWithAttachments("look at this", [
			"/a/pasted-1-1.png",
			"/a/pasted-1-2.png",
		]);
		expect(splitPromptAttachments(prompt)).toEqual({
			body: "look at this",
			attachments: [
				{ path: "/a/pasted-1-1.png", fileName: "pasted-1-1.png" },
				{ path: "/a/pasted-1-2.png", fileName: "pasted-1-2.png" },
			],
		});
	});

	it("recovers an image-only message as an empty body", () => {
		expect(
			splitPromptAttachments(buildPromptWithAttachments("", ["/a/1.png"])),
		).toEqual({
			body: "",
			attachments: [{ path: "/a/1.png", fileName: "1.png" }],
		});
	});

	it("leaves messages without a trailing reference block untouched", () => {
		const text =
			"Read the attached image 1 before starting: /a/1.png\n\nactual question";
		expect(splitPromptAttachments(text)).toEqual({
			body: text,
			attachments: [],
		});
		expect(splitPromptAttachments("plain text")).toEqual({
			body: "plain text",
			attachments: [],
		});
	});
});
