// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The ranking itself is covered by providerQuickStart.test.ts; here the row is
// simply handed more providers than it has buttons for.
const AVAILABLE = ["claude", "codex", "kimi", "gemini", "cursor"] as const;
vi.mock("@/lib/agents/agentInstalls", () => ({
	useAvailableProviders: () => [...AVAILABLE],
	useQuickStartProviders: (limit: number) => ({
		available: [...AVAILABLE],
		quick: AVAILABLE.slice(0, limit),
	}),
}));

import { SpacesRepositoryActions } from "@/components/spaces/SpacesRepositoryActions";
import type { RepositoryQuickAddTarget } from "@/lib/spaces/repositoryQuickAdd";
import type { Provider } from "@/types";

const TARGET: RepositoryQuickAddTarget = {
	label: "Dure",
	path: "/repo",
	projectId: "p1",
};

function renderActions(
	onAddAgent: (
		target: RepositoryQuickAddTarget,
		provider: Provider,
	) => Promise<void> = vi.fn(async () => {}),
) {
	const onAddTerminal = vi.fn<(target: RepositoryQuickAddTarget) => void>();
	const onAddAgentWithOptions =
		vi.fn<(target: RepositoryQuickAddTarget) => void>();
	render(
		<SpacesRepositoryActions
			target={TARGET}
			onAddTerminal={onAddTerminal}
			onAddAgent={onAddAgent}
			onAddAgentWithOptions={onAddAgentWithOptions}
		/>,
	);
	return { onAddTerminal, onAddAgentWithOptions };
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("SpacesRepositoryActions", () => {
	it("opens a terminal on the repository in one click", () => {
		const { onAddTerminal } = renderActions();

		fireEvent.click(screen.getByRole("button", { name: "터미널 열기" }));

		expect(onAddTerminal).toHaveBeenCalledWith(TARGET);
	});

	it("starts the agent from the inline button in one click", () => {
		const onAddAgent = vi.fn(async () => {});
		renderActions(onAddAgent);

		fireEvent.click(screen.getByRole("button", { name: "여기서 Codex 시작" }));

		expect(onAddAgent).toHaveBeenCalledWith(TARGET, "codex");
	});

	/** Closing the '+' menu hands focus back to its trigger. With the rail
	 *  keyed on `:focus-within`, that programmatic focus kept the buttons up
	 *  after the pointer had left, until the next click anywhere (owner report
	 *  2026-09-03). Visible focus is the keyboard's signal; programmatic focus
	 *  after mouse use is not visible focus. */
	it("stays up for visible focus only, never for a focus the menu handed back", () => {
		renderActions();

		const rail = screen.getByRole("button", { name: "터미널 열기" }).parentElement;
		expect(rail?.className).toContain("group-has-[:focus-visible]/label:flex");
		expect(rail?.className).not.toContain("focus-within");
		const button = screen.getByRole("button", { name: "터미널 열기" });
		expect(button.className).toContain("group-has-[:focus-visible]/rail:w-6");
		expect(button.className).not.toContain("focus-within");
	});

	/** The row carries a prefix inline; everything else stays in the '+' menu,
	 *  which is closed here. Five available providers must not become five
	 *  buttons on a sidebar row. */
	it("carries at most three agent buttons inline", () => {
		renderActions();

		expect(screen.getByRole("button", { name: "여기서 Claude Code 시작" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "여기서 Codex 시작" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "여기서 Kimi Code 시작" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "여기서 Gemini CLI 시작" })).toBeNull();
		expect(screen.queryByRole("button", { name: "여기서 Cursor CLI 시작" })).toBeNull();
	});

	/** Narrow sidebars drop the buttons from the right: each successive button
	 *  needs more room than the one before it, so the first provider is the last
	 *  to disappear and the terminal button outlives them all. */
	it("drops the inline buttons last-added-first as the sidebar narrows", () => {
		renderActions();

		const widthOf = (title: string) => {
			const match = screen
				.getByRole("button", { name: title })
				.className.match(/@min-\[(\d+)px\]\/space-open-rows:flex/);
			return Number(match?.[1]);
		};
		const thresholds = [
			widthOf("터미널 열기"),
			widthOf("여기서 Claude Code 시작"),
			widthOf("여기서 Codex 시작"),
			widthOf("여기서 Kimi Code 시작"),
		];

		expect(thresholds.every(Number.isFinite)).toBe(true);
		expect(thresholds).toEqual([...thresholds].sort((a, b) => a - b));
		expect(new Set(thresholds).size).toBe(thresholds.length);
	});

	it("blocks a second start while one is in flight", async () => {
		let release: () => void = () => {};
		const onAddAgent = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		renderActions(onAddAgent);

		fireEvent.click(screen.getByRole("button", { name: "여기서 Claude Code 시작" }));
		fireEvent.click(screen.getByRole("button", { name: "여기서 Codex 시작" }));
		expect(onAddAgent).toHaveBeenCalledTimes(1);

		// Once the first start settles the row accepts the next one again.
		await act(async () => {
			release();
		});
		fireEvent.click(screen.getByRole("button", { name: "여기서 Codex 시작" }));
		expect(onAddAgent).toHaveBeenCalledTimes(2);
	});
});
