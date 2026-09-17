// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dockviewRegistry } from "@/lib/workspace/dock/dockRegistry";
import { runPaneFocusHistoryScenario } from "./paneFocusHistoryScenario";

const container = () => {
	const element = document.createElement("div");
	document.body.append(element);
	return element;
};
beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		function (this: HTMLElement) {
			const input = this.querySelector("textarea");
			if (!this.classList.contains("dv-groupview") || !input)
				return new DOMRect();
			const title = this.querySelector(".dv-default-tab-content")?.textContent;
			return new DOMRect(
				title === "Second" ? 450 : 0,
				title === "Third" ? 300 : 0,
				450,
				300,
			);
		},
	);
});
const checkpoint = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

it("follows real DOM focus through back, forward, boundaries and a new branch", async () => {
	const observations = await runPaneFocusHistoryScenario(
		container(),
		checkpoint,
	);
	expect(observations).toHaveLength(20);
	expect(observations.every((value) => value.focusInsidePane)).toBe(true);
	expect(dockviewRegistry.has("qa-pane-focus-history")).toBe(false);
});

it("retains the directional target across one window activation without refocusing", async () => {
	let activations = 0;
	const observations = await runPaneFocusHistoryScenario(
		container(),
		checkpoint,
		async (requestFocus, input) => {
			activations += 1;
			window.dispatchEvent(new Event("blur"));
			requestFocus();
			expect(document.activeElement).not.toBe(input);
			window.dispatchEvent(new Event("focus"));
			expect(document.activeElement).toBe(input);
		},
	);
	expect(activations).toBe(1);
	expect(observations).toHaveLength(21);
	expect(observations[observations.length - 1]?.panel).toBe("direction:right");
	expect(dockviewRegistry.has("qa-pane-directional-input")).toBe(false);
});

it("rejects cyclic navigation that incorrectly consumes an empty forward history", async () => {
	const intercept = (event: KeyboardEvent) => {
		if (event.key !== "]") return;
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	window.addEventListener("keydown", intercept, true);
	try {
		await expect(
			runPaneFocusHistoryScenario(container(), checkpoint),
		).rejects.toThrow(
			"forward without history: incorrect shortcut consumption",
		);
		expect(dockviewRegistry.has("qa-pane-focus-history")).toBe(false);
	} finally {
		window.removeEventListener("keydown", intercept, true);
	}
});

it("rejects selection-only navigation when actual DOM focus escapes the pane", async () => {
	let count = 0;
	const outside = document.createElement("input");
	document.body.append(outside);
	await expect(
		runPaneFocusHistoryScenario(container(), async () => {
			await checkpoint();
			if (++count === 2) outside.focus();
		}),
	).rejects.toThrow("initial: expected focused qa:first");
	expect(dockviewRegistry.has("qa-pane-focus-history")).toBe(false);
});
