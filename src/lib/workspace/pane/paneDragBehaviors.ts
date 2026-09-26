// pane 드래그 동작 묶음 (사용자 요청 2026-08-01):
// 1) 이동 undo — 드래그 시작 시 레이아웃 스냅샷, 실제 이동이 확정되면
//    스택에 커밋. ⌘Z(undoPaneMove)가 fromJSON으로 복원한다.
// 2) 자기 자신 억제 — 드래그 중인 pane의 원래 그룹 위에서는 드롭 추천
//    오버레이를 띄우지 않는다(놓아도 no-op인 추천은 소음).
// 3) 빈 곳 폴백 — 그리드 pane이 어디에도 안착하지 못하고 워크스페이스
//    안에서 드래그가 끝나면 그 지점에 떠 있는 그룹으로 전환한다.
//    이미 떠 있는 pane에는 적용하지 않는다 — floating 이동은 전용 바의
//    몫이라는 소유자 제약.
import { type DockviewApi, getPanelData } from "dockview-react";
import { t } from "@/lib/i18n";
import { isNewPaneDrag } from "@/lib/platform/productDragPayload";
import { noteUserInput } from "@/lib/scheduling/interactionSignals";
import { installFloatingPaneHeaderDrag } from "@/lib/workspace/pane/floatingPaneHeaderDrag";
import { readPaneDragGeometry } from "@/lib/workspace/pane/paneDragGeometry";
import {
	type PaneDropIntent,
	paneDropIntentLabel,
	resolvePaneDropIntent,
} from "@/lib/workspace/pane/paneDropIntent";
import { rememberPaneFloatAnchorByApi } from "@/lib/workspace/pane/paneFloatAnchor";
import {
	installPaneMoveUndoStack,
	recordPaneMoveSnapshot,
	removePaneMoveUndoStack,
} from "@/lib/workspace/pane/paneMoveUndo";
import { paneDragPerformance } from "@/lib/workspace/performance/paneDragPerformance";

export { undoPaneMove } from "@/lib/workspace/pane/paneMoveUndo";

type LayoutSnapshot = ReturnType<DockviewApi["toJSON"]>;

/** floating 전환 시 생성되는 그룹 크기·커서 그립 오프셋 — 미리보기와 실제
 *  생성이 반드시 같은 값을 써야 한다. */
const FLOAT_SIZE = { width: 560, height: 420 } as const;
const GRIP_OFFSET = { x: 40, y: 16 } as const;

type DockviewEdge = "left" | "right" | "top" | "bottom";

function dockviewEdge(position: string): DockviewEdge | null {
	return position === "left" ||
		position === "right" ||
		position === "top" ||
		position === "bottom"
		? position
		: null;
}

function isActiveRecommendationSurface(
	element: Element,
): element is HTMLElement {
	if (!(element instanceof HTMLElement)) return false;
	// Insertion publishes display; Dockview publishes visibility and removes
	// inactive overlays. Consume those owners' state without flushing style/layout
	// after their writes. An accepted target remains active during its CSS fade;
	// its label inherits that fade instead of becoming a competing float target.
	const { style } = element;
	return style.display !== "none" && style.visibility !== "hidden";
}

function activeRecommendationSurface(
	container: HTMLElement,
	selector: string,
): HTMLElement | null {
	return (
		[...container.querySelectorAll(selector)].find(
			isActiveRecommendationSurface,
		) ?? null
	);
}

