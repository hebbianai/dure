// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FoldLine, PaneLine } from "@/components/ui/fold-line";

afterEach(cleanup);

describe("FoldLine", () => {
	it("sums a part up on one line under a hairline and unfolds to its rows", async () => {
		render(
			<FoldLine
				aria-label="Team"
				dot={<span data-testid="dot" />}
				summary="Manages 3"
			>
				<p>Row</p>
			</FoldLine>,
		);
		const part = screen.getByRole("region", { name: "Team" });
		expect(part.className).toContain("border-t");
		const fold = part.querySelector("details") as HTMLDetailsElement;
		expect(fold.querySelector("summary")?.textContent).toBe("Manages 3");
		expect(screen.getByTestId("dot")).toBeTruthy();
		expect(fold.open).toBe(false);
		fireEvent.click(fold.querySelector("summary") as HTMLElement);
		await waitFor(() => expect(fold.open).toBe(true));
	});

	it("leaves whether it is open to a caller that owns it", async () => {
		const onOpenChange = vi.fn();
		const { rerender } = render(
			<FoldLine
				aria-label="Team"
				dot={null}
				summary="Manages 3"
				open
				onOpenChange={onOpenChange}
			>
				<p>Row</p>
			</FoldLine>,
		);
		const fold = screen
			.getByRole("region", { name: "Team" })
			.querySelector("details") as HTMLDetailsElement;
		expect(fold.open).toBe(true);
		fireEvent.click(fold.querySelector("summary") as HTMLElement);
		await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));
		rerender(
			<FoldLine
				aria-label="Team"
				dot={null}
				summary="Manages 3"
				open={false}
				onOpenChange={onOpenChange}
			>
				<p>Row</p>
			</FoldLine>,
		);
		expect(fold.open).toBe(false);
	});
});

describe("PaneLine", () => {
	it("labels a part in the same box as a fold line", () => {
		render(<PaneLine as="h3">Conversation</PaneLine>);
		const label = screen.getByRole("heading", { name: "Conversation" });
		expect(label.className).toContain("border-t");
		expect(label.className).toContain("px-3");
	});
});
