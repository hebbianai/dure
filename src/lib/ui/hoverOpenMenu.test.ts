import { describe, expect, it, vi } from "vitest";
import {
	createHoverOpenMenu,
	type HoverOpenMenuTimers,
} from "@/lib/ui/hoverOpenMenu";

/** Manual clock: every scheduled callback is addressable so the tests assert
 *  on which transition is pending, not on wall-clock timing. */
function fakeTimers() {
	const scheduled = new Map<number, { run: () => void; ms: number }>();
	let nextHandle = 1;
	const timers: HoverOpenMenuTimers = {
		setTimeout: (run, ms) => {
			const handle = nextHandle++;
			scheduled.set(handle, { run, ms });
			return handle;
		},
		clearTimeout: (handle) => {
			scheduled.delete(handle);
		},
	};
	return {
		timers,
		pending: () => [...scheduled.values()],
		flush: () => {
			const due = [...scheduled.values()];
			scheduled.clear();
			for (const entry of due) entry.run();
		},
	};
}

function harness(initialOpen = false) {
	const clock = fakeTimers();
	let open = initialOpen;
	const setOpen = vi.fn((next: boolean) => {
		open = next;
	});
	const controller = createHoverOpenMenu({
		isOpen: () => open,
		setOpen,
		openDelayMs: 140,
		closeDelayMs: 220,
		timers: clock.timers,
	});
	return { controller, clock, setOpen, isOpen: () => open };
}

describe("createHoverOpenMenu", () => {
	it("opens only after the hover delay elapses", () => {
		const { controller, clock, setOpen, isOpen } = harness();

		controller.pointerEnter();
		expect(setOpen).not.toHaveBeenCalled();
		expect(clock.pending()[0]?.ms).toBe(140);

		clock.flush();
		expect(isOpen()).toBe(true);
	});

	it("drops the pending open when the pointer leaves first", () => {
		const { controller, clock, setOpen } = harness();

		controller.pointerEnter();
		controller.pointerLeave();
		clock.flush();

		// Neither open nor close ran — a pointer crossing the row is not intent.
		expect(setOpen).not.toHaveBeenCalled();
	});

	it("keeps the menu open while the pointer crosses to the surface", () => {
		const { controller, clock, setOpen, isOpen } = harness(true);

		// Leaving the trigger schedules the close…
		controller.pointerLeave();
		expect(clock.pending()[0]?.ms).toBe(220);
		// …and entering the menu content cancels it.
		controller.pointerEnter();
		clock.flush();

		expect(setOpen).not.toHaveBeenCalled();
		expect(isOpen()).toBe(true);
	});

	it("closes after the leave delay once nothing is re-entered", () => {
		const { controller, clock, isOpen } = harness(true);

		controller.pointerLeave();
		clock.flush();

		expect(isOpen()).toBe(false);
	});

	it("lets an explicit close win over a pending hover open", () => {
		const { controller, clock, setOpen, isOpen } = harness();

		controller.pointerEnter();
		// Escape / item select / outside press arrives through Radix.
		controller.setOpen(false);
		clock.flush();

		expect(setOpen).toHaveBeenCalledTimes(1);
		expect(isOpen()).toBe(false);
	});

	it("pins a hover-opened menu on the first press and lets the next press toggle", () => {
		const { controller, clock, setOpen, isOpen } = harness();
		controller.pointerEnter();
		clock.flush();
		expect(isOpen()).toBe(true);
		// The press must be swallowed: the trigger's toggle would close it.
		expect(controller.press()).toBe(true);
		// Pinned: the pointer leaving no longer schedules a close.
		controller.pointerLeave();
		expect(clock.pending()).toEqual([]);
		// The next press is a normal toggle (returns false so Radix closes it).
		expect(controller.press()).toBe(false);
		controller.setOpen(false);
		expect(setOpen).toHaveBeenLastCalledWith(false);
	});

	it("treats a press that opens the menu as a pin from the start", () => {
		const { controller, clock } = harness();
		expect(controller.press()).toBe(false);
		controller.setOpen(true);
		controller.pointerLeave();
		expect(clock.pending()).toEqual([]);
	});

	it("cancels a pending transition on dispose", () => {
		const { controller, clock, setOpen } = harness();

		controller.pointerEnter();
		controller.dispose();
		clock.flush();

		expect(setOpen).not.toHaveBeenCalled();
	});
});
