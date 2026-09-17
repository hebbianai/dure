// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { THEME_STYLE_ELEMENT_ID } from "@/lib/theme/themeStyle";
import {
	appCssSources,
	buildMockupSrcdoc,
	isMockupPath,
	MOCKUP_TOKEN_STYLE_ATTR,
	mockupPaneTitle,
} from "./mockupSrcdoc";

describe("isMockupPath / mockupPaneTitle", () => {
	it("matches only the mockup tree shape", () => {
		expect(isMockupPath("design/mockups/spaces/SpacesPane/default.html")).toBe(true);
		expect(isMockupPath("/repo/root/design/mockups/spaces/SpacesPane/empty.html")).toBe(true);
		expect(isMockupPath("design/mockups/spaces/SpacesPane/default.htm")).toBe(false);
		expect(isMockupPath("design/specs/spaces/SpacesPane.md")).toBe(false);
		expect(isMockupPath("design/mockups/tooDeep/x/Y/default.html")).toBe(false);
	});

	it("titles as Name · state", () => {
		expect(mockupPaneTitle("/r/design/mockups/spaces/SpacesPane/empty.html")).toBe(
			"SpacesPane · empty",
		);
		expect(mockupPaneTitle("src/other.html")).toBeNull();
	});
});

describe("appCssSources", () => {
	it("collects inline style texts and stylesheet hrefs", () => {
		document.head.innerHTML = `
			<style>:root { --x: 1; }</style>
			<link rel="stylesheet" href="https://app.test/assets/index.css">
			<link rel="icon" href="https://app.test/favicon.ico">
		`;
		const sources = appCssSources(document);
		expect(sources.inline.join("")).toContain("--x: 1");
		expect(sources.hrefs).toEqual(["https://app.test/assets/index.css"]);
	});

	it("excludes the managed theme override — the preview injects its own", () => {
		document.head.innerHTML = `
			<style>:root { --x: 1; }</style>
			<style id="${THEME_STYLE_ELEMENT_ID}">html:root { --x: PINNED; }</style>
		`;
		const sources = appCssSources(document);
		expect(sources.inline.join("")).not.toContain("PINNED");
	});
});

describe("buildMockupSrcdoc", () => {
	const css = ":root { --status-run: #15803d; }";

	it("wraps fragments with a head carrying the token style", () => {
		const out = buildMockupSrcdoc(`<div style="color: var(--status-run)">x</div>`, css, false);
		expect(out).toContain(`<style ${MOCKUP_TOKEN_STYLE_ATTR}>`);
		expect(out).toContain("--status-run");
		expect(out).toMatch(/^<!doctype html>/);
		expect(out).not.toContain('class="dark"');
	});

	it("adds the dark class when requested", () => {
		expect(buildMockupSrcdoc("<div>x</div>", css, true)).toContain('<html class="dark">');
	});

	it("injects into an existing head and merges the dark class on <html>", () => {
		const doc = `<!doctype html><html class="fancy"><head><title>t</title></head><body>b</body></html>`;
		const out = buildMockupSrcdoc(doc, css, true);
		expect(out).toContain(`<head><style ${MOCKUP_TOKEN_STYLE_ATTR}>`);
		expect(out).toMatch(/<html class="fancy dark">/);
		expect(out.match(/<html/g)).toHaveLength(1);
	});

	it("merges single-quoted and unquoted class attributes both directions", () => {
		expect(buildMockupSrcdoc(`<html class='dark'><body>b</body></html>`, css, false)).toContain(
			'<html class="">',
		);
		expect(buildMockupSrcdoc(`<html class=fancy><body>b</body></html>`, css, true)).toContain(
			'<html class="fancy dark">',
		);
	});

	it("creates a head for documents without one and escapes style closers case-insensitively", () => {
		const out = buildMockupSrcdoc(`<html><body>b</body></html>`, `/* </STYLE> </style> */ :root{}`, false);
		expect(out).toContain("<head><style");
		expect(out).not.toMatch(/<\/STYLE>/);
		expect(out).not.toMatch(/[^\\]<\/style>[\s\S]*<\/style>[\s\S]*$/);
	});

	it("does not interpret $-sequences in collected CSS as replace patterns", () => {
		const dollarCss = `.q::after { content: "$'"; } :root { --x: 1; }`;
		const doc = `<!doctype html><html><head></head><body>tail-marker</body></html>`;
		const out = buildMockupSrcdoc(doc, dollarCss, false);
		expect(out).toContain(`content: "$'"`);
		expect(out.match(/tail-marker/g)).toHaveLength(1);
	});
});
