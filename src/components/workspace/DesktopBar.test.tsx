// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/usage/ResourceMonitor", () => ({
	ResourceMonitor: () => null,
}));
vi.mock("@/components/usage/UsageBadge", () => ({
	UsageBadge: () => null,
}));
vi.mock("@/lib/workspace/dock", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/workspace/dock")>();
	return { ...original, markDesktopStartsEmpty: vi.fn() };
});

import { DesktopBar } from "@/components/workspace/DesktopBar";
import { markDesktopStartsEmpty } from "@/lib/workspace/dock";
import { setLang } from "@/lib/i18n";
import {
	DEFAULT_TERMINAL_FONT_SIZE,
} from "@/lib/terminal/renderer/terminalFont";
import { DEFAULT_UI_PREFS, useStore } from "@/store";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { createDockviewGridRow } from "@/test/dockviewGridRow";

beforeEach(() => {
	setLang("en");
	useStore.setState({
		terminalFontSize: 12.5,
		uiPrefs: {
			...DEFAULT_UI_PREFS,
			terminalLineHeight: 1.25,
			interfaceMode: "pro",
		},
	});
});

afterEach(() => {
	cleanup();
	vi.mocked(markDesktopStartsEmpty).mockClear();
	useStore.setState({
		terminalFontSize: 12.5,
		uiPrefs: { ...DEFAULT_UI_PREFS },
	});
});

describe("DesktopBar keyboard navigation", () => {
	let previous: ReturnType<typeof useStore.getState>;
	beforeEach(() => {
		previous = useStore.getState();
		useStore.setState({
			spaces: [
				{ id: "keys-first", name: "First" },
				{ id: "keys-second", name: "Second" },
			],
			activeSpaceId: "keys-first",
			shortcutOverrides: {},
		});
	});
	afterEach(() => useStore.setState(previous));

	it.each([
		{ metaKey: true, altKey: true },
		{ ctrlKey: true, altKey: true },
		{ metaKey: true },
		{ altKey: true },
		{ shiftKey: true },
	])("does not treat modified arrows as Space tab navigation: %o", (modifiers) => {
		render(<DesktopBar />);
		const first = screen.getAllByRole("tab")[0];
		first.focus();
		for (const key of ["ArrowLeft", "ArrowRight"]) {
			fireEvent.keyDown(first, { key, ...modifiers });
			expect(useStore.getState().activeSpaceId).toBe("keys-first");
			expect(document.activeElement).toBe(first);
		}
	});

	it("keeps unmodified tab navigation and Command-number Space selection", () => {
		render(<DesktopBar />);
		const [first, second] = screen.getAllByRole("tab");
		fireEvent.keyDown(first, { key: "ArrowRight" });
		expect(useStore.getState().activeSpaceId).toBe("keys-second");
		fireEvent.keyDown(second, { key: "ArrowLeft" });
		expect(useStore.getState().activeSpaceId).toBe("keys-first");
		fireEvent.keyDown(window, { key: "2", metaKey: true });
		expect(useStore.getState().activeSpaceId).toBe("keys-second");
	});
});

describe("DesktopBar tab strip scrolling", () => {
	let previous: ReturnType<typeof useStore.getState>;
	beforeEach(() => {
		previous = useStore.getState();
		useStore.setState({
			spaces: [
				{ id: "strip-first", name: "First" },
				{ id: "strip-second", name: "Second" },
			],
			activeSpaceId: "strip-first",
			shortcutOverrides: {},
		});
	});
	afterEach(() => useStore.setState(previous));

	it("turns a wheel's vertical delta into sideways scroll once the tabs overflow", () => {
		render(<DesktopBar />);
		const strip = screen.getByRole("tablist");
		// jsdom lays nothing out: stand in for an overflowing strip.
		let scrollLeft = 0;
		Object.defineProperty(strip, "scrollLeft", {
			configurable: true,
			get: () => scrollLeft,
			set: (value: number) => {
				scrollLeft = value;
			},
		});
		Object.defineProperty(strip, "clientWidth", { configurable: true, value: 300 });
		Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 300 });
		// A strip that fits ignores the wheel.
		fireEvent.wheel(strip, { deltaY: 40 });
		expect(scrollLeft).toBe(0);
		Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 600 });
		fireEvent.wheel(strip, { deltaY: 40 });
		expect(scrollLeft).toBe(40);
		// A sideways swipe already scrolls natively; nothing is added to it.
		fireEvent.wheel(strip, { deltaX: 10, deltaY: 40 });
		expect(scrollLeft).toBe(40);
	});

	it("reveals the tab of the Space that became active, clear of the edge", () => {
		const revealed: HTMLElement[] = [];
		const original = HTMLElement.prototype.scrollIntoView;
		HTMLElement.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) {
			revealed.push(this);
		});
		try {
			render(<DesktopBar />);
			revealed.length = 0;
			fireEvent.keyDown(window, { key: "2", metaKey: true });
			expect(useStore.getState().activeSpaceId).toBe("strip-second");
			expect(revealed).toEqual([screen.getAllByRole("tab")[1]]);
			expect(HTMLElement.prototype.scrollIntoView).toHaveBeenLastCalledWith({
				inline: "nearest",
				block: "nearest",
			});
			// The tab keeps the fade's width between itself and the edge.
			expect(screen.getAllByRole("tab")[1].className).toContain("scroll-mx-16");
		} finally {
			HTMLElement.prototype.scrollIntoView = original;
		}
	});
});

