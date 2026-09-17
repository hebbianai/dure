/**
 * 그리드 안쪽 경계 드롭 배선 (hebbian-frontend-hv89 2/2).
 *
 * paneInsertion의 판정을 실제 드래그에 연결한다: 컨테이너 dragover(capture)로
 * 경계 밴드를 겨냥하면 자체 오버레이를 그리고, dockview 자신의 그룹 오버레이는
 * onWillShowOverlay.preventDefault()로 물러나게 한 뒤, drop에서 새 그룹을 그
 * 경계 위치에 삽입하고 끌던 패널을 옮긴다.
 *
 * 실행에는 dockview 공개 API에 없는 "위치 지정 그룹 삽입"이 필요해 TS-private
 * 표면(DockviewApi.component → createGroupAtLocation/moveGroupOrPanel)을 런타임
 * feature-detection으로 쓴다. 업그레이드로 표면이 사라지면 기능만 조용히 꺼지고
 * 기본 드롭 동작이 유지된다(fail-open UX, fail-closed 표면 접근). 설치된
 * dockview에 표면이 실재하는지는 테스트가 못박아 업그레이드 시 시끄럽게
 * 실패한다.
 */

import { type DockviewApi, getPanelData } from "dockview-react";
import {
	isNewPaneDrag,
	readDragTypes,
} from "@/lib/platform/productDragPayload";
import { readPaneDragGeometry } from "@/lib/workspace/pane/paneDragGeometry";
import {
	type PaneDropIntent,
	paneDropIntentLabel,
} from "@/lib/workspace/pane/paneDropIntent";
import {
	type InsertionTarget,
	interiorInsertionTarget,
	isNoopSelfInsertion,
	type SerializedGrid,
} from "@/lib/workspace/pane/paneInsertion";
import { PANE_TRANSFER_INPUT_MIMES } from "@/lib/workspace/pane/paneWindowTransfer";

/** dockview TS-private 표면 중 이 기능이 쓰는 부분. 이름이 같아도 옵션 의미가
 *  바뀌는 드리프트는 presence 검사로 못 잡는다 — 그 잔여 위험은 테스트의
 *  트립와이어 주석에 기록돼 있다. */
export interface GridInsertionSurface {
	createGroupAtLocation(location: number[], size?: number): { id: string };
	moveGroupOrPanel(options: {
		from: { groupId: string; panelId?: string };
		to: { group: { id: string }; position: string; index?: number };
		keepEmptyGroups?: boolean;
	}): void;
	/** 실패 롤백용 — 없어도 기능은 성립한다. */
	removeGroup?(group: { id: string }): void;
}

/**
 * DockviewApi 뒤의 컴포넌트에서 삽입 표면을 찾는다. 하나라도 없으면 null —
 * 호출자는 기능을 끄고 dockview 기본 동작에 맡긴다.
 */
export function detectGridInsertionSurface(
	api: DockviewApi,
): GridInsertionSurface | null {
	const component = (api as unknown as { component?: unknown }).component;
	if (typeof component !== "object" || component === null) return null;
	const surface = component as Record<string, unknown>;
	if (typeof surface.createGroupAtLocation !== "function") return null;
	if (typeof surface.moveGroupOrPanel !== "function") return null;
	return component as unknown as GridInsertionSurface;
}

export interface InteriorBoundaryDropOptions {
	api: DockviewApi;
	/** dockview를 감싸는, 그리드와 같은 좌표계의 컨테이너. */
	container: HTMLElement;
	/** 이 데스크탑에서 시작된 pane 드래그의 패널 id. 아니면 null. */
	draggedPanelId: () => string | null;
	/** Synchronously open a validated drop in the newly inserted empty group. */
	dropNewPane?: (event: DragEvent, group: { id: string }) => void;
}

function readGrid(api: DockviewApi, box: DOMRect): SerializedGrid | null {
	const grid = (api.toJSON() as { grid?: SerializedGrid }).grid;
	if (!grid) return null;
	// 저장된 치수 대신 실제 컨테이너 치수를 쓴다 — 판정 모듈이 branch마다
	// 비율 환산하므로 바깥 치수만 실측과 맞추면 좌표계가 일치한다.
	return { ...grid, width: box.width, height: box.height };
}

