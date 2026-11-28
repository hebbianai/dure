// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useHeldWhilePresent } from "@/lib/ui/heldWhilePresent";

/** Rows render nothing once their entry is gone, as an agent row does once
 * its agent is removed, even while the arrangement still holds them. */
function Region({
	order,
	gone = [],
}: {
	order: readonly string[];
	gone?: readonly string[];
}) {
	const { value, region, presence } = useHeldWhilePresent(order);
	return (
		<div data-testid="region" ref={region} {...presence}>
			{value.map((key) =>
				gone.includes(key) ? null : (
					<button key={key} type="button">
						{key}
					</button>
				),
			)}
		</div>
	);
}

function shown(): string[] {
	return screen.getAllByRole("button").map((button) => button.textContent ?? "");
}

const keyboard = () => fireEvent.keyDown(document, { key: "Tab" });
const pointerPress = () => fireEvent.pointerDown(document);

afterEach(cleanup);

describe("useHeldWhilePresent", () => {
	it("shows the latest value while nobody is at the region", () => {
		const { rerender } = render(<Region order={["a", "b"]} />);
		rerender(<Region order={["b", "a"]} />);
		expect(shown()).toEqual(["b", "a"]);
	});

	it("keeps what the pointer arrived to, and applies the change when it leaves", () => {
		const { rerender } = render(<Region order={["a", "b"]} />);
		const region = screen.getByTestId("region");
		fireEvent.pointerEnter(region);
		rerender(<Region order={["b", "a"]} />);
		expect(shown()).toEqual(["a", "b"]);
		act(() => {
			fireEvent.pointerLeave(region);
		});
		expect(shown()).toEqual(["b", "a"]);
	});

	it("holds for keyboard focus, across moves between its rows, after the pointer left", () => {
		const { rerender } = render(<Region order={["a", "b"]} />);
		const region = screen.getByTestId("region");
		const [first, second] = screen.getAllByRole("button");
		keyboard();
		fireEvent.pointerEnter(region);
		act(() => first.focus());
		fireEvent.pointerLeave(region);
		act(() => second.focus());
		rerender(<Region order={["b", "a", "c"]} />);
		expect(shown()).toEqual(["a", "b"]);
		act(() => second.blur());
		expect(shown()).toEqual(["b", "a", "c"]);
	});

	it("does not hold for focus a click left behind once the pointer leaves", () => {
		const { rerender } = render(<Region order={["a", "b"]} />);
		const region = screen.getByTestId("region");
		fireEvent.pointerEnter(region);
		pointerPress();
		act(() => screen.getAllByRole("button")[0].focus());
		act(() => {
			fireEvent.pointerLeave(region);
		});
		rerender(<Region order={["b", "a"]} />);
		expect(shown()).toEqual(["b", "a"]);
	});

	it("does not hold once the focused row is removed", () => {
		const { rerender } = render(<Region order={["a", "b"]} />);
		keyboard();
		act(() => screen.getAllByRole("button")[0].focus());
		rerender(<Region order={["b", "a"]} />);
		expect(shown()).toEqual(["a", "b"]);
		// The focused row's entry goes away: its row renders nothing and takes
		// the focus with it. No blur says so; the change itself releases.
		rerender(<Region order={["b", "c"]} gone={["a"]} />);
		expect(shown()).toEqual(["b", "c"]);
	});
});
