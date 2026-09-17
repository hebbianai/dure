// @vitest-environment jsdom
import type { DockviewApi } from "dockview-react";
import { DockviewApi as RealDockviewApi, DockviewComponent } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	detectGridInsertionSurface,
	installInteriorBoundaryDrop,
} from "@/lib/workspace/pane/paneInsertionDrop";
import { PANE_TRANSFER_MIME } from "@/lib/workspace/pane/paneWindowTransfer";

/** 컬럼 셋: 300/300/400, 높이 600 — paneInsertion.test와 같은 픽스처.
 *  끌던 패널(panel-1)은 세 번째 컬럼(group-1)에 있다. */
const threeColumnGrid = {
	orientation: "HORIZONTAL",
	width: 1000,
	height: 600,
	root: {
		type: "branch",
		size: 600,
		data: [
			{ type: "leaf", size: 300, data: { id: "g-a", views: ["panel-a"] } },
			{ type: "leaf", size: 300, data: { id: "g-b", views: ["panel-b"] } },
			{ type: "leaf", size: 400, data: { id: "group-1", views: ["panel-1"] } },
		],
	},
};

interface FakeSetup {
	api: DockviewApi;
	container: HTMLElement;
	createGroupAtLocation: ReturnType<typeof vi.fn>;
	moveGroupOrPanel: ReturnType<typeof vi.fn>;
	fireWillShowOverlay: (event: { preventDefault: () => void }) => void;
	dispose: () => void;
}

const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	document.body.innerHTML = "";
});

function makeFakeApi(options?: { withSurface?: boolean; panelId?: string }) {
	const { withSurface = true, panelId = "panel-1" } = options ?? {};
	const overlaySubscribers: Array<(e: { preventDefault: () => void }) => void> =
		[];
	const createGroupAtLocation = vi.fn(() => ({ id: "new-group" }));
	const moveGroupOrPanel = vi.fn();
	const panel = { id: panelId, group: { id: "group-1" } };
	const api = {
		toJSON: () => ({ grid: threeColumnGrid }),
		getPanel: (id: string) => (id === panelId ? panel : undefined),
		onWillShowOverlay: (fn: (e: { preventDefault: () => void }) => void) => {
			overlaySubscribers.push(fn);
			return { dispose: () => {} };
		},
		component: withSurface
			? { createGroupAtLocation, moveGroupOrPanel }
			: { createGroupAtLocation },
	} as unknown as DockviewApi;
	return {
		api,
		createGroupAtLocation,
		moveGroupOrPanel,
		fireWillShowOverlay: (event: { preventDefault: () => void }) => {
			for (const fn of overlaySubscribers) fn(event);
		},
	};
}

function makeContainer(): HTMLElement {
	const container = document.createElement("div");
	Object.defineProperty(container, "getBoundingClientRect", {
		value: () => ({
			left: 0,
			top: 0,
			x: 0,
			y: 0,
			width: 1000,
			height: 600,
			right: 1000,
			bottom: 600,
			toJSON: () => ({}),
		}),
	});
	document.body.appendChild(container);
	return container;
}

function dragEventAt(
	type: string,
	x: number,
	y: number,
	types: string[] = [PANE_TRANSFER_MIME],
): MouseEvent {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: x,
		clientY: y,
	});
	Object.defineProperty(event, "dataTransfer", { value: { types } });
	return event;
}

function setup(options?: {
	withSurface?: boolean;
	draggedPanelId?: () => string | null;
}): FakeSetup {
	const fake = makeFakeApi({ withSurface: options?.withSurface });
	const container = makeContainer();
	const dispose = installInteriorBoundaryDrop({
		api: fake.api,
		container,
		draggedPanelId: options?.draggedPanelId ?? (() => "panel-1"),
	});
	disposers.push(dispose);
	return { ...fake, container, dispose };
}

function overlayOf(container: HTMLElement): HTMLElement | null {
	return container.querySelector(".pane-boundary-drop-overlay");
}

