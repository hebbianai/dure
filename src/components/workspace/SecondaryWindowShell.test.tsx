// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	setTitle: vi.fn(async () => {}),
	toggleMaximize: vi.fn(async () => {}),
	startDragging: vi.fn(async () => {}),
	startWebviewKeyboardFocus: vi.fn(() => vi.fn()),
	startWindowSync: vi.fn(() => vi.fn()),
	useRootDarkClass: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		setTitle: mocks.setTitle,
		toggleMaximize: mocks.toggleMaximize,
		startDragging: mocks.startDragging,
	}),
}));
vi.mock("@/lib/workspace/window/windows", () => ({
	startWebviewKeyboardFocus: mocks.startWebviewKeyboardFocus,
	startWindowSync: mocks.startWindowSync,
}));
vi.mock("@/lib/theme/themePreference", () => ({
	useRootDarkClass: mocks.useRootDarkClass,
}));
vi.mock("@/components/settings/useAppLanguage", () => ({
	useAppLanguage: () => "ko",
}));
vi.mock("@/components/Toaster", () => ({
	Toaster: () => <div data-testid="toaster" />,
}));

import {
	SecondaryWindowShell,
	useSecondaryWindowBoot,
	windowChromeDragHandler,
} from "@/components/workspace/SecondaryWindowShell";

function BootHarness({ title }: { title: string }) {
	const lang = useSecondaryWindowBoot(title);
	return <span data-testid="lang">{lang}</span>;
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(cleanup);

describe("SecondaryWindowShell", () => {
	it("renders children in a full-viewport column with the window-local Toaster", () => {
		const { container } = render(
			<SecondaryWindowShell className="bg-glass-pane">
				<header>chrome</header>
			</SecondaryWindowShell>,
		);
		const root = container.firstElementChild as HTMLElement;
		expect(root.className).toContain("h-screen");
		expect(root.className).toContain("w-screen");
		expect(root.className).toContain("flex-col");
		// className passthrough wins over the base skin (tailwind-merge).
		expect(root.className).toContain("bg-glass-pane");
		expect(root.className).not.toContain("bg-background");
		expect(root.firstElementChild?.textContent).toBe("chrome");
		expect(screen.getByTestId("toaster")).toBeTruthy();
	});
});

describe("useSecondaryWindowBoot", () => {
	it("wires dark class, language key, focus recovery, store sync and the title", () => {
		const { rerender } = render(<BootHarness title="Diff — a" />);
		expect(mocks.useRootDarkClass).toHaveBeenCalled();
		expect(screen.getByTestId("lang").textContent).toBe("ko");
		expect(mocks.startWebviewKeyboardFocus).toHaveBeenCalledOnce();
		expect(mocks.startWindowSync).toHaveBeenCalledOnce();
		expect(mocks.setTitle).toHaveBeenCalledWith("Diff — a");

		rerender(<BootHarness title="Diff — b" />);
		expect(mocks.setTitle).toHaveBeenLastCalledWith("Diff — b");
		// One-time boot wiring must not rerun on a title change.
		expect(mocks.startWebviewKeyboardFocus).toHaveBeenCalledOnce();
		expect(mocks.startWindowSync).toHaveBeenCalledOnce();
	});
});

describe("windowChromeDragHandler", () => {
	it("drags on press, maximizes on double-click, leaves buttons alone", () => {
		render(
			<header data-testid="strip" onMouseDown={windowChromeDragHandler()}>
				<button type="button">act</button>
			</header>,
		);
		const strip = screen.getByTestId("strip");
		fireEvent.mouseDown(strip, { button: 0, detail: 1 });
		expect(mocks.startDragging).toHaveBeenCalledOnce();
		fireEvent.mouseDown(strip, { button: 0, detail: 2 });
		expect(mocks.toggleMaximize).toHaveBeenCalledOnce();
		fireEvent.mouseDown(screen.getByRole("button"), { button: 0, detail: 2 });
		expect(mocks.toggleMaximize).toHaveBeenCalledOnce();
		expect(mocks.startDragging).toHaveBeenCalledOnce();
	});

	it("routes double-click through the caller's maximize override", () => {
		const onToggleMaximize = vi.fn();
		render(
			<header
				data-testid="strip"
				onMouseDown={windowChromeDragHandler(onToggleMaximize)}
			/>,
		);
		fireEvent.mouseDown(screen.getByTestId("strip"), { button: 0, detail: 2 });
		expect(onToggleMaximize).toHaveBeenCalledOnce();
		expect(mocks.toggleMaximize).not.toHaveBeenCalled();
	});
});
