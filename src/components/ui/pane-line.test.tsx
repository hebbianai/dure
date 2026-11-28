// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FoldLine, PaneLabel } from "@/components/ui/pane-line";

afterEach(cleanup);

const fold = () =>
	screen
		.getByRole("region", { name: "Team" })
		.querySelector("details") as HTMLDetailsElement;

describe("FoldLine", () => {
	it("sums a part up on one line and unfolds to its rows", async () => {
		render(
			<FoldLine aria-label="Team" dot={<span>•</span>} summary="Manages 3">
				<p>Row</p>
			</FoldLine>,
		);
		expect(fold().querySelector("summary")?.textContent).toBe("•Manages 3");
		expect(fold().open).toBe(false);
		fireEvent.click(fold().querySelector("summary") as HTMLElement);
		await waitFor(() => expect(fold().open).toBe(true));
		expect(screen.getByText("Row")).toBeTruthy();
	});

	it("follows a caller that owns whether it is open", async () => {
		const onOpenChange = vi.fn();
		const line = (open: boolean) => (
			<FoldLine
				aria-label="Team"
				summary="Manages 3"
				open={open}
				onOpenChange={onOpenChange}
			>
				<p>Row</p>
			</FoldLine>
		);
		const { rerender } = render(line(false));
		expect(fold().open).toBe(false);
		// The caller opens and closes it without a click.
		rerender(line(true));
		expect(fold().open).toBe(true);
		rerender(line(false));
		expect(fold().open).toBe(false);
		// A click asks the caller.
		fireEvent.click(fold().querySelector("summary") as HTMLElement);
		await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(true));
	});
});

describe("PaneLabel", () => {
	it("names a part as a heading", () => {
		render(<PaneLabel>Conversation</PaneLabel>);
		expect(screen.getByRole("heading", { name: "Conversation" })).toBeTruthy();
	});
});