export function installPaneDragBehaviors(
	api: DockviewApi,
	getContainer: () => HTMLElement | null,
): () => void {
	installPaneMoveUndoStack(api);
	const container = getContainer();
	const stopFloatingPaneHeaderDrag = container
		? installFloatingPaneHeaderDrag(container, api)
		: () => {};

	// (1) undo — 스냅샷은 드래그 시작에 찍고 이동이 실제로 일어났을 때만
	// 커밋한다. 취소된 드래그로 복원하면 동일 레이아웃 remount만 생긴다.
	let pending: LayoutSnapshot | null = null;
	let dragged: {
		panelId: string;
		sourceWasGrid: boolean;
		/** floating 전환 존 판정용 — 드래그 시작 시의 원래 그룹 사각형.
		 *  1그룹 1pane(억제 조건 충족)일 때만 채운다. */
		sourceRect: DOMRect | null;
	} | null = null;
	const startRecommendations = () => {
		noteUserInput();
		getContainer()?.toggleAttribute("data-pane-drag-active", true);
	};
	const stopRecommendations = () => {
		getContainer()?.removeAttribute("data-pane-drag-active");
	};
	const willDragPanel = api.onWillDragPanel((event) => {
		paneDragPerformance.begin();
		startRecommendations();
		pending = api.toJSON();
		lastDragOver = null; // 이전 드래그의 마지막 좌표가 새 드래그 판정에 새지 않게
		escCancelled = false;
		observedDrop = null;
		const group = event.panel.group;
		dragged = {
			panelId: event.panel.id,
			sourceWasGrid: group.api.location.type === "grid",
			sourceRect:
				group.panels.length === 1
					? group.element.getBoundingClientRect()
					: null,
		};
	});
	const willDragGroup = api.onWillDragGroup(() => {
		paneDragPerformance.begin();
		startRecommendations();
		pending = api.toJSON();
	});
	const didMove = api.onDidMovePanel(() => {
		paneDragPerformance.end();
		stopRecommendations();
		if (pending) {
			recordPaneMoveSnapshot(api, pending);
			pending = null;
		}
		dragged = null;
		observedDrop = null;
		// 드롭으로 소스 엘리먼트가 재부모화되면 WebKit이 dragend를 안 쏘는
		// 경우가 있다 — dockview의 이동 확정 신호에서도 미리보기를 정리해야
		// 이동 후 고스트가 화면에 남지 않는다 (사용자 제보 2026-08-02).
		lastDragOver = null;
		cancelFallbackRecommendation();
		clearDockviewRecommendation();
	});
	let dockviewPosition: DockviewEdge | null = null;
	let dockviewLabelEpoch = 0;
	let cancelFallbackRecommendation = () => {};
	const clearDockviewRecommendation = () => {
		dockviewLabelEpoch += 1;
		dockviewPosition = null;
		const container = getContainer();
		if (!container) return;
		for (const surface of container.querySelectorAll<HTMLElement>(
			".dv-drop-target-selection, .dv-drop-target-anchor",
		)) {
			delete surface.dataset.paneDropIntent;
			surface.querySelector(".pane-drop-recommendation-label")?.remove();
		}
	};

	// (2) 자기 자신 위 억제 — 1그룹 1pane 세계에서 원래 그룹 위 추천은 no-op.
	// 루트 edge(상단/하단 전체 등) 오버레이는 group이 undefined로 오므로,
	// 포인터가 드래그 중인 pane의 원래 그룹 사각형 안에 있으면 함께 억제한다
	// (사용자 제보 2026-08-01: 자기 pane 위인데 상단 전체 추천이 남음).
	const willShowOverlay = api.onWillShowOverlay((event) => {
		if (event.defaultPrevented) return;
		const transfer = event.options.getData();
		if (
			!transfer &&
			!("dataTransfer" in event.nativeEvent && isNewPaneDrag(event.nativeEvent))
		)
			return;
		const targetGroup = event.options.group;
		if (transfer && targetGroup) {
			if (
				transfer.groupId === targetGroup.id &&
				targetGroup.panels.length === 1
			) {
				event.preventDefault();
				return;
			}
		} else if (transfer) {
			const sourceGroup = (api.groups ?? []).find(
				(group) => group.id === transfer.groupId,
			);
			if (sourceGroup?.panels.length !== 1) return;
			const box = sourceGroup.element.getBoundingClientRect();
			const { clientX, clientY } = event.nativeEvent;
			if (
				clientX >= box.left &&
				clientX <= box.right &&
				clientY >= box.top &&
				clientY <= box.bottom
			) {
				event.preventDefault();
				return;
			}
		}
		const position = dockviewEdge(event.position);
		if (!position) return;
		cancelFallbackRecommendation();
		const epoch = ++dockviewLabelEpoch;
		event.onDidRenderOverlay((surface) => {
			if (epoch !== dockviewLabelEpoch || event.defaultPrevented) return;
			if (!getContainer()?.contains(surface)) return;
			dockviewPosition = position;
			renderRecommendation(surface, position);
		});
	});

	// (3) 원래 pane 밖의 빈 곳 폴백 — dockview가 이동을 확정하지 않은 채(didMove가
	// dragged를 안 비움) 워크스페이스 안에서 드래그가 끝나면 그 지점에 떠 있는
	// 그룹으로 전환한다. dropEffect는 판정에 쓰지 않는다 — dockview가 자기 그룹
	// 위에서도 dragover를 accept해 "none"이 안 오므로 판정 근거가 될 수 없다.
	// 자기 pane 위는 원래 위치 유지 제스처이므로 floating으로 바꾸지 않는다.
	// ESC 취소도 제외한다.
	let escCancelled = false;
	let observedDrop: DragEvent | null = null;
	// WebKit(WKWebView)은 dragend의 client 좌표를 신뢰할 수 없다(뷰포트가
	// 아닌 좌표계로 오거나 0,0). dragover는 모든 엔진에서 뷰포트 좌표가
	// 정확하므로 — dockview 오버레이 배치가 실제 앱에서 맞는 근거 — 드래그
	// 중 마지막 dragover 지점을 기록해 판정과 배치에 쓴다.
	let lastDragOver: { x: number; y: number } | null = null;
	// floating 전환 미리보기 — 놓으면 실제로 뜰 자리(같은 크기·같은 그립
	// 오프셋)에 고스트를 그린다(사용자 요청 2026-08-01: 어디에 뜰지 보이게).
	// 전환이 일어나는 조건(원래 pane 밖 + workspace 안)에서만 보인다.
	let preview: HTMLDivElement | null = null;
	const hidePreview = () => {
		preview?.remove();
		preview = null;
	};
	const showPreview = (x: number, y: number) => {
		if (!preview) {
			preview = document.createElement("div");
			preview.className = "pane-float-preview";
			preview.dataset.paneDropIntent = "float";
			const label = document.createElement("span");
			label.className = "pane-float-preview-label";
			label.textContent = t("workspace.paneDrop.floatHint");
			preview.appendChild(label);
			preview.style.width = `${FLOAT_SIZE.width}px`;
			preview.style.height = `${FLOAT_SIZE.height}px`;
			document.body.appendChild(preview);
		}
		if (preview.style.left !== `${x}px`) preview.style.left = `${x}px`;
		if (preview.style.top !== `${y}px`) preview.style.top = `${y}px`;
	};
	let recommendationEpoch = 0;
	cancelFallbackRecommendation = () => {
		recommendationEpoch += 1;
		hidePreview();
	};
	function renderRecommendation(dockview: HTMLElement, position: DockviewEdge) {
		const intent: PaneDropIntent = `split-${position}`;
		const intentLabel = paneDropIntentLabel(intent);
		if (!intentLabel) return;
		if (dockview.dataset.paneDropIntent !== intent) {
			dockview.dataset.paneDropIntent = intent;
		}
		let label = dockview.querySelector<HTMLElement>(
			".pane-drop-recommendation-label",
		);
		if (!label) {
			label = document.createElement("span");
			label.className = "pane-drop-recommendation-label";
			dockview.appendChild(label);
		}
		if (label.textContent !== intentLabel) label.textContent = intentLabel;
	}
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		paneDragPerformance.end();
		stopRecommendations();
		escCancelled = true;
		recommendationEpoch += 1;
		hidePreview();
		clearDockviewRecommendation();
	};
	const onDragOverCapture = (event: DragEvent) => {
		// Dockview already identifies pane drags within this window, including
		// those originating in another workspace. They are not new-pane payloads.
		const transfer = getPanelData();
		const newPane = !transfer && isNewPaneDrag(event);
		// Pane motion shares typing's foreground budget and bounded catch-up policy.
		if (transfer || dragged || newPane) noteUserInput();
		if (!dragged && !newPane) return;
		paneDragPerformance.record(event);
		lastDragOver = { x: event.clientX, y: event.clientY };
		dockviewPosition = null;
		// Invalidate queued work, but retain the current float until this event's
		// target owner decides whether to move or remove it. Recreating the preview
		// on every native hover needlessly restarts style/layout and CSS transitions.
		recommendationEpoch += 1;
		const container = getContainer();
		if (container) readPaneDragGeometry(event, container);
	};
	const onDragOver = (event: DragEvent) => {
		const newPane = !getPanelData() && isNewPaneDrag(event);
		if (!dragged && !newPane) return;
		const container = getContainer();
		const containerBox = container
			? readPaneDragGeometry(event, container)
			: undefined;
		const sourceBox = dragged?.sourceRect;
		const insideSource =
			!!sourceBox &&
			event.clientX >= sourceBox.left &&
			event.clientX <= sourceBox.right &&
			event.clientY >= sourceBox.top &&
			event.clientY <= sourceBox.bottom;
		const insideWorkspace =
			!!containerBox &&
			event.clientX >= containerBox.left &&
			event.clientX <= containerBox.right &&
			event.clientY >= containerBox.top &&
			event.clientY <= containerBox.bottom;
		if (newPane) {
			if (!insideWorkspace) {
				stopRecommendations();
				cancelFallbackRecommendation();
				clearDockviewRecommendation();
				return;
			}
			startRecommendations();
		}
		if (insideWorkspace && !insideSource) {
			event.preventDefault();
			if (event.dataTransfer)
				event.dataTransfer.dropEffect = newPane ? "copy" : "move";
		}
		// A native listener checkpoint can run microtasks before the next DOM
		// listener. Evaluate fallback only after target owners have handled this
		// event, using the bounds already measured before their overlay writes.
		if (dockviewPosition !== null) return;
		const epoch = ++recommendationEpoch;
		const point = { x: event.clientX, y: event.clientY };
		queueMicrotask(() => {
			if (epoch !== recommendationEpoch || (!dragged && !newPane)) return;
			// Reuse this event's geometry after Dockview updates its overlay. Reading
			// it again here can flush those style/layout writes; the next hover gets
			// fresh bounds in the capture handler, with no cross-event geometry cache.
			const box = dragged?.sourceWasGrid || newPane ? containerBox : undefined;
			const insertion = container
				? activeRecommendationSurface(container, ".pane-boundary-drop-overlay")
				: null;
			const insertionOrientation =
				insertion?.dataset.paneDropIntent === "insert-column"
					? "HORIZONTAL"
					: insertion?.dataset.paneDropIntent === "insert-row"
						? "VERTICAL"
						: null;
			// Insertion already wins over split/float; do not scan lower-priority
			// surfaces until a later event no longer has that visible target.
			const dockview =
				container && !insertionOrientation
					? activeRecommendationSurface(
							container,
							".dv-drop-target-selection, .dv-drop-target-anchor",
						)
					: null;
			const intent = resolvePaneDropIntent({
				insideWorkspace: !!box && insideWorkspace,
				insideSource,
				insertionOrientation,
				dockviewPosition: dockview ? dockviewPosition : null,
			});
			if (
				intent === "float" &&
				box &&
				!container?.querySelector(".dv-drop-target")
			) {
				// 실제 생성 좌표(컨테이너 기준 클램프)와 동일한 계산을 뷰포트로 환산.
				showPreview(
					box.left + Math.max(0, point.x - box.left - GRIP_OFFSET.x),
					box.top + Math.max(0, point.y - box.top - GRIP_OFFSET.y),
				);
			} else {
				hidePreview();
			}
		});
	};
	// dockview가 드롭을 받으면 didMove가 정리하지만, 받지 않는 드롭에서도
	// dragend 유실 대비로 즉시 추천을 정리한다.
	const onDrop = (event: DragEvent) => {
		paneDragPerformance.end();
		stopRecommendations();
		if (dragged) observedDrop = event;
		cancelFallbackRecommendation();
		clearDockviewRecommendation();
	};
	const qaLog = (detail: Record<string, unknown>) => {
		if (!import.meta.env.DEV) return;
		// @/qa가 아니라 qaLog 모듈만 지연 로드한다 — 부트 모듈(@/qa)은 qaSmoke까지
		// 끌고 들어와, 이 lib을 import한 테스트의 환경 해체와 로드가 경합했다
		// (vitest EnvironmentTeardownError 플레이크, 2026-08-03).
		void import("@/lib/qa/qaLog").then(({ qaLog }) =>
			qaLog("paneDragFallback", detail),
		);
	};
	const onDragEnd = (event: DragEvent) => {
		paneDragPerformance.end();
		stopRecommendations();
		const candidate = dragged;
		// Native Escape is consumed by WKWebView's drag loop before a DOM keydown.
		// Unlike a mouse release over an accepted workspace target, it emits no drop.
		// Target handlers run after our capture listener. A target may consume a
		// stale/rejected drop without moving anything; that is not a float request.
		const cancelled =
			escCancelled || !observedDrop || observedDrop.defaultPrevented;
		const over = lastDragOver;
		dragged = null;
		pending = null;
		escCancelled = false;
		observedDrop = null;
		lastDragOver = null;
		recommendationEpoch += 1;
		hidePreview();
		clearDockviewRecommendation();
		if (!candidate?.sourceWasGrid || cancelled) return;
		const container = getContainer();
		const box = container?.getBoundingClientRect();
		const inside = (x: number, y: number) =>
			!!box &&
			x >= box.left &&
			x <= box.right &&
			y >= box.top &&
			y <= box.bottom;
		// dragover 좌표를 우선한다 — WKWebView 실측(2026-08-01)에서 dragend가
		// 컨테이너 "안"이지만 드롭 지점에서 수백 px 어긋난 좌표를 줬다. dragend
		// 좌표는 dragover 기록이 없을 때의 폴백일 뿐이다.
		const point =
			over && inside(over.x, over.y)
				? over
				: inside(event.clientX, event.clientY)
					? { x: event.clientX, y: event.clientY }
					: null;
		if (!box || !point) {
			qaLog({
				verdict: "outside",
				end: [event.clientX, event.clientY],
				over: over ? [over.x, over.y] : null,
				box: box ? [box.left, box.top, box.right, box.bottom] : null,
			});
			return;
		}
		const source = candidate.sourceRect;
		if (
			!source ||
			(point.x >= source.left &&
				point.x <= source.right &&
				point.y >= source.top &&
				point.y <= source.bottom)
		) {
			qaLog({
				verdict: "source",
				panel: candidate.panelId,
				at: [point.x, point.y],
			});
			return;
		}
		const panel = api.getPanel(candidate.panelId);
		if (!panel) return;
		// 전환 전 스냅샷 — 이 폴백도 ⌘Z 대상이다.
		const snapshot = api.toJSON();
		rememberPaneFloatAnchorByApi(api, candidate.panelId);
		api.addFloatingGroup(panel, {
			x: Math.max(0, point.x - box.left - GRIP_OFFSET.x),
			y: Math.max(0, point.y - box.top - GRIP_OFFSET.y),
			...FLOAT_SIZE,
		});
		qaLog({
			verdict: "float",
			panel: candidate.panelId,
			at: [point.x, point.y],
		});
		recordPaneMoveSnapshot(api, snapshot);
	};
	window.addEventListener("dragend", onDragEnd);
	window.addEventListener("dragenter", onDragOverCapture, true);
	window.addEventListener("dragover", onDragOverCapture, true);
	window.addEventListener("dragenter", onDragOver);
	window.addEventListener("dragover", onDragOver);
	window.addEventListener("drop", onDrop, true);
	window.addEventListener("keydown", onKeyDown);

	return () => {
		// A later will-show listener can dispose this projection before rendering.
		dockviewLabelEpoch += 1;
		recommendationEpoch += 1;
		if (dragged) paneDragPerformance.end();
		stopFloatingPaneHeaderDrag();
		willDragPanel.dispose();
		willDragGroup.dispose();
		didMove.dispose();
		willShowOverlay.dispose();
		stopRecommendations();
		window.removeEventListener("dragend", onDragEnd);
		window.removeEventListener("dragenter", onDragOverCapture, true);
		window.removeEventListener("dragover", onDragOverCapture, true);
		window.removeEventListener("dragenter", onDragOver);
		window.removeEventListener("dragover", onDragOver);
		window.removeEventListener("drop", onDrop, true);
		window.removeEventListener("keydown", onKeyDown);
		hidePreview();
		removePaneMoveUndoStack(api);
	};
}
