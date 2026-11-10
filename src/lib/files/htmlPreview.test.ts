// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
	buildHtmlPreview,
	HTML_PREVIEW_IMAGE_LIMIT,
	hasRenderedView,
	isHtmlFileName,
} from "@/lib/files/htmlPreview";

const parse = (srcdoc: string) => new DOMParser().parseFromString(srcdoc, "text/html");

describe("HTML preview documents", () => {
	it("recognizes HTML files and the text documents that have a rendered view", () => {
		expect(isHtmlFileName("report.html")).toBe(true);
		expect(isHtmlFileName("INDEX.HTM")).toBe(true);
		expect(isHtmlFileName("notes.md")).toBe(false);
		expect(isHtmlFileName("page.html.txt")).toBe(false);
		expect(hasRenderedView({ kind: "text", name: "report.html" })).toBe(true);
		expect(hasRenderedView({ kind: "markdown", name: "notes.md" })).toBe(true);
		expect(hasRenderedView({ kind: "text", name: "notes.txt" })).toBe(false);
		expect(hasRenderedView({ kind: "binary", name: "report.html" })).toBe(false);
	});

	it("inlines images beside the page and keeps URLs and missing files as written", async () => {
		const readImage = vi.fn(async (path: string) =>
			path === "/work/out/chart.png" ? "data:image/png;base64,AAAA" : undefined,
		);
		const preview = await buildHtmlPreview(
			'<!doctype html><html><body><img src="chart.png" srcset="chart@2x.png 2x" alt="Chart">' +
				'<img src="./chart.png" alt="Again"><img src="https://example.com/logo.png" alt="Remote">' +
				'<img src="missing.png" alt="Missing"></body></html>',
			"/work/out/report.html",
			readImage,
		);
		const doc = parse(preview.srcdoc);
		expect(preview.srcdoc.startsWith("<!DOCTYPE html>")).toBe(true);
		expect(doc.querySelector('img[alt="Chart"]')?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
		expect(doc.querySelector('img[alt="Chart"]')?.hasAttribute("srcset")).toBe(false);
		expect(doc.querySelector('img[alt="Again"]')?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
		expect(doc.querySelector('img[alt="Remote"]')?.getAttribute("src")).toBe("https://example.com/logo.png");
		expect(doc.querySelector('img[alt="Missing"]')?.getAttribute("src")).toBe("missing.png");
		expect(readImage.mock.calls.map(([path]) => path).sort()).toEqual(["/work/out/chart.png", "/work/out/missing.png"]);
		expect(preview.hasScripts).toBe(false);
	});

	it("keeps rendering when an image read fails", async () => {
		const preview = await buildHtmlPreview('<p>Body</p><img src="a.png">', "/r/page.html", async () => {
			throw new Error("No such file");
		});
		expect(parse(preview.srcdoc).querySelector("img")?.getAttribute("src")).toBe("a.png");
		expect(parse(preview.srcdoc).querySelector("p")?.textContent).toBe("Body");
	});

	it("reads at most the image limit of distinct files", async () => {
		const readImage = vi.fn(async () => "data:image/png;base64,AA");
		const images = Array.from({ length: HTML_PREVIEW_IMAGE_LIMIT + 5 }, (_, index) => `<img src="${index}.png">`);
		await buildHtmlPreview(images.join(""), "/r/page.html", readImage);
		expect(readImage).toHaveBeenCalledTimes(HTML_PREVIEW_IMAGE_LIMIT);
	});

	it("reports scripts and inline handlers that the preview does not run", async () => {
		const none = async () => undefined;
		expect((await buildHtmlPreview("<script>run()</script>", "/p.html", none)).hasScripts).toBe(true);
		expect((await buildHtmlPreview('<button onclick="run()">Go</button>', "/p.html", none)).hasScripts).toBe(true);
		expect((await buildHtmlPreview("<p>static</p>", "/p.html", none)).hasScripts).toBe(false);
	});
});

describe("HTML preview links", () => {
	it("keeps fragments in the page and stops every other link from leaving the frame", async () => {
		const preview = await buildHtmlPreview(
			'<html><head><base href="https://example.com/"><meta http-equiv="Refresh" content="0; url=https://example.com/">' +
				'<meta charset="utf-8"></head><body><a href="#results" target="_top">Results</a>' +
				'<a href="details.html">Next</a><a href="https://example.com/docs" title="Docs">Web</a>' +
				'<map name="m"><area href="mailto:team@example.com" alt="Mail"></map><a>Anchor</a>' +
				'<svg><a xlink:href="https://example.com/svg"><text>Svg</text></a></svg></body></html>',
			"/r/page.html",
			async () => undefined,
		);
		const doc = parse(preview.srcdoc);
		const bases = doc.querySelectorAll("base");
		expect(bases).toHaveLength(1);
		expect(bases[0]!.getAttribute("href")).toBe("about:srcdoc");
		expect(doc.head.firstElementChild).toBe(bases[0]);
		expect(doc.querySelector("meta[http-equiv]")).toBeNull();
		expect(doc.querySelector('meta[charset="utf-8"]')).not.toBeNull();
		const link = (text: string) => [...doc.querySelectorAll("a")].find((a) => a.textContent === text)!;
		expect(link("Results").hasAttribute("target")).toBe(false);
		expect(link("Next").getAttribute("target")).toBe("_blank");
		expect(link("Next").getAttribute("title")).toBe("details.html");
		expect(link("Web").getAttribute("target")).toBe("_blank");
		expect(link("Web").getAttribute("title")).toBe("Docs");
		expect(doc.querySelector("area")?.getAttribute("target")).toBe("_blank");
		expect(link("Anchor").hasAttribute("target")).toBe(false);
		expect(link("Svg").getAttribute("target")).toBe("_blank");
		expect(link("Svg").getAttribute("title")).toBe("https://example.com/svg");
	});
});