describe("DesktopBar tab menu", () => {
	const disposers: (() => void)[] = [];
	let previous: ReturnType<typeof useStore.getState>;
	beforeEach(() => {
		previous = useStore.getState();
		useStore.setState({ shortcutOverrides: {} });
	});
	afterEach(() => {
		for (const dispose of disposers.splice(0)) dispose();
		useStore.setState(previous);
	});

	// Dockview's own panel tabs carry role="tab" too; read the strip's only.
	const stripTabs = () =>
		within(screen.getByRole("tablist", { name: "Desktops" })).getAllByRole("tab");

	function space(id: string) {
		const row = createDockviewGridRow([`${id}-a`, `${id}-b`], { width: 1200 });
		row.panels[0].group.api.setSize({ width: 900 });
		registerDockview(id, row.api);
		disposers.push(() => {
			unregisterDockview(id, row.api);
			row.dispose();
		});
		return row;
	}

	it("balances the active Space's panes on ⌘⇧B", () => {
		const first = space("chord-first");
		const second = space("chord-second");
		useStore.setState({
			spaces: [
				{ id: "chord-first", name: "First" },
				{ id: "chord-second", name: "Second" },
			],
			activeSpaceId: "chord-second",
			layouts: {
				"chord-first": first.api.toJSON(),
				"chord-second": second.api.toJSON(),
			},
		});
		render(<DesktopBar />);
		fireEvent.keyDown(window, { key: "B", metaKey: true, shiftKey: true });
		expect(first.widths()).toEqual([900, 300]);
		expect(second.widths()).toEqual([600, 600]);
	});

	it("balances the active Space's panes from its tab menu and persists only that layout", () => {
		const first = space("balance-first");
		const second = space("balance-second");
		useStore.setState({
			spaces: [
				{ id: "balance-first", name: "First" },
				{ id: "balance-second", name: "Second" },
			],
			activeSpaceId: "balance-second",
			layouts: {
				"balance-first": first.api.toJSON(),
				"balance-second": second.api.toJSON(),
			},
		});
		const firstSaved = useStore.getState().layouts["balance-first"];
		render(<DesktopBar />);
		const active = second.api.activePanel;
		fireEvent.contextMenu(stripTabs()[1]);
		fireEvent.click(
			screen.getByRole("menuitem", { name: "Balance panes in current Space" }),
		);
		expect(first.widths()).toEqual([900, 300]);
		expect(second.widths()).toEqual([600, 600]);
		expect(second.api.activePanel).toBe(active);
		expect(useStore.getState().layouts["balance-first"]).toBe(firstSaved);
		expect(useStore.getState().layouts["balance-second"]).toEqual(
			second.api.toJSON(),
		);
	});

	it("does not touch another mounted Space when the active Space is unmounted", () => {
		const other = space("balance-other");
		useStore.setState({
			spaces: [
				{ id: "balance-missing", name: "Missing" },
				{ id: "balance-other", name: "Other" },
			],
			activeSpaceId: "balance-missing",
		});
		render(<DesktopBar />);
		fireEvent.contextMenu(stripTabs()[0]);
		fireEvent.click(
			screen.getByRole("menuitem", { name: "Balance panes in current Space" }),
		);
		expect(other.widths()).toEqual([900, 300]);
	});

	it("offers balancing only on the active tab, with rename and close beside it", async () => {
		useStore.setState({
			spaces: [
				{ id: "menu-first", name: "First" },
				{ id: "menu-second", name: "Second" },
			],
			activeSpaceId: "menu-first",
		});
		render(<DesktopBar />);
		fireEvent.contextMenu(stripTabs()[1]);
		expect(
			screen
				.getByRole("menuitem", { name: "Balance panes in current Space" })
				.getAttribute("aria-disabled"),
		).toBe("true");
		expect(screen.getByRole("menuitem", { name: "Close desktop" })).toBeTruthy();
		fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
		// The name input opens once the menu has finished closing (its focus
		// return runs a tick later), so wait for it.
		const input = (await screen.findByRole("textbox", {
			name: "Name",
		})) as HTMLInputElement;
		expect(input.value).toBe("Second");
		fireEvent.change(input, { target: { value: "Renamed" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(useStore.getState().spaces[1]?.name).toBe("Renamed");
	});
});

describe("DesktopBar new-desktop affordance", () => {
	afterEach(() => {
		const kept = useStore.getState().spaces.slice(0, 1);
		useStore.setState({
			spaces: kept,
			activeSpaceId: kept[0]?.id ?? "",
			sshHosts: [],
		});
	});

	it("names the desktop first — '+' alone creates nothing", () => {
		const before = useStore.getState().spaces.length;
		render(<DesktopBar />);

		fireEvent.click(
			screen.getByRole("button", { name: "New desktop (⌘⇧T)" }),
		);

		// 무엇을 띄울지 고르는 메뉴가 아니라 이름 입력이다(사용자 요청).
		expect(screen.queryByRole("menu")).toBeNull();
		expect(screen.getByLabelText("Workspace name")).toBeTruthy();
		expect(useStore.getState().spaces.length).toBe(before);
	});

	it("creates one empty desktop under the typed name on Enter", () => {
		const before = useStore.getState().spaces.length;
		render(<DesktopBar />);

		fireEvent.click(
			screen.getByRole("button", { name: "New desktop (⌘⇧T)" }),
		);
		const input = screen.getByLabelText("Workspace name");
		fireEvent.change(input, { target: { value: "  planner  " } });
		fireEvent.keyDown(input, { key: "Enter" });

		const spaces = useStore.getState().spaces;
		expect(spaces.length).toBe(before + 1);
		expect(spaces[spaces.length - 1]?.name).toBe("planner");
		// 빈 채로 열린다 — Workspace onReady가 첫 터미널을 열지 않도록 표시된다.
		expect(markDesktopStartsEmpty).toHaveBeenCalledWith(
			spaces[spaces.length - 1]?.id,
		);
	});

	it("creates nothing when the naming is escaped", () => {
		const before = useStore.getState().spaces.length;
		render(<DesktopBar />);

		fireEvent.click(
			screen.getByRole("button", { name: "New desktop (⌘⇧T)" }),
		);
		fireEvent.keyDown(screen.getByLabelText("Workspace name"), {
			key: "Escape",
		});

		expect(useStore.getState().spaces.length).toBe(before);
		expect(markDesktopStartsEmpty).not.toHaveBeenCalled();
	});

	/** 셸을 고르는 메뉴는 사라졌다 — SSH 호스트가 있어도 이름 입력 하나다. */
	it("keeps the naming flow when ssh hosts exist", () => {
		useStore.setState({
			sshHosts: [
				{
					id: "host-1",
					name: "rts",
					host: "rts.example",
					port: 22,
					user: "dev",
					auth: "auto" as const,
				},
			],
		});
		render(<DesktopBar />);

		fireEvent.click(
			screen.getByRole("button", { name: "New desktop (⌘⇧T)" }),
		);

		expect(screen.queryByRole("menu")).toBeNull();
		expect(screen.getByLabelText("Workspace name")).toBeTruthy();
	});
});

describe("DesktopBar terminal typography controls", () => {
	it.each(["basic", "pro"] as const)("adjusts font size in %s mode", (interfaceMode) => {
		useStore.setState({ uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode } });
		render(<DesktopBar />);

		fireEvent.click(screen.getByRole("button", { name: "A+" }));
		expect(useStore.getState().terminalFontSize).toBe(13.5);
		fireEvent.click(screen.getByRole("button", { name: "A-" }));
		expect(useStore.getState().terminalFontSize).toBe(12.5);
		fireEvent.click(screen.getByRole("button", { name: "12.5" }));
		expect(useStore.getState().terminalFontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
	});

	// The line-height stepper left the strip (owner call 2026-09-10): line height
	// is set once, in Settings, while the font size is nudged in the moment.
	it("keeps line height out of the strip", () => {
		render(<DesktopBar />);
		expect(screen.queryByRole("button", { name: "Increase terminal line height" })).toBeNull();
	});

	it("uses the shared tooltip for the font-size control", async () => {
		vi.useFakeTimers();
		try {
			render(<DesktopBar />);

			const fontTrigger = screen
				.getByRole("button", { name: "12.5" })
				.closest("[data-slot='tooltip-trigger']");
			expect(fontTrigger).not.toBeNull();
			expect(fontTrigger?.hasAttribute("title")).toBe(false);

			fireEvent.pointerMove(fontTrigger as Element, {
				pointerType: "mouse",
			});
			await act(() => vi.advanceTimersByTimeAsync(100));
			expect(screen.getByRole("tooltip")).not.toBeNull();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});
