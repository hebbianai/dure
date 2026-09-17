// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	installSashDragHighlight,
	subscribeSashDragTransaction,
} from "@/lib/ui/sashDragHighlight";

function pointerEvent(type: string, button = 0): Event {
	// jsdom엔 PointerEvent가 없다 — 리스너는 target만 보므로 MouseEvent로 충분.
	const event = new MouseEvent(type, { bubbles: true, button });
	Object.defineProperty(event, "pointerId", { value: 7 });
	return event;
}

describe("installSashDragHighlight", () => {
	afterEach(() => {
		vi.useRealTimers();
	});
	it("sash pointerdown~pointerup 동안 드래그 클래스를 유지한다", () => {
		installSashDragHighlight(document);
		const sash = document.createElement("div");
		sash.className = "dv-sash";
		document.body.appendChild(sash);

		sash.dispatchEvent(pointerEvent("pointerdown"));
		expect(sash.classList.contains("dv-sash-dragging")).toBe(true);
		// 드래그 중 포인터가 선을 벗어나도(문서 어딘가의 up) 해제된다
		document.body.dispatchEvent(pointerEvent("pointerup"));
		expect(sash.classList.contains("dv-sash-dragging")).toBe(false);
	});

	it("sash 밖 pointerdown은 무시하고, 중복 설치는 1회만 동작한다", () => {
		installSashDragHighlight(document);
		installSashDragHighlight(document);
		const plain = document.createElement("div");
		document.body.appendChild(plain);
		plain.dispatchEvent(pointerEvent("pointerdown"));
		expect(document.querySelectorAll(".dv-sash-dragging")).toHaveLength(0);
	});

	it("captures the sash pointer until the release reaches Dockview", () => {
		const isolated = document.implementation.createHTMLDocument();
		installSashDragHighlight(isolated);
		const sash = isolated.createElement("div");
		sash.className = "dv-sash";
		const capture = vi.fn();
		const release = vi.fn();
		Object.defineProperty(sash, "setPointerCapture", { value: capture });
		Object.defineProperty(sash, "releasePointerCapture", { value: release });
		isolated.body.appendChild(sash);

		sash.dispatchEvent(pointerEvent("pointerdown"));

		expect(capture).toHaveBeenCalledWith(7);
		isolated.body.dispatchEvent(pointerEvent("pointerup"));
		expect(release).toHaveBeenCalledWith(7);
	});

	it("turns lost pointer capture into Dockview's cancel path", () => {
		const isolated = document.implementation.createHTMLDocument();
		installSashDragHighlight(isolated);
		const sash = isolated.createElement("div");
		sash.className = "dv-sash";
		Object.defineProperty(sash, "setPointerCapture", { value: vi.fn() });
		Object.defineProperty(sash, "releasePointerCapture", { value: vi.fn() });
		isolated.body.appendChild(sash);
		const cancelled = vi.fn();
		isolated.addEventListener("pointercancel", cancelled);

		sash.dispatchEvent(pointerEvent("pointerdown"));
		sash.dispatchEvent(new Event("lostpointercapture"));

		expect(cancelled).toHaveBeenCalledOnce();
		expect(sash.classList.contains("dv-sash-dragging")).toBe(false);
	});

	it("publishes one trailing generation to every document participant", async () => {
		vi.useFakeTimers();
		const isolated = document.implementation.createHTMLDocument();
		const first = { begins: [] as number[], settles: [] as number[] };
		const second = { begins: [] as number[], settles: [] as number[] };
		const unsubscribeFirst = subscribeSashDragTransaction(isolated, {
			begin: (generation) => first.begins.push(generation),
			settle: (generation) => first.settles.push(generation),
		});
		const unsubscribeSecond = subscribeSashDragTransaction(isolated, {
			begin: (generation) => second.begins.push(generation),
			settle: (generation) => second.settles.push(generation),
		});
		const sash = isolated.createElement("div");
		sash.className = "dv-sash";
		isolated.body.appendChild(sash);

		sash.dispatchEvent(pointerEvent("pointerdown"));
		isolated.body.dispatchEvent(pointerEvent("pointerup"));

		expect(first.begins).toHaveLength(1);
		expect(second.begins).toEqual(first.begins);
		expect(first.settles).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
		await vi.waitFor(() => expect(first.settles).toEqual(first.begins));
		expect(first.settles).toEqual(first.begins);
		expect(second.settles).toEqual(first.begins);
		unsubscribeFirst();
		unsubscribeSecond();
	});

	it("replaces a pending finish with the latest document generation", async () => {
		vi.useFakeTimers();
		const isolated = document.implementation.createHTMLDocument();
		const begins: number[] = [];
		const settles: number[] = [];
		const unsubscribe = subscribeSashDragTransaction(isolated, {
			begin: (generation) => begins.push(generation),
			settle: (generation) => settles.push(generation),
		});
		const sash = isolated.createElement("div");
		sash.className = "dv-sash";
		isolated.body.appendChild(sash);

		sash.dispatchEvent(pointerEvent("pointerdown"));
		isolated.body.dispatchEvent(pointerEvent("pointerup"));
		sash.dispatchEvent(pointerEvent("pointerdown"));
		isolated.body.dispatchEvent(pointerEvent("pointerup"));
		await vi.waitFor(() => expect(settles).toHaveLength(1));

		expect(begins).toHaveLength(2);
		expect(settles).toEqual([begins[1]]);
		unsubscribe();
	});

	it("does not start a resize transaction for a secondary-button sash press", () => {
		const isolated = document.implementation.createHTMLDocument();
		const begin = vi.fn();
		const settle = vi.fn();
		const unsubscribe = subscribeSashDragTransaction(isolated, {
			begin,
			settle,
		});
		const sash = isolated.createElement("div");
		sash.className = "dv-sash";
		const capture = vi.fn();
		Object.defineProperty(sash, "setPointerCapture", { value: capture });
		isolated.body.appendChild(sash);

		sash.dispatchEvent(pointerEvent("pointerdown", 2));

		expect(begin).not.toHaveBeenCalled();
		expect(settle).not.toHaveBeenCalled();
		expect(capture).not.toHaveBeenCalled();
		expect(sash.classList.contains("dv-sash-dragging")).toBe(false);
		unsubscribe();
	});

	it.each([
		"pointerup",
		"pointercancel",
		"lostpointercapture",
		"blur",
		"contextmenu",
	])("restores Dockview pane hit targets after %s", async (finishEvent) => {
		vi.useFakeTimers();
		installSashDragHighlight(document);
		const begins: number[] = [];
		const settles: number[] = [];
		const unsubscribe = subscribeSashDragTransaction(document, {
			begin: (generation) => begins.push(generation),
			settle: (generation) => settles.push(generation),
		});
		const container = document.createElement("div");
		document.body.appendChild(container);
		const api = createDockview(container, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
				dispose() {},
			}),
		});
		api.layout(600, 400);
		const left = api.addPanel({
			id: `left-${finishEvent}`,
			component: "test",
		});
		const right = api.addPanel({
			id: `right-${finishEvent}`,
			component: "test",
			position: { referencePanel: left, direction: "right" },
		});
		const sash = container.querySelector<HTMLElement>(".dv-sash");
		if (!sash) throw new Error("Dockview did not create a grid sash");
		Object.defineProperty(sash, "setPointerCapture", { value: vi.fn() });
		Object.defineProperty(sash, "releasePointerCapture", { value: vi.fn() });
		const paneHitTargets = [
			left.group.element.parentElement,
			right.group.element.parentElement,
		];

		sash.dispatchEvent(pointerEvent("pointerdown"));
		expect(
			paneHitTargets.map((element) => element?.style.pointerEvents),
		).toEqual(["none", "none"]);
		const selectionDuringResize = new Event("selectstart", {
			bubbles: true,
			cancelable: true,
		});
		expect(container.dispatchEvent(selectionDuringResize)).toBe(false);
		expect(selectionDuringResize.defaultPrevented).toBe(true);

		if (finishEvent === "lostpointercapture") {
			sash.dispatchEvent(new Event(finishEvent));
		} else if (finishEvent === "blur") {
			window.dispatchEvent(new Event("blur"));
		} else {
			document.body.dispatchEvent(pointerEvent(finishEvent));
		}

		expect(
			paneHitTargets.map((element) => element?.style.pointerEvents),
		).toEqual(["", ""]);
		const selectionAfterResize = new Event("selectstart", {
			bubbles: true,
			cancelable: true,
		});
		expect(container.dispatchEvent(selectionAfterResize)).toBe(true);
		expect(selectionAfterResize.defaultPrevented).toBe(false);
		expect(sash.classList.contains("dv-sash-dragging")).toBe(false);
		expect(begins).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
		await vi.waitFor(() => expect(settles).toEqual(begins));
		expect(settles).toEqual(begins);
		unsubscribe();
		api.dispose();
		container.remove();
	});

	it("keeps one document listener when the installer module reloads", async () => {
		vi.useFakeTimers();
		const isolated = document.implementation.createHTMLDocument();
		const firstModule = await import("@/lib/ui/sashDragHighlight");
		firstModule.installSashDragHighlight(isolated);
		vi.resetModules();
		const reloadedModule = await import("@/lib/ui/sashDragHighlight");
		reloadedModule.installSashDragHighlight(isolated);
		const begins: number[] = [];
		const settles: number[] = [];
		const unsubscribe = reloadedModule.subscribeSashDragTransaction(isolated, {
			begin: (generation) => begins.push(generation),
			settle: (generation) => settles.push(generation),
		});
		const sash = isolated.createElement("div");
		sash.className = "dv-sash";
		const capture = vi.fn();
		Object.defineProperty(sash, "setPointerCapture", { value: capture });
		Object.defineProperty(sash, "releasePointerCapture", { value: vi.fn() });
		isolated.body.appendChild(sash);

		sash.dispatchEvent(pointerEvent("pointerdown"));
		isolated.body.dispatchEvent(pointerEvent("pointerup"));

		expect(capture).toHaveBeenCalledOnce();
		expect(begins).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
		await vi.waitFor(() => expect(settles).toEqual(begins));
		expect(settles).toEqual(begins);
		unsubscribe();
	});
});