describe("detectGridInsertionSurface", () => {
	it("component가 없거나 메서드가 빠지면 null — 기능이 꺼진다", () => {
		expect(
			detectGridInsertionSurface({} as unknown as DockviewApi),
		).toBeNull();
		expect(
			detectGridInsertionSurface({
				component: { createGroupAtLocation: () => {} },
			} as unknown as DockviewApi),
		).toBeNull();
	});

	it("실제 DockviewApi의 component 저장 방식과 표면을 그대로 찾는다", () => {
		// 트립와이어: dockview 업그레이드가 private 표면을 바꾸면 여기서
		// 시끄럽게 실패해야 한다 — 런타임에서는 조용히 꺼지기 때문이다.
		const prototype = (
			DockviewComponent as unknown as { prototype: Record<string, unknown> }
		).prototype;
		expect(typeof prototype.createGroupAtLocation).toBe("function");
		expect(typeof prototype.moveGroupOrPanel).toBe("function");
		expect(typeof prototype.createGroup).toBe("function");

		const stub = {
			createGroupAtLocation: () => ({ id: "g" }),
			moveGroupOrPanel: () => {},
		};
		const api = new RealDockviewApi(
			stub as unknown as ConstructorParameters<typeof RealDockviewApi>[0],
		);
		expect(detectGridInsertionSurface(api as unknown as DockviewApi)).toBe(
			stub,
		);
	});
});

