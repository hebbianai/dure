// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PaneActionContextMenu,
	PaneActionDropdown,
	type PaneActionMenuSection,
} from "./PaneActionMenu";

type Surface = "dropdown" | "context";

function Fixture({
	surface,
	onSelect,
	onSubmit,
	onManage,
}: {
	surface: Surface;
	onSelect: () => void;
	onSubmit: (value: string) => void;
	onManage?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const sections: PaneActionMenuSection[] = [
		{
			id: "commands",
			items: [
				{
					id: "quick",
					label: "Quick Commands",
					groups: [
						{
							id: "saved",
							items: [
								{
									id: "review",
									label: "Review",
									deferUntilClosed: true,
									onSelect,
								},
							],
						},
					],
					footer: onManage
						? {
								id: "manage",
								items: [
									{
										id: "manage",
										label: "Manage commands",
										deferUntilClosed: true,
										onSelect: onManage,
									},
								],
							}
						: undefined,
				},
			],
		},
	];
	return (
		<>
			<input aria-label="Other pane" defaultValue="Other draft" />
			<input
				aria-label="Target pane"
				onKeyDown={(event) => {
					if (event.key === "Enter") onSubmit(event.currentTarget.value);
				}}
			/>
			{surface === "dropdown" ? (
				<PaneActionDropdown
					open={open}
					onOpenChange={setOpen}
					trigger={<button type="button">Pane menu</button>}
					sections={sections}
				/>
			) : (
				<PaneActionContextMenu sections={sections}>
					<div>Pane body</div>
				</PaneActionContextMenu>
			)}
		</>
	);
}

async function openCommands(surface: Surface) {
	const returnTarget =
		surface === "dropdown"
			? screen.getByRole("button", { name: "Pane menu" })
			: screen.getByRole("textbox", { name: "Other pane" });
	returnTarget.focus();
	if (surface === "dropdown") {
		fireEvent.keyDown(returnTarget, { key: "Enter" });
	} else {
		fireEvent.contextMenu(screen.getByText("Pane body"));
	}
	const submenu = await screen.findByRole("menuitem", {
		name: "Quick Commands",
	});
	submenu.focus();
	fireEvent.keyDown(submenu, { key: "ArrowRight" });
	const command = await screen.findByRole("menuitem", { name: "Review" });
	command.focus();
	return { command, returnTarget };
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe.each<Surface>(["dropdown", "context"])("%s close focus", (surface) => {
	it.each(["pointer", "keyboard"])(
		"reaches the footer with End and defers its %s action until closed",
		async (selection) => {
			const onSelect = vi.fn();
			const onManage = vi.fn(() =>
				expect(screen.queryByRole("menu")).toBeNull(),
			);
			render(
				<Fixture
					surface={surface}
					onSelect={onSelect}
					onSubmit={vi.fn()}
					onManage={onManage}
				/>,
			);
			const { command } = await openCommands(surface);
			vi.useFakeTimers();
			fireEvent.keyDown(command, { key: "End" });
			await act(() => vi.runAllTimersAsync());
			const footer = screen.getByRole("menuitem", { name: "Manage commands" });
			expect(document.activeElement).toBe(footer);
			if (selection === "pointer") fireEvent.click(footer);
			else fireEvent.keyDown(footer, { key: "Enter" });
			await act(() => vi.runAllTimersAsync());
			expect(onManage).toHaveBeenCalledTimes(1);
			expect(onSelect).not.toHaveBeenCalled();
		},
	);
	it.each(["pointer", "keyboard"])(
		"keeps focus after %s selection so the next Enter submits",
		async (selection) => {
			const onSubmit = vi.fn();
			const onSelect = vi.fn(() => {
				expect(screen.queryByRole("menu")).toBeNull();
				const input = screen.getByRole<HTMLInputElement>("textbox", {
					name: "Target pane",
				});
				// The terminal Quick Command target focuses its input before pasting.
				input.focus();
				input.value = "Review this change";
			});
			render(
				<Fixture surface={surface} onSelect={onSelect} onSubmit={onSubmit} />,
			);
			const { command } = await openCommands(surface);
			vi.useFakeTimers();
			if (selection === "pointer") fireEvent.click(command);
			else fireEvent.keyDown(command, { key: "Enter" });
			await act(() => vi.runAllTimersAsync());

			expect(onSelect).toHaveBeenCalledTimes(1);
			const focused = document.activeElement as HTMLElement;
			fireEvent.keyDown(focused, { key: "Enter" });
			expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Review this change");
			expect(focused).toBe(
				screen.getByRole("textbox", { name: "Target pane" }),
			);
			expect(
				screen.getByRole<HTMLInputElement>("textbox", { name: "Other pane" })
					.value,
			).toBe("Other draft");
		},
	);

	it("preserves normal focus restoration when the deferred action does not focus", async () => {
		const onSelect = vi.fn();
		render(
			<Fixture surface={surface} onSelect={onSelect} onSubmit={vi.fn()} />,
		);
		const { command, returnTarget } = await openCommands(surface);
		vi.useFakeTimers();
		fireEvent.click(command);
		await act(() => vi.runAllTimersAsync());
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(returnTarget);
	});

	it("restores focus without running a command on Escape", async () => {
		const onSelect = vi.fn();
		render(
			<Fixture surface={surface} onSelect={onSelect} onSubmit={vi.fn()} />,
		);
		const { command, returnTarget } = await openCommands(surface);
		vi.useFakeTimers();
		fireEvent.keyDown(command, { key: "Escape" });
		await act(() => vi.runAllTimersAsync());
		expect(screen.queryByRole("menu")).toBeNull();
		expect(onSelect).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(returnTarget);
	});
});
