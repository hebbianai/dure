// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CodeBlock } from "@/components/common/CodeBlock";

afterEach(cleanup);

describe("CodeBlock", () => {
	it("renders a monospace pre with the shared block shape", () => {
		const { container } = render(<CodeBlock>cd mobile</CodeBlock>);
		const block = container.firstElementChild as HTMLElement;
		expect(block.tagName).toBe("PRE");
		expect(block.className).toContain("overflow-auto");
		expect(block.className).toContain("rounded-md");
		expect(block.className).toContain("border-border/60");
		expect(block.className).toContain("bg-muted/30");
		expect(block.className).toContain("p-2.5");
		expect(block.className).toContain("font-mono");
		expect(block.className).toContain("text-[11px]");
		expect(block.className).toContain("whitespace-pre-wrap");
		expect(block.textContent).toBe("cd mobile");
	});

	it("is not selectable unless requested", () => {
		const { container } = render(<CodeBlock>stack trace</CodeBlock>);
		const block = container.firstElementChild as HTMLElement;
		expect(block.getAttribute("data-selectable")).toBeNull();
	});

	it("sets data-selectable when selectable", () => {
		const { container } = render(<CodeBlock selectable>ssh command</CodeBlock>);
		const block = container.firstElementChild as HTMLElement;
		expect(block.getAttribute("data-selectable")).toBe("true");
	});

	it("merges maxHeightClass and className", () => {
		const { container } = render(
			<CodeBlock maxHeightClass="max-h-32" className="mt-2">
				long log
			</CodeBlock>,
		);
		const block = container.firstElementChild as HTMLElement;
		expect(block.className).toContain("max-h-32");
		expect(block.className).toContain("mt-2");
		expect(block.className).toContain("font-mono");
	});
});
