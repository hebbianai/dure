import { isSashDragActive } from "@/lib/ui/sashDragHighlight";

interface WorkspacePerformanceSashBounds {
	readonly height: number;
}

export interface WorkspacePerformanceSashSelectionEvidence {
	readonly captureFallbackInjected: boolean;
	readonly selectStartCount: number;
	readonly blockedSelectStartCount: number;
	readonly activeSelectionChangeCount: number;
	readonly finalSelectionTextLength: number;
}

export interface WorkspacePerformanceSashSelectionProbe {
	evidence(): WorkspacePerformanceSashSelectionEvidence;
	dispose(): void;
}

/** Makes the native sash smoke exercise Dockview's no-capture fallback while a
 * selectable surface records whether browser selection escapes the gesture. */
export function installWorkspacePerformanceSashSelectionProbe(
	doc: Document,
	sash: HTMLElement,
	bounds: WorkspacePerformanceSashBounds,
): WorkspacePerformanceSashSelectionProbe {
	const originalPointerCapture = Object.getOwnPropertyDescriptor(
		sash,
		"setPointerCapture",
	);
	Object.defineProperty(sash, "setPointerCapture", {
		configurable: true,
		value: () => {
			throw new DOMException(
				"workspace performance QA rejected pointer capture",
				"InvalidStateError",
			);
		},
	});
	const selectable = doc.createElement("div");
	selectable.dataset.selectable = "";
	selectable.textContent = "selectable resize boundary probe ".repeat(8);
	selectable.style.position = "absolute";
	selectable.style.left = "0";
	selectable.style.top = `${bounds.height * 0.58 - 18}px`;
	selectable.style.width = "180px";
	selectable.style.height = "36px";
	selectable.style.zIndex = "200";
	selectable.style.overflow = "hidden";
	selectable.style.whiteSpace = "nowrap";
	selectable.style.setProperty("user-select", "text", "important");
	selectable.style.setProperty("-webkit-user-select", "text", "important");
	sash.appendChild(selectable);
	doc.getSelection()?.removeAllRanges();
	let selectStartCount = 0;
	let blockedSelectStartCount = 0;
	let activeSelectionChangeCount = 0;
	let disposed = false;
	const onSelectStart = (event: Event) => {
		selectStartCount += 1;
		if (event.defaultPrevented) blockedSelectStartCount += 1;
	};
	const onSelectionChange = () => {
		const selection = doc.getSelection();
		if (
			isSashDragActive(doc) &&
			selection &&
			selection.rangeCount > 0 &&
			!selection.isCollapsed
		) {
			activeSelectionChangeCount += 1;
		}
	};
	doc.addEventListener("selectstart", onSelectStart);
	doc.addEventListener("selectionchange", onSelectionChange);

	return {
		evidence: () => ({
			captureFallbackInjected: true,
			selectStartCount,
			blockedSelectStartCount,
			activeSelectionChangeCount,
			finalSelectionTextLength: doc.getSelection()?.toString().length ?? 0,
		}),
		dispose: () => {
			if (disposed) return;
			disposed = true;
			doc.removeEventListener("selectstart", onSelectStart);
			doc.removeEventListener("selectionchange", onSelectionChange);
			selectable.remove();
			if (originalPointerCapture) {
				Object.defineProperty(
					sash,
					"setPointerCapture",
					originalPointerCapture,
				);
			} else {
				Reflect.deleteProperty(sash, "setPointerCapture");
			}
		},
	};
}