function isPaneDrag(event: DragEvent): boolean {
	const types = readDragTypes(event);
	return PANE_TRANSFER_INPUT_MIMES.some((mime) => types.includes(mime));
}

/**
 * 안쪽 경계 드롭을 설치한다. 반환값은 해제 함수.
 *
 * 삽입 표면이 없으면(호환 안 되는 dockview) 아무것도 설치하지 않는다 —
 * 경계 밴드를 절대 선점하지 않아 기본 드롭 UX가 그대로 남는다.
 */
export function installInteriorBoundaryDrop(
	options: InteriorBoundaryDropOptions,
): () => void {
	const { api, container, draggedPanelId } = options;
	const surface = detectGridInsertionSurface(api);
	if (!surface) return () => {};
	// Creation needs rollback even when a valid drag now refers to an open pane.
	const dropNewPane = surface.removeGroup ? options.dropNewPane : undefined;

	let overlay: HTMLDivElement | null = null;
	let pending: InsertionTarget | null = null;
	// 드래그 중 레이아웃은 고정이므로 그리드는 드래그 세션당 한 번만 읽는다.
	let gridSnapshot: SerializedGrid | null = null;

	const hideOverlay = () => {
		pending = null;
		if (overlay && overlay.style.display !== "none") {
			overlay.style.display = "none";
		}
	};
	const reset = () => {
		hideOverlay();
		gridSnapshot = null;
	};

	const showOverlay = (target: InsertionTarget) => {
		if (!overlay) {
			overlay = document.createElement("div");
			overlay.className = "pane-boundary-drop-overlay";
			const label = document.createElement("span");
			label.className = "pane-drop-recommendation-label";
			overlay.appendChild(label);
			container.appendChild(overlay);
		}
		const intent: PaneDropIntent =
			target.orientation === "HORIZONTAL" ? "insert-column" : "insert-row";
		// Repeated hover keeps the same boundary. Update only changed DOM values
		// so native drag events do not retrigger recommendation observers.
		if (overlay.dataset.paneDropIntent !== intent) {
			overlay.dataset.paneDropIntent = intent;
		}
		const intentLabel = paneDropIntentLabel(intent);
		const label = overlay.querySelector<HTMLElement>(
			".pane-drop-recommendation-label",
		);
		if (label && intentLabel && label.textContent !== intentLabel) {
			label.textContent = intentLabel;
		}
		const { style } = overlay;
		if (style.display !== "block") style.display = "block";
		if (style.left !== `${target.rect.x}px`) style.left = `${target.rect.x}px`;
		if (style.top !== `${target.rect.y}px`) style.top = `${target.rect.y}px`;
		if (style.width !== `${target.rect.width}px`) {
			style.width = `${target.rect.width}px`;
		}
		if (style.height !== `${target.rect.height}px`) {
			style.height = `${target.rect.height}px`;
		}
	};

	const onDragOver = (event: DragEvent) => {
		const draggedId = draggedPanelId();
		const transfer = getPanelData();
		// Only the matching Dockview-owned drag can skip WebKit's synchronous
		// native type lookup. A remembered pane ID alone also exists for Spaces.
		const localPanel =
			draggedId !== null &&
			transfer?.panelId === draggedId &&
			transfer.viewId === api.id &&
			api.getPanel(draggedId)?.group.id === transfer.groupId;
		const newPane = !localPanel && !!dropNewPane && isNewPaneDrag(event);
		if (!localPanel && !isPaneDrag(event) && !newPane) return;
		const panelId = newPane ? null : draggedId;
		// 다른 창/데스크탑에서 온 드래그는 기존 경로(데스크탑 탭·tear-out)에 맡긴다.
		if (!newPane && (!panelId || !api.getPanel(panelId))) {
			hideOverlay();
			return;
		}
		const box = readPaneDragGeometry(event, container);
		if (!gridSnapshot) gridSnapshot = readGrid(api, box);
		if (!gridSnapshot) {
			hideOverlay();
			return;
		}
		const target = interiorInsertionTarget(gridSnapshot, {
			x: event.clientX - box.left,
			y: event.clientY - box.top,
		});
		// 자기 양옆 경계는 순서가 안 바뀌는 무의미 이동 — 제안 자체가 소음이다
		// (Workspace의 자기 그룹 드롭 억제와 같은 사용자 피드백 원칙).
		if (
			!target ||
			(panelId && isNoopSelfInsertion(gridSnapshot, target, panelId))
		) {
			hideOverlay();
			return;
		}
		pending = target;
		showOverlay(target);
		event.preventDefault();
		// dockview가 dragstart에 effectAllowed='move'를 실어주는 데 기대지 않고
		// 커서·tear-out 판정(dropEffect !== 'none')을 명시로 고정한다.
		if (event.dataTransfer)
			event.dataTransfer.dropEffect = newPane ? "copy" : "move";
	};

	const onDrop = (event: DragEvent) => {
		const target = pending;
		if (!target) return;
		const newPane = !!dropNewPane && isNewPaneDrag(event);
		const panelId = draggedPanelId();
		const panel = panelId ? api.getPanel(panelId) : undefined;
		reset();
		if (!panel && !newPane) return;
		event.preventDefault();
		// dockview의 자체 드롭 처리가 같은 드래그를 이중 소비하지 않게 차단.
		event.stopPropagation();
		const group = surface.createGroupAtLocation([...target.location]);
		try {
			if (newPane) {
				dropNewPane?.(event, group);
			} else if (panel)
				surface.moveGroupOrPanel({
					from: { groupId: panel.group.id, panelId: panel.id },
					to: { group, position: "center" },
					keepEmptyGroups: false,
				});
		} catch (error) {
			// private 표면의 의미 드리프트로 이동이 실패하면 빈 그룹을 남기지
			// 않는다 — 드래그는 조용히 무효가 되고 레이아웃은 원상태다.
			surface.removeGroup?.(group);
			throw error;
		} finally {
			// Invalid payloads and already-open panes do not populate the new group.
			if (newPane && api.getGroup(group.id)?.panels.length === 0) {
				surface.removeGroup?.(group);
			}
		}
	};

	const onDragLeave = (event: DragEvent) => {
		const next = event.relatedTarget;
		if (next instanceof Node && container.contains(next)) return;
		hideOverlay();
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") reset();
	};

	// 경계를 선점한 동안 dockview 자신의 그룹 가장자리 오버레이는 물린다 —
	// 두 제안이 동시에 뜨면 어느 쪽에 놓일지 알 수 없는 UI가 된다.
	const overlaySubscription = api.onWillShowOverlay((event) => {
		if (pending) event.preventDefault();
	});

	// 레이아웃이 바뀌면 스냅샷은 죽은 트리다 — 다음 dragover가 다시 읽는다.
	// (다른 창의 레이아웃 동기화가 드래그 중에도 그리드를 바꿀 수 있다.)
	const layoutSubscription = api.onDidLayoutChange?.(() => {
		gridSnapshot = null;
	});

	// capture: dockview의 dnd 리스너보다 먼저 판정해야 선점이 성립한다.
	container.addEventListener("dragenter", onDragOver, true);
	container.addEventListener("dragover", onDragOver, true);
	container.addEventListener("drop", onDrop, true);
	container.addEventListener("dragleave", onDragLeave);
	// dockview가 드롭을 소비하면 stopPropagation으로 window 'drop'이 안 오고,
	// pane 이동의 DOM reparent는 'dragend'도 삼킬 수 있다(paneTearOut과 같은
	// 결함 모드). 새 드래그 시작이 마지막 안전망으로 이전 세션을 버린다.
	window.addEventListener("dragstart", reset, true);
	window.addEventListener("dragend", reset);
	window.addEventListener("drop", reset);
	window.addEventListener("keydown", onKeyDown);

	return () => {
		overlaySubscription.dispose();
		layoutSubscription?.dispose();
		container.removeEventListener("dragenter", onDragOver, true);
		container.removeEventListener("dragover", onDragOver, true);
		container.removeEventListener("drop", onDrop, true);
		container.removeEventListener("dragleave", onDragLeave);
		window.removeEventListener("dragstart", reset, true);
		window.removeEventListener("dragend", reset);
		window.removeEventListener("drop", reset);
		window.removeEventListener("keydown", onKeyDown);
		overlay?.remove();
		overlay = null;
	};
}
