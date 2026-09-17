import { fireEvent, within } from "@testing-library/react";

/** jsdom omits the geometry APIs Radix uses for pointer selection. */
export function openSelect(trigger: HTMLElement) {
	const prototype = trigger.ownerDocument.defaultView!.Element.prototype;
	prototype.hasPointerCapture ??= () => false;
	prototype.setPointerCapture ??= () => {};
	prototype.releasePointerCapture ??= () => {};
	prototype.scrollIntoView ??= () => {};
	fireEvent.keyDown(trigger, { key: "ArrowDown" });
}

/** Exercise the visible listbox, including disabled options and callbacks. */
export function chooseSelectValue(trigger: HTMLElement, value: string) {
	openSelect(trigger);
	const options = within(trigger.ownerDocument.body).getAllByRole("option");
	const option = options.find((item) => item.dataset.value === value);
	if (!option) throw new Error(`Missing select option: ${value}`);
	fireEvent.click(option);
}
