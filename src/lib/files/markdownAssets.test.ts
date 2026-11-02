import { describe, expect, it } from "vitest";
import { resolveMarkdownAssetPath } from "@/lib/files/markdownAssets";

describe("resolveMarkdownAssetPath", () => {
	it("resolves references against the document's folder", () => {
		expect(resolveMarkdownAssetPath("/docs/gallery.md", "mockups/retro/type-dark.png")).toBe("/docs/mockups/retro/type-dark.png");
		expect(resolveMarkdownAssetPath("/docs/gallery.md", "./shot.png")).toBe("/docs/shot.png");
		expect(resolveMarkdownAssetPath("/docs/guide/intro.md", "../assets/./logo.svg")).toBe("/docs/assets/logo.svg");
		expect(resolveMarkdownAssetPath("/README.md", "../../logo.png")).toBe("/logo.png");
	});

	it("decodes the URL form of a path and drops its query and fragment", () => {
		expect(resolveMarkdownAssetPath("/docs/a.md", "my%20shots/one.png")).toBe("/docs/my shots/one.png");
		expect(resolveMarkdownAssetPath("/docs/a.md", "shot.png?raw=1#top")).toBe("/docs/shot.png");
		expect(resolveMarkdownAssetPath("/docs/a.md", "100%.png")).toBe("/docs/100%.png");
	});

	it("keeps absolute file paths", () => {
		expect(resolveMarkdownAssetPath("/docs/a.md", "/srv/media/shot.png")).toBe("/srv/media/shot.png");
	});

	it("leaves URLs, protocol-relative references and fragments to the webview", () => {
		for (const reference of ["https://example.com/a.png", "data:image/png;base64,AA", "mailto:a@example.com", "//cdn.example.com/a.png", "#section", "", "  "]) {
			expect(resolveMarkdownAssetPath("/docs/a.md", reference)).toBeUndefined();
		}
	});

	it("resolves Windows document paths with their own separator", () => {
		expect(resolveMarkdownAssetPath("C:\\Users\\dev\\notes\\a.md", "img/shot.png")).toBe("C:\\Users\\dev\\notes\\img\\shot.png");
		expect(resolveMarkdownAssetPath("C:\\Users\\dev\\notes\\a.md", "..\\shot.png")).toBe("C:\\Users\\dev\\shot.png");
		expect(resolveMarkdownAssetPath("C:\\notes\\a.md", "D:/media/shot.png")).toBe("D:\\media\\shot.png");
	});

	it("keeps a remote home prefix for the remote shell to expand", () => {
		expect(resolveMarkdownAssetPath("~/notes/a.md", "img/shot.png")).toBe("~/notes/img/shot.png");
		expect(resolveMarkdownAssetPath("~/a.md", "../shared/shot.png")).toBe("~/../shared/shot.png");
	});
});