describe("installInteriorBoundaryDrop", () => {
	it("does not accept new-pane insertion without empty-group rollback support", () => {
		const { api, createGroupAtLocation } = makeFakeApi();
		const container = makeContainer();
		const dropNewPane = vi.fn();
		disposers.push(installInteriorBoundaryDrop({
			api, container, draggedPanelId: () => null, dropNewPane,
		}));
		const over = dragEventAt("dragover", 300, 300, ["application/x-dure-new-pane"]);
		container.dispatchEvent(over);
		expect(over.defaultPrevented).toBe(false);
		container.dispatchEvent(
			dragEventAt("drop", 300, 300, ["application/x-dure-new-pane"]),
		);
		expect(createGroupAtLocation).not.toHaveBeenCalled();
		expect(dropNewPane).not.toHaveBeenCalled();
	});

	it("경계 밴드 dragover에서 오버레이를 띄우고 드롭을 수락한다", () => {
		const { container } = setup();
		const over = dragEventAt("dragover", 300, 300);
		container.dispatchEvent(over);
		expect(over.defaultPrevented).toBe(true);
		const overlay = overlayOf(container);
		expect(overlay?.style.display).toBe("block");
		expect(overlay?.style.height).toBe("600px");
		expect(overlay?.dataset.paneDropIntent).toBe("insert-column");
		expect(
			overlay?.querySelector(".pane-drop-recommendation-label")?.textContent,
		).toBe("열로 삽입");
	});

	it("경계를 선점한 동안 dockview 자체 오버레이는 preventDefault로 물린다", () => {
		const { container, fireWillShowOverlay } = setup();
		container.dispatchEvent(dragEventAt("dragover", 300, 300));
		const preventDefault = vi.fn();
		fireWillShowOverlay({ preventDefault });
		expect(preventDefault).toHaveBeenCalledTimes(1);
		// 밴드 밖으로 나가면 선점이 풀린다.
		container.dispatchEvent(dragEventAt("dragover", 150, 300));
		fireWillShowOverlay({ preventDefault });
		expect(preventDefault).toHaveBeenCalledTimes(1);
	});

	it("accepts repeated hover at the same boundary without rewriting its overlay", () => {
		const { container, createGroupAtLocation, moveGroupOrPanel } = setup();
		container.dispatchEvent(dragEventAt("dragenter", 300, 200));
		const overlay = overlayOf(container)!;
		const labelText = overlay.firstChild?.firstChild;
		const observer = new MutationObserver(() => {});
		observer.observe(overlay, { attributes: true, childList: true, subtree: true });
		try {
			for (let y = 201; y <= 220; y++) {
				const over = dragEventAt("dragover", 300, y);
				container.dispatchEvent(over);
				expect(over.defaultPrevented).toBe(true);
				expect((over as unknown as DragEvent).dataTransfer?.dropEffect).toBe("move");
			}
			expect(observer.takeRecords()).toHaveLength(0);
			expect(overlay.firstChild?.firstChild).toBe(labelText);
		} finally {
			observer.disconnect();
		}
		container.dispatchEvent(dragEventAt("drop", 300, 220));
		expect(createGroupAtLocation).toHaveBeenCalledWith([1]);
		expect(moveGroupOrPanel).toHaveBeenCalledTimes(1);
		expect(overlay.style.display).toBe("none");
	});

	it("leaves a hidden overlay untouched and shows it again on boundary re-entry", () => {
		const { container } = setup();
		container.dispatchEvent(dragEventAt("dragover", 300, 200));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		const overlay = overlayOf(container)!;
		expect(overlay.style.display).toBe("none");
		const observer = new MutationObserver(() => {});
		observer.observe(overlay, { attributes: true, childList: true, subtree: true });
		try {
			window.dispatchEvent(new Event("dragend"));
			window.dispatchEvent(new Event("dragstart"));
			for (let y = 201; y <= 220; y++) {
				const over = dragEventAt("dragover", 150, y);
				container.dispatchEvent(over);
				expect(over.defaultPrevented).toBe(false);
			}
			expect(observer.takeRecords()).toHaveLength(0);
		} finally {
			observer.disconnect();
		}
		const drop = dragEventAt("drop", 150, 220);
		container.dispatchEvent(drop);
		expect(drop.defaultPrevented).toBe(false);
		container.dispatchEvent(dragEventAt("dragover", 300, 220));
		expect(overlayOf(container)).toBe(overlay);
		expect(overlay.style.display).toBe("block");
	});

	it.each(["dragenter", "dragover"])(
		"inserts on drop after the first %s",
		(type) => {
			const { container, createGroupAtLocation, moveGroupOrPanel } = setup();
			const hover = dragEventAt(type, 300, 300);
			container.dispatchEvent(hover);
			expect(hover.defaultPrevented).toBe(true);
			expect((hover as unknown as DragEvent).dataTransfer?.dropEffect).toBe(
				"move",
			);
			container.dispatchEvent(dragEventAt("drop", 300, 300));
			expect(createGroupAtLocation).toHaveBeenCalledWith([1]);
			expect(moveGroupOrPanel).toHaveBeenCalledWith({
				from: { groupId: "group-1", panelId: "panel-1" },
				to: { group: { id: "new-group" }, position: "center" },
				keepEmptyGroups: false,
			});
			expect(overlayOf(container)?.style.display).toBe("none");
		},
	);

	it.each(["dragenter", "dragover"])("does not intercept file %s", (type) => {
		const { container } = setup();
		const over = dragEventAt(type, 300, 300, ["Files"]);
		container.dispatchEvent(over);
		expect(over.defaultPrevented).toBe(false);
		expect(overlayOf(container)).toBeNull();
	});

	it("다른 창/데스크탑 드래그(패널 미보유)는 기존 경로에 맡긴다", () => {
		const { container } = setup({ draggedPanelId: () => null });
		const over = dragEventAt("dragover", 300, 300);
		container.dispatchEvent(over);
		expect(over.defaultPrevented).toBe(false);
	});

	it("표면이 없으면 설치 자체를 건너뛴다 — 기본 드롭 UX 폴백", () => {
		const { container } = setup({ withSurface: false });
		const over = dragEventAt("dragover", 300, 300);
		container.dispatchEvent(over);
		expect(over.defaultPrevented).toBe(false);
		expect(overlayOf(container)).toBeNull();
	});

	it("dragend는 선점과 그리드 스냅샷을 함께 버린다", () => {
		const { container } = setup();
		container.dispatchEvent(dragEventAt("dragover", 300, 300));
		window.dispatchEvent(new Event("dragend"));
		expect(overlayOf(container)?.style.display).toBe("none");
		const drop = dragEventAt("drop", 300, 300);
		container.dispatchEvent(drop);
		expect(drop.defaultPrevented).toBe(false);
	});

	it("Escape는 삽입 추천과 pending drop을 즉시 버린다", () => {
		const { container } = setup();
		container.dispatchEvent(dragEventAt("dragover", 300, 300));
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(overlayOf(container)?.style.display).toBe("none");
		const drop = dragEventAt("drop", 300, 300);
		container.dispatchEvent(drop);
		expect(drop.defaultPrevented).toBe(false);
	});

	it("새 드래그 시작이 이전 세션의 선점을 버린다 — dragend/drop이 삼켜져도", () => {
		const { container } = setup();
		container.dispatchEvent(dragEventAt("dragover", 300, 300));
		// dockview가 드롭을 소비하면 우리 reset 경로(window drop/dragend)가
		// 안 올 수 있다 — 다음 dragstart가 마지막 안전망이다.
		window.dispatchEvent(new Event("dragstart"));
		const drop = dragEventAt("drop", 300, 300);
		container.dispatchEvent(drop);
		expect(drop.defaultPrevented).toBe(false);
	});

	it("자기 양옆 경계(무의미 이동)는 제안하지 않는다", () => {
		// panel-1은 세 번째 컬럼 — 그 왼쪽 경계(x=600, index 2)는 순서 불변.
		const { container } = setup();
		const over = dragEventAt("dragover", 600, 300);
		container.dispatchEvent(over);
		expect(over.defaultPrevented).toBe(false);
		expect(overlayOf(container)?.style.display ?? "none").toBe("none");
	});

	it("드롭은 stopPropagation으로 dockview의 이중 처리를 막는다", () => {
		const { container } = setup();
		container.dispatchEvent(dragEventAt("dragover", 300, 300));
		const drop = dragEventAt("drop", 300, 300);
		const stop = vi.spyOn(drop, "stopPropagation");
		container.dispatchEvent(drop);
		expect(stop).toHaveBeenCalled();
	});

	it("이동 실패 시 만들다 만 빈 그룹을 롤백한다", () => {
		const fake = makeFakeApi();
		const removeGroup = vi.fn();
		(
			fake.api as unknown as { component: Record<string, unknown> }
		).component.removeGroup = removeGroup;
		fake.moveGroupOrPanel.mockImplementation(() => {
			throw new Error("surface drift");
		});
		const container = makeContainer();
		const dispose = installInteriorBoundaryDrop({
			api: fake.api,
			container,
			draggedPanelId: () => "panel-1",
		});
		disposers.push(dispose);
		container.dispatchEvent(dragEventAt("dragover", 300, 300));
		// 구현은 가시성을 위해 rethrow한다 — jsdom에선 리스너 예외가
		// dispatch 호출자에게 오지 않고 window 'error'로 간다.
		const swallow = (event: Event) => event.preventDefault();
		window.addEventListener("error", swallow);
		container.dispatchEvent(dragEventAt("drop", 300, 300));
		window.removeEventListener("error", swallow);
		expect(removeGroup).toHaveBeenCalledWith({ id: "new-group" });
	});

	it.each(["dragenter", "dragover"])(
		"removes the %s listener and overlay on disposal",
		(type) => {
			const { container, dispose } = setup();
			container.dispatchEvent(dragEventAt("dragover", 300, 300));
			dispose();
			expect(overlayOf(container)).toBeNull();
			const over = dragEventAt(type, 300, 300);
			container.dispatchEvent(over);
			expect(over.defaultPrevented).toBe(false);
		},
	);
});
