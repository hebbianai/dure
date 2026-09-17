// @vitest-environment jsdom
import { createDockview, getPanelData } from "dockview-react";
import { expect, it, vi } from "vitest";
import { DURE_NEW_PANE_DRAG_TYPE } from "@/lib/platform/productDragPayload";
import { getForegroundInteractionBudget } from "@/lib/scheduling/foregroundInteractionBudget";
import {
	FrameBudgetScheduler,
	resetFrameBudgetSchedulerForTest,
} from "@/lib/scheduling/frameBudgetScheduler";
import { createTerminalPresentationQueue } from "@/lib/terminal/presentation/terminalPresentationQueue";
import { installPaneDragBehaviors } from "./paneDragBehaviors";

let clock = 0;

it.each(["panel", "group", "new-pane"] as const)(
	"prioritizes %s hover over background output and catches up after cancellation",
	(kind) => {
		// Keep the real shared notifier and budget; only replace clock delivery.
		clock += 100_000;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		const advance = (ms: number) => {
			clock += ms;
			vi.advanceTimersByTime(ms);
		};
		const scheduler = new FrameBudgetScheduler(
			{
				now: () => clock,
				requestFrame: (callback) =>
					setTimeout(() => callback(clock), 16) as unknown as number,
				cancelFrame: (handle) => clearTimeout(handle),
				setTimeout: (callback, delay) =>
					setTimeout(callback, delay) as unknown as number,
				clearTimeout: (handle) => clearTimeout(handle),
			},
			getForegroundInteractionBudget(),
		);
		resetFrameBudgetSchedulerForTest(scheduler);
		const backgroundCommit = vi.fn();
		const foregroundCommit = vi.fn();
		const background = createTerminalPresentationQueue({
			readRole: () => "background",
			isCurrent: () => true,
			commit: backgroundCommit,
		});
		const foreground = createTerminalPresentationQueue({
			readRole: () => "foreground",
			isCurrent: () => true,
			commit: foregroundCommit,
		});
		const container = document.createElement("div");
		document.body.append(container);
		const api = createDockview(container, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
			}),
		});
		api.layout(1000, 600);
		const source = api.addPanel({ id: "source", component: "terminal" });
		const target = api.addPanel({
			id: "target",
			component: "terminal",
			position: { referencePanel: source, direction: "right" },
		});
		const tab = source.group.element.querySelector<HTMLElement>(
			kind === "group" ? ".dv-void-container" : ".dv-tab",
		)!;
		const stop = installPaneDragBehaviors(api, () => container);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
			new DOMRect(0, 0, 1000, 600),
		);
		const transfer = {
			types: [DURE_NEW_PANE_DRAG_TYPE],
			items: [],
			setData: vi.fn(),
			setDragImage: vi.fn(),
			dropEffect: "none",
		};
		const event = (type: string, types = transfer.types) => {
			const e = new MouseEvent(type, {
				bubbles: true,
				cancelable: true,
				clientX: 750,
				clientY: 300,
			});
			Object.defineProperty(e, "dataTransfer", {
				value: { ...transfer, types },
			});
			return e;
		};
		try {
			// Complete initial reveal and the existing first-background warm-up.
			background.commit("background", 0);
			foreground.commit("foreground", 0);
			background.schedule("background", 0);
			advance(250);
			backgroundCommit.mockClear();
			foregroundCommit.mockClear();
			if (kind !== "new-pane") {
				tab.dispatchEvent(event("dragstart"));
				expect(getPanelData()).toMatchObject({
					groupId: source.group.id,
					panelId: kind === "group" ? null : source.id,
				});
			}
			for (let revision = 1; revision <= 20; revision++) {
				container.dispatchEvent(
					event(revision === 1 ? "dragenter" : "dragover"),
				);
				background.schedule("background", revision);
				foreground.schedule("foreground", revision);
				advance(50);
			}
			expect(foregroundCommit).toHaveBeenCalledTimes(20);
			expect(backgroundCommit).not.toHaveBeenCalled();
			tab.dispatchEvent(event("dragend"));
			advance(300);
			expect(backgroundCommit).toHaveBeenCalledExactlyOnceWith(
				"background",
				20,
			);
			expect(getPanelData()).toBeUndefined();
			expect(api.getPanel(source.id)).toBe(source);
			expect(api.getPanel(target.id)).toBe(target);

			// Files are not pane gestures and must not continually defer output.
			backgroundCommit.mockClear();
			for (let revision = 21; revision <= 40; revision++) {
				container.dispatchEvent(event("dragover", ["Files"]));
				background.schedule("background", revision);
				advance(50);
			}
			expect(backgroundCommit).toHaveBeenCalled();
			advance(300);
			expect(backgroundCommit).toHaveBeenLastCalledWith("background", 40);
		} finally {
			tab.dispatchEvent(event("dragend"));
			advance(0);
			stop();
			api.dispose();
			container.remove();
			background.cancel();
			foreground.cancel();
			resetFrameBudgetSchedulerForTest();
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	},
);
