// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SafeMarkdown } from "@/components/common/SafeMarkdown";

describe("Markdown list windowing", () => {
	beforeEach(() => {
		// Real browser geometry is covered by agent-chat-virtualization.mjs.
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.tagName === "LI" ? 24 : 600;
			},
		);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				return new DOMRect(
					0,
					this.matches("ol, ul") ? -document.documentElement.scrollTop : 0,
					720,
					Number.parseFloat(this.style.height) || 24,
				);
			},
		);
		document.documentElement.scrollTop = 0;
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it.each(["-", "51."])(
		"windows 2000 parsed %s list items and exposes later items on scroll",
		(marker) => {
			const markdown = Array.from(
				{ length: 2000 },
				(_, i) => `${marker} Item **${i + 1}**`,
			).join("\n");
			const view = render(<SafeMarkdown markdown={markdown} />);
			const initial = screen.getAllByRole("listitem");
			expect(initial.length).toBeGreaterThan(0);
			expect(initial.length).toBeLessThan(100);
			expect(screen.getByText("1").tagName).toBe("STRONG");
			expect(screen.queryByText("2000")).toBeNull();
			if (marker === "51.")
				expect((initial[0] as HTMLLIElement).value).toBe(51);
			act(() => {
				document.documentElement.scrollTop = 28_000;
				fireEvent.scroll(window);
			});
			expect(screen.queryByText("1")).toBeNull();
			const later = screen.getAllByRole("listitem");
			expect(later.length).toBeLessThan(100);
			expect(Number(later[0]!.getAttribute("aria-posinset"))).toBeGreaterThan(
				900,
			);
			expect(later[0]!.getAttribute("aria-setsize")).toBe("2000");
			if (marker === "51.")
				expect((later[0] as HTMLLIElement).value).toBe(
					50 + Number(later[0]!.getAttribute("aria-posinset")),
				);
			expect(view.container.querySelectorAll("li").length).toBeLessThan(100);
		},
	);

	it("retains references, task state, nested content and safe navigation", () => {
		const onOpenExternal = vi.fn();
		const markdown =
			"- [x] **Done** [Docs][docs]\n  - Nested `code`\n\n" +
			Array.from({ length: 2000 }, (_, i) => `- [ ] Task ${i}`).join("\n") +
			"\n\n[docs]: https://example.com/docs\n";
		const view = render(
			<SafeMarkdown markdown={markdown} onOpenExternal={onOpenExternal} />,
		);
		expect(screen.getByText("Done").tagName).toBe("STRONG");
		expect(screen.getByText("code").tagName).toBe("CODE");
		expect(view.container.querySelector("ul ul li")).not.toBeNull();
		const checks = screen.getAllByRole("checkbox") as HTMLInputElement[];
		expect(checks[0]!.checked).toBe(true);
		expect(checks.every((check) => check.disabled)).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Docs" }));
		expect(onOpenExternal).toHaveBeenCalledExactlyOnceWith(
			"https://example.com/docs",
		);
	});

	it("preserves a focused link when a growing list starts windowing", () => {
		const markdown = (count: number) =>
			Array.from({ length: count }, (_, i) =>
				i === 40 ? "- [Docs](https://example.com/docs)" : `- Item ${i}`,
			).join("\n");
		const onOpenExternal = vi.fn();
		const view = render(
			<SafeMarkdown markdown={markdown(64)} onOpenExternal={onOpenExternal} />,
		);
		const link = screen.getByRole("button", { name: "Docs" });
		act(() => link.focus());
		view.rerender(
			<SafeMarkdown
				markdown={markdown(2000)}
				onOpenExternal={onOpenExternal}
			/>,
		);
		expect(screen.getByRole("button", { name: "Docs" })).toBe(link);
		expect(document.activeElement).toBe(link);
		act(() => {
			document.documentElement.scrollTop = 28_000;
			fireEvent.scroll(window);
		});
		expect(document.activeElement).toBe(link);
		act(() => link.blur());
		expect(screen.queryByRole("button", { name: "Docs" })).toBeNull();
	});
});
