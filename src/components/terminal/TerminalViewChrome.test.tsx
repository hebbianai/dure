// @vitest-environment jsdom
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { TerminalViewChrome } from "./TerminalViewChrome";
import { setLang } from "@/lib/i18n";
import { registerPaneQuickCommandTarget } from "@/lib/workspace/pane/paneQuickCommandTarget";
import { useStore } from "@/store";

vi.mock("@/store", async () => {
	const { create } = await import("zustand");
	const { createAppPrefsStoreSlice } = await import(
		"@/lib/settings/appPrefsStoreSlice"
	);
	return { useStore: create(createAppPrefsStoreSlice) };
});

beforeEach(() => {
	setLang("en");
	useStore.getState().setUiPrefs({ quickCommands: [] });
});

afterEach(cleanup);

describe("terminal Quick Commands", () => {
	it("reorders saved commands in Manage and retains their order in the reopened menu", async () => {
		const commands = [
			{
				id: "review",
				label: "Review",
				text: "Review\n  carefully\n",
				appendEnter: true,
			},
			{ id: "next", label: "Next", text: "Next task", appendEnter: false },
			{ id: "status", label: "Status", text: "git status", appendEnter: false },
		];
		useStore.getState().setUiPrefs({ quickCommands: commands });
		const deliver = vi.fn(async () => {});
		const unregister = registerPaneQuickCommandTarget("pane-order", deliver);
		const openMenu = async () => {
			fireEvent.contextMenu(screen.getByText("Current pane"));
			fireEvent.keyDown(
				screen.getByRole("menuitem", { name: "Quick Commands" }),
				{ key: "ArrowRight" },
			);
			return screen.findByRole("menuitem", { name: "Manage Quick Commands…" });
		};
		try {
			render(
				<TerminalViewChrome containerRef={createRef()} surfaceId="pane-order">
					<span>Current pane</span>
				</TerminalViewChrome>,
			);
			fireEvent.click(await openMenu());
			await screen.findByRole("dialog");
			const up = screen.getByRole("button", { name: "Move Next up" });
			up.focus();
			fireEvent.click(up);
			expect(useStore.getState().uiPrefs.quickCommands).toEqual([
				commands[1],
				commands[0],
				commands[2],
			]);
			expect(document.activeElement).toBe(up);
			expect(up.getAttribute("aria-disabled")).toBe("true");
			fireEvent.click(up);
			expect(useStore.getState().uiPrefs.quickCommands).toEqual([
				commands[1],
				commands[0],
				commands[2],
			]);
			fireEvent.click(screen.getByRole("button", { name: "Move Review down" }));
			expect(useStore.getState().uiPrefs.quickCommands).toEqual([
				commands[1],
				commands[2],
				commands[0],
			]);
			expect(
				screen
					.getByRole("button", { name: "Move Review down" })
					.getAttribute("aria-disabled"),
			).toBe("true");
			expect(deliver).not.toHaveBeenCalled();
			fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
			await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
			const manage = await openMenu();
			const savedMenu = screen
				.getByRole("menuitem", { name: "Next" })
				.closest('[role="menu"]');
			expect(
				within(savedMenu as HTMLElement)
					.getAllByRole("menuitem")
					.slice(0, 3)
					.map((item) => item.textContent?.replace("↵", "")),
			).toEqual(["Next", "Status", "Review"]);
			fireEvent.click(manage);
			await screen.findByRole("dialog");
			expect(
				screen
					.getAllByRole("listitem")
					.map(
						(item) =>
							within(item).getByText(/^(Next|Status|Review)$/).textContent,
					),
			).toEqual(["Next", "Status", "Review"]);
			expect(deliver).not.toHaveBeenCalled();
		} finally {
			unregister();
		}
	});
	it("offers saved commands from the pane context menu", () => {
		render(
			<TerminalViewChrome
				containerRef={createRef()}
				surfaceId="pane-a"
				onKill={() => {}}
			>
				<span>Current pane</span>
			</TerminalViewChrome>,
		);
		fireEvent.contextMenu(screen.getByText("Current pane"));
		expect(
			screen.getByRole("menuitem", { name: "Quick Commands" }),
		).toBeTruthy();
	});
	it("selects a saved command for the right-clicked pane, not another pane", async () => {
		const command = {
			id: "status",
			label: "Status",
			text: "git status",
			appendEnter: false,
		};
		useStore.getState().setUiPrefs({ quickCommands: [command] });
		const a = vi.fn(async () => {});
		const b = vi.fn(async () => {});
		const removeA = registerPaneQuickCommandTarget("pane-a", a);
		const removeB = registerPaneQuickCommandTarget("pane-b", b);
		try {
			render(
				<TerminalViewChrome containerRef={createRef()} surfaceId="pane-a">
					<span>Current pane</span>
				</TerminalViewChrome>,
			);
			fireEvent.contextMenu(screen.getByText("Current pane"));
			fireEvent.keyDown(
				screen.getByRole("menuitem", { name: "Quick Commands" }),
				{ key: "ArrowRight" },
			);
			fireEvent.click(await screen.findByRole("menuitem", { name: "Status" }));
			await waitFor(() => expect(a).toHaveBeenCalledWith(command));
			expect(b).not.toHaveBeenCalled();
		} finally {
			removeA();
			removeB();
		}
	});
	it("opens an editor after the menu closes and reuses the saved entry", async () => {
		render(
			<TerminalViewChrome containerRef={createRef()} surfaceId="pane-a">
				<span>Current pane</span>
			</TerminalViewChrome>,
		);
		fireEvent.contextMenu(screen.getByText("Current pane"));
		fireEvent.keyDown(
			screen.getByRole("menuitem", { name: "Quick Commands" }),
			{ key: "ArrowRight" },
		);
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "Add Quick Command…" }),
		);
		await screen.findByRole("dialog");
		expect(screen.queryByRole("menu")).toBeNull();
		fireEvent.change(screen.getByLabelText("Label"), {
			target: { value: "Review" },
		});
		fireEvent.change(screen.getByLabelText("Command or prompt"), {
			target: { value: "/goal Review" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		fireEvent.contextMenu(screen.getByText("Current pane"));
		fireEvent.keyDown(
			screen.getByRole("menuitem", { name: "Quick Commands" }),
			{ key: "ArrowRight" },
		);
		expect(
			await screen.findByRole("menuitem", { name: "Review" }),
		).toBeTruthy();
	});
});
