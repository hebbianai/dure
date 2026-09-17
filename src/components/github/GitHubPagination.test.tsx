// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "@/lib/i18n";
import { GitHubPagination } from "./GitHubPagination";

beforeEach(() => setLang("en"));
afterEach(() => {
	cleanup();
	setLang("ko");
});
describe("GitHub pagination navigation", () => {
	it("jumps directly to the last page and cannot move outside the bounds", () => {
		const onChange = vi.fn();
		const props = {
			total: 325,
			page: 1,
			compact: false,
			limited: false,
			disabled: false,
			onChange,
		};
		const { rerender } = render(<GitHubPagination {...props} />);
		fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Page 13" }));
		expect(onChange).toHaveBeenCalledWith(13);
		rerender(<GitHubPagination {...props} page={13} />);
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(
			screen
				.getByRole("button", { name: "Page 13" })
				.getAttribute("aria-current"),
		).toBe("page");
	});
	it("disables compact navigation while a query is pending and discloses bounded results", () => {
		const onChange = vi.fn();
		render(
			<GitHubPagination
				total={1000}
				page={3}
				compact
				limited
				disabled
				onChange={onChange}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByText("51–75 of 1000 loaded")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toContain("1,000");
	});
});
