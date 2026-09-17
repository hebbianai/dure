// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeMarkdown } from "@/components/common/SafeMarkdown";
import { t } from "@/lib/i18n";

describe("SafeMarkdown", () => {
	afterEach(cleanup);

	it("renders GFM without executing or exposing raw HTML", () => {
		const rendered = render(
			<SafeMarkdown
				markdown={"# Result\n\n- one\n- two\n\n<script>bad()</script>"}
			/>,
		);
		expect(screen.getByRole("heading", { name: "Result" })).toBeTruthy();
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
		expect(rendered.container.querySelector("script")).toBeNull();
		expect(screen.queryByText("<script>bad()</script>")).toBeNull();
	});

	it("opens only explicit HTTP links through the supplied authority", () => {
		const onOpenExternal = vi.fn();
		render(
			<SafeMarkdown
				markdown={"[Docs](https://example.com) [Local](file:///tmp/a)"}
				onOpenExternal={onOpenExternal}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Docs/ }));
		expect(onOpenExternal).toHaveBeenCalledWith("https://example.com");
		expect(screen.queryByRole("button", { name: /Local/ })).toBeNull();
	});

	it("does not fetch remote images while rendering", () => {
		const onOpenExternal = vi.fn();
		const rendered = render(
			<SafeMarkdown
				markdown="![Preview](https://example.com/image.png)"
				onOpenExternal={onOpenExternal}
			/>,
		);
		expect(rendered.container.querySelector("img")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: t("common.openRemoteImage") }),
		);
		expect(onOpenExternal).toHaveBeenCalledWith(
			"https://example.com/image.png",
		);
	});

	it("gives a linked image one navigation action", () => {
		const onOpenExternal = vi.fn();
		const rendered = render(
			<SafeMarkdown
				markdown="[**![Preview](https://example.com/image.png)**](https://example.com/page)"
				onOpenExternal={onOpenExternal}
			/>,
		);
		const buttons = screen.getAllByRole("button");
		expect(buttons).toHaveLength(1);
		expect(rendered.container.querySelector("button button")).toBeNull();
		fireEvent.click(buttons[0]);
		expect(onOpenExternal).toHaveBeenCalledTimes(1);
		expect(onOpenExternal).toHaveBeenCalledWith(
			"https://example.com/image.png",
		);
	});

	it.each([
		{
			kind: "link",
			markdown: "[Docs](https://example.com/docs)",
			buttonName: "Docs",
			url: "https://example.com/docs",
		},
		{
			kind: "image",
			markdown: "![Preview](https://example.com/image.png)",
			buttonName: t("common.openRemoteImage"),
			url: "https://example.com/image.png",
		},
	])(
		"preserves the $kind action across 20 trailing updates",
		({ markdown, buttonName, url }) => {
			const onOpenExternal = vi.fn();
			const { rerender } = render(
				<SafeMarkdown
					markdown={`${markdown}\n\nUpdate 0`}
					onOpenExternal={onOpenExternal}
				/>,
			);
			let previous = screen.getByRole("button", { name: buttonName });
			let replacements = 0;
			for (let update = 1; update <= 20; update += 1) {
				rerender(
					<SafeMarkdown
						markdown={`${markdown}\n\nUpdate ${update}`}
						onOpenExternal={onOpenExternal}
					/>,
				);
				const current = screen.getByRole("button", { name: buttonName });
				if (current !== previous) replacements += 1;
				previous = current;
			}
			expect(replacements).toBe(0);
			expect(screen.getByText("Update 20")).toBeTruthy();
			expect(onOpenExternal).not.toHaveBeenCalled();
			fireEvent.click(previous);
			expect(onOpenExternal).toHaveBeenCalledExactlyOnceWith(url);
		},
	);

	it("uses the latest opener and disables actions when it is removed", () => {
		const markdown =
			"[Docs](https://example.com/docs)\n\n![Preview](https://example.com/image.png)";
		const firstOpener = vi.fn();
		const nextOpener = vi.fn();
		const { rerender, container } = render(
			<SafeMarkdown markdown={markdown} onOpenExternal={firstOpener} />,
		);
		rerender(<SafeMarkdown markdown={markdown} onOpenExternal={nextOpener} />);
		fireEvent.click(screen.getByRole("button", { name: "Docs" }));
		fireEvent.click(
			screen.getByRole("button", { name: t("common.openRemoteImage") }),
		);
		expect(firstOpener).not.toHaveBeenCalled();
		expect(nextOpener.mock.calls).toEqual([
			["https://example.com/docs"],
			["https://example.com/image.png"],
		]);
		rerender(<SafeMarkdown markdown={markdown} />);
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		expect(container.querySelector("a, img")).toBeNull();
	});
});
