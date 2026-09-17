import { describe, expect, it, vi } from "vitest";
import { ForegroundInteractionBudget } from "./foregroundInteractionBudget";

describe("ForegroundInteractionBudget", () => {
	it("extends input pauses but lets a settled switch shorten its safety ceiling", () => {
		let now = 100;
		const budget = new ForegroundInteractionBudget({ now: () => now });

		budget.note("input");
		expect(budget.backgroundPauseRemainingMs()).toBe(100);
		now = 150;
		budget.note("input");
		expect(budget.backgroundPauseRemainingMs()).toBe(100);

		budget.note("desktop-switch-start");
		expect(budget.backgroundPauseRemainingMs()).toBe(2_000);
		now = 200;
		budget.note("desktop-switch-settled");
		expect(budget.backgroundPauseRemainingMs()).toBe(250);
		now = 450;
		expect(budget.isBackgroundPaused()).toBe(false);
	});

	it("notifies independent queue consumers without owning their policy", () => {
		const budget = new ForegroundInteractionBudget({ now: () => 0 });
		const first = vi.fn();
		const second = vi.fn();
		const unsubscribe = budget.subscribe(first);
		budget.subscribe(second);

		budget.note("input");
		unsubscribe();
		budget.note("desktop-switch-settled");

		expect(first).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledTimes(2);
	});
});
