// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSelect } from "@/test/select";
import { SelectField, SelectOption } from "./select-field";

afterEach(cleanup);

function Picker({
	disabled = false,
	onChange = (_value: string) => {},
	toolbar = false,
}) {
	const [value, setValue] = useState("");
	return (
		<SelectField
			aria-label="Model"
			toolbar={toolbar ? { label: "Model", reveal: 0 } : undefined}
			leadingIcon={toolbar ? <span aria-hidden="true">M</span> : undefined}
			value={value}
			disabled={disabled}
			onValueChange={(next) => {
				setValue(next);
				onChange(next);
			}}
		>
			<SelectOption value="">Automatic</SelectOption>
			<SelectOption value=":custom">Custom model</SelectOption>
			<SelectOption value="unavailable" disabled>
				Unavailable
			</SelectOption>
		</SelectField>
	);
}

describe.each([false, true])("SelectField toolbar=%s", (toolbar) => {
	it("selects a value and returns to the empty domain choice without collisions", async () => {
		const onChange = vi.fn();
		render(<Picker toolbar={toolbar} onChange={onChange} />);
		const trigger = screen.getByRole("combobox", { name: "Model" });
		expect(within(trigger).getByText("Automatic")).toBeTruthy();
		openSelect(trigger);
		fireEvent.click(screen.getByRole("option", { name: "Custom model" }));
		expect(onChange).toHaveBeenLastCalledWith(":custom");
		expect(within(trigger).getByText("Custom model")).toBeTruthy();
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		openSelect(trigger);
		fireEvent.click(screen.getByRole("option", { name: "Automatic" }));
		expect(onChange).toHaveBeenLastCalledWith("");
		expect(within(trigger).getByText("Automatic")).toBeTruthy();
	});

	it("keeps disabled choices unavailable and Escape preserves the value", () => {
		const onChange = vi.fn();
		render(<Picker toolbar={toolbar} onChange={onChange} />);
		const trigger = screen.getByRole("combobox", { name: "Model" });
		openSelect(trigger);
		const option = screen.getByRole("option", { name: "Unavailable" });
		expect(option.getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(option);
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(within(trigger).getByText("Automatic")).toBeTruthy();
	});

	it("disables the entire picker while its owner is busy", () => {
		render(<Picker toolbar={toolbar} disabled />);
		const trigger = screen.getByRole("combobox", { name: "Model" });
		expect(trigger.hasAttribute("disabled")).toBe(true);
		openSelect(trigger);
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("places a secondary document's listbox in that same document", () => {
		const frame = document.createElement("iframe");
		document.body.append(frame);
		try {
			const body = frame.contentDocument!.body;
			render(<Picker toolbar={toolbar} />, { container: body });
			openSelect(within(body).getByRole("combobox", { name: "Model" }));
			expect(within(body).getByRole("listbox")).toBeTruthy();
			expect(screen.queryByRole("listbox")).toBeNull();
		} finally {
			cleanup();
			frame.remove();
		}
	});
});

it("keeps a compact picker's hover explanation in its own document", async () => {
	const frame = document.createElement("iframe");
	document.body.append(frame);
	try {
		const body = frame.contentDocument!.body;
		render(<Picker toolbar />, { container: body });
		fireEvent.pointerEnter(
			within(body).getByRole("combobox", { name: "Model" }),
		);
		await waitFor(() => expect(within(body).getByRole("tooltip")).toBeTruthy());
		expect(screen.queryByRole("tooltip")).toBeNull();
	} finally {
		cleanup();
		frame.remove();
	}
});
