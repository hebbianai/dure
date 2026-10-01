// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchTooltipDismissal } from "./tooltipDismissal";

afterEach(() => document.body.replaceChildren());

describe("tooltip dismissal", () => {
	it("listens to the trigger's window and removes every listener on retirement", () => {
		const frame = document.createElement("iframe");
		document.body.append(frame);
		const doc = frame.contentDocument!;
		const trigger = doc.createElement("button");
		doc.body.append(trigger);
		const dismiss = vi.fn();
		const stop = watchTooltipDismissal(trigger, dismiss);
		window.dispatchEvent(new Event("blur"));
		expect(dismiss).not.toHaveBeenCalled();
		doc.defaultView!.dispatchEvent(new Event("blur"));
		expect(dismiss).toHaveBeenCalledOnce();
		stop();
		doc.defaultView!.dispatchEvent(new Event("blur"));
		doc.dispatchEvent(new Event("pointerdown"));
		doc.dispatchEvent(new Event("dragstart"));
		expect(dismiss).toHaveBeenCalledOnce();
	});

	it("ignores pointer transit within the document but dismisses when it leaves", () => {
		const trigger = document.createElement("button");
		document.body.append(trigger);
		const dismiss = vi.fn();
		const stop = watchTooltipDismissal(trigger, dismiss);
		trigger.dispatchEvent(
			new MouseEvent("pointerout", {
				bubbles: true,
				relatedTarget: document.body,
			}),
		);
		expect(dismiss).not.toHaveBeenCalled();
		trigger.dispatchEvent(
			new MouseEvent("pointerout", { bubbles: true, relatedTarget: null }),
		);
		expect(dismiss).toHaveBeenCalledOnce();
		stop();
	});

	it("dismisses on hidden documents and scrolling ancestors, not unrelated scrolling", () => {
		const trigger = document.createElement("button");
		const other = document.createElement("div");
		document.body.append(trigger, other);
		const dismiss = vi.fn();
		const stop = watchTooltipDismissal(trigger, dismiss);
		other.dispatchEvent(new Event("scroll"));
		expect(dismiss).not.toHaveBeenCalled();
		document.body.dispatchEvent(new Event("scroll"));
		expect(dismiss).toHaveBeenCalledOnce();
		const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
		document.dispatchEvent(new Event("visibilitychange"));
		expect(dismiss).toHaveBeenCalledTimes(2);
		hidden.mockRestore();
		stop();
	});
});
