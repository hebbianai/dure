// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ScrollToLatestButton } from "./ScrollToLatestButton";

afterEach(cleanup);
it("has a named action only while visible", () => {
	const click = vi.fn();
	const view = render(
		<ScrollToLatestButton
			visible={false}
			label="Scroll to bottom"
			onClick={click}
		/>,
	);
	expect(screen.queryByRole("button")).toBeNull();
	view.rerender(
		<ScrollToLatestButton visible label="Scroll to bottom" onClick={click} />,
	);
	fireEvent.click(screen.getByRole("button", { name: "Scroll to bottom" }));
	expect(click).toHaveBeenCalledOnce();
	view.rerender(
		<ScrollToLatestButton visible={false} label="Scroll to bottom" onClick={click} />,
	);
	expect(screen.queryByRole("button")).toBeNull();
	// The exit can still paint, but its action must stop immediately.
	const exiting = screen.getByRole("button", { hidden: true });
	expect((exiting as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(exiting);
	expect(click).toHaveBeenCalledOnce();
});
