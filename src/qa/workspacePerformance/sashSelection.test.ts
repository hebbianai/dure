// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installSashDragHighlight } from "@/lib/ui/sashDragHighlight";
import { installWorkspacePerformanceSashSelectionProbe } from "./sashSelection";

function pointerEvent(type: string): Event {
	const event = new MouseEvent(type, {
		bubbles: true,
		button: 0,
		buttons: type === "pointerup" ? 0 : 1,
	});
	Object.defineProperty(event, "pointerId", { value: 7 });
	return event;
}

describe("workspace performance sash selection probe", () => {
	it("injects bounded capture fallback evidence and restores the sash", () => {
		const doc = document.implementation.createHTMLDocument();
		const sash = doc.createElement("div");
		const originalPointerCapture = vi.fn();
		Object.defineProperty(sash, "setPointerCapture", {
			configurable: true,
			value: originalPointerCapture,
		});
		doc.body.appendChild(sash);
		const probe = installWorkspacePerformanceSashSelectionProbe(doc, sash, {
			height: 600,
		});

		expect(() => sash.setPointerCapture(1)).toThrowError(
			/workspace performance QA rejected pointer capture/,
		);
		expect(doc.querySelectorAll("[data-selectable]")).toHaveLength(1);
		const blockedStart = new Event("selectstart", {
			bubbles: true,
			cancelable: true,
		});
		blockedStart.preventDefault();
		doc.body.dispatchEvent(blockedStart);
		expect(probe.evidence()).toMatchObject({
			captureFallbackInjected: true,
			selectStartCount: 1,
			blockedSelectStartCount: 1,
			activeSelectionChangeCount: 0,
			finalSelectionTextLength: 0,
		});

		probe.dispose();
		probe.dispose();
		expect(sash.setPointerCapture).toBe(originalPointerCapture);
		expect(doc.querySelectorAll("[data-selectable]")).toHaveLength(0);
		doc.body.dispatchEvent(
			new Event("selectstart", { bubbles: true, cancelable: true }),
		);
		expect(probe.evidence().selectStartCount).toBe(1);
	});

	it("counts only a non-collapsed selection during the active drag", () => {
		installSashDragHighlight(document);
		const sash = document.createElement("div");
		sash.className = "dv-sash";
		document.body.appendChild(sash);
		const probe = installWorkspacePerformanceSashSelectionProbe(
			document,
			sash,
			{ height: 600 },
		);

		sash.dispatchEvent(pointerEvent("pointerdown"));
		document.dispatchEvent(new Event("selectionchange"));
		expect(probe.evidence().activeSelectionChangeCount).toBe(0);

		const selectable = document.querySelector<HTMLElement>("[data-selectable]");
		const text = selectable?.firstChild;
		if (!text) throw new Error("selectable probe text is missing");
		const range = document.createRange();
		range.selectNodeContents(text);
		document.getSelection()?.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
		expect(probe.evidence().activeSelectionChangeCount).toBe(1);

		document.dispatchEvent(pointerEvent("pointerup"));
		document.getSelection()?.removeAllRanges();
		probe.dispose();
		sash.remove();
	});
});
