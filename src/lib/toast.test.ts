import { afterEach, describe, expect, it, vi } from "vitest";
import {
	claimPaneToasts,
	dismissToast,
	showErrorToast,
	showToast,
	subscribeToast,
	type ToastItem,
	toastsForColumn,
} from "@/lib/toast";

function live(): readonly ToastItem[] {
	let seen: readonly ToastItem[] = [];
	subscribeToast((toasts) => {
		seen = toasts;
	})();
	return seen;
}

afterEach(() => {
	for (const toast of live()) dismissToast(toast.id);
	vi.useRealTimers();
});

describe("toast channel", () => {
	it("carries the pane a report belongs to, and the lifetime either way", () => {
		vi.useFakeTimers();
		showToast("plain");
		showToast("quick", 100);
		showToast("in a pane", { paneId: "p1" });
		expect(live().map((t) => [t.text, t.paneId])).toEqual([
			["plain", undefined],
			["quick", undefined],
			["in a pane", "p1"],
		]);
		vi.advanceTimersByTime(150);
		expect(live().map((t) => t.text)).toEqual(["plain", "in a pane"]);
	});

	it("routes a pane's report to its column while one is mounted, else to the workspace", () => {
		showToast("here", { paneId: "p1" });
		showErrorToast("also here", { paneId: "p1" });
		showToast("global");
		const all = live();
		// No column claims p1 yet: the workspace column shows everything.
		expect(toastsForColumn(undefined, all).map((t) => t.text)).toEqual([
			"here",
			"also here",
			"global",
		]);
		const listener = vi.fn();
		const unsubscribe = subscribeToast(listener);
		const release = claimPaneToasts("p1");
		// A claim republishes so the workspace column drops the pane's rows.
		expect(listener).toHaveBeenCalledTimes(2);
		expect(toastsForColumn("p1", live()).map((t) => t.text)).toEqual([
			"here",
			"also here",
		]);
		expect(toastsForColumn(undefined, live()).map((t) => t.text)).toEqual([
			"global",
		]);
		release();
		expect(toastsForColumn(undefined, live()).map((t) => t.text)).toEqual([
			"here",
			"also here",
			"global",
		]);
		unsubscribe();
	});

	it("keeps a pane claimed while any of its columns is mounted", () => {
		showToast("x", { paneId: "p" });
		const first = claimPaneToasts("p");
		const second = claimPaneToasts("p");
		first();
		expect(toastsForColumn(undefined, live())).toEqual([]);
		second();
		expect(toastsForColumn(undefined, live()).map((t) => t.text)).toEqual(["x"]);
	});
});
