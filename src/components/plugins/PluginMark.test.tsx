// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PluginMark } from "./PluginMark";

const svgOf = (container: HTMLElement) =>
	container.querySelector("svg") as SVGSVGElement;

describe("PluginMark", () => {
	afterEach(cleanup);

	it("draws the octocat for the github view icon", () => {
		const { container } = render(
			<PluginMark icon="github" className="size-5" />,
		);
		const svg = svgOf(container);
		expect(svg.getAttribute("class")).toBe("size-5");
		expect(svg.querySelector("path")?.getAttribute("d")).toMatch(/^M15 22v-4/);
	});

	it("draws the lucide glyph for the other view icons", () => {
		const { container } = render(<PluginMark icon="list_todo" />);
		expect(svgOf(container).getAttribute("class")).toContain(
			"lucide-list-todo",
		);
	});

	it("falls back to the package glyph for a plugin without a rail presence", () => {
		const { container } = render(<PluginMark icon={null} className="size-4" />);
		const svg = svgOf(container);
		expect(svg.getAttribute("class")).toContain("lucide-box");
		expect(svg.getAttribute("class")).toContain("size-4");
	});
});
