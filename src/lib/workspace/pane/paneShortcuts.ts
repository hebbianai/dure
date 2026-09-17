// pane 조작 전역 단축키 배선 — 분할(⌘D/⌘⇧D)·포커스 이동(⌘[/⌘], ⌥⌘화살표).
// 카탈로그(lib/settingsShortcuts)와 오버라이드(matchesChord)를 그대로 지나
// 설정 › 단축키에서 재지정할 수 있다. ⌘W(close-pane)와 같은 window 리스너
// 패턴이다.
import { balancePaneSizes } from "@/lib/workspace/pane/paneBalance";
import { commitExplicitDockviewMutation } from "@/lib/workspace/dock/explicitDockviewCommit";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { focusPanelContent, navigateToPanel } from "@/lib/workspace/dock/panelFocusHandoff";
import { orderDesktopTabs } from "@/lib/workspace/desktop/desktopTabOrder";
import {
	openSplitLauncherPanel,
	paneSplitTargetForPanel,
} from "@/lib/workspace/pane/paneSplit";
import type { PaneSplitPaneParams } from "@/lib/workspace/pane/paneSplitTarget";
import {
	matchesChord,
	shortcutChord,
} from "@/lib/settings/shortcutBindings";
import {
	type PaneDirection,
	pickDirectionalPane,
	visiblePaneFromLayout,
} from "@/lib/workspace/pane/paneFocusNavigation";
import { paneFromFocusHistory } from "@/lib/workspace/pane/paneFocusHistory";
import { undoPaneMove } from "@/lib/workspace/pane/paneDragBehaviors";
import { DEFAULT_UI_PREFS, useStore } from "@/store";

function splitActivePane(
	direction: "right" | "below",
	targetDesktopId?: string,
): boolean {
	const state = useStore.getState();
	const desktopId = targetDesktopId ?? state.activeSpaceId;
	const api = getDockview(desktopId);
	const active = api?.activePanel;
	if (!api || !active) return false;
	// PaneChrome·우클릭 분할과 같은 결정 함수 — 실행 위치(로컬/원격 호스트)와
	// 런타임 cwd를 그대로 물려받는다.
	openSplitLauncherPanel(
		desktopId,
		paneSplitTargetForPanel(
			active.api,
			(active.params ?? {}) as PaneSplitPaneParams,
		),
		{ referencePanel: active.api.id, direction },
	);
	return true;
}

function focusPaneDirection(
	direction: PaneDirection,
	targetDesktopId?: string,
): boolean {
	const state = useStore.getState();
	const desktopId = targetDesktopId ?? state.activeSpaceId;
	const api = getDockview(desktopId);
	const activeGroup = api?.activeGroup;
	if (!api || !activeGroup) return false;
	const rects = (api.groups ?? [])
		.filter((group) => group.api.location.type === "grid" && group.api.isVisible)
		.map((group) => {
			const box = group.element.getBoundingClientRect();
			return {
				id: group.id,
				x: box.x,
				y: box.y,
				width: box.width,
				height: box.height,
			};
		});
	const targetId = pickDirectionalPane(rects, activeGroup.id, direction);
	if (!targetId) {
		// Popout shortcuts must never steer the main window's Space selection.
		if (
			targetDesktopId !== undefined ||
			(direction !== "left" && direction !== "right")
		) {
			return false;
		}
		const spaces = orderDesktopTabs(
			state.spaces.filter((space) => space.kind !== "popout"),
			state.uiPrefs?.tabOrder ?? DEFAULT_UI_PREFS.tabOrder,
			state.spaceVisits,
		);
		const index = spaces.findIndex((space) => space.id === desktopId);
		const next = spaces[index + (direction === "right" ? 1 : -1)];
		if (index < 0 || !next) return false;
		const nextApi = getDockview(next.id);
		// Mounted visibility wins over a potentially older saved layout. Warm
		// Spaces may have no DOM geometry until activation, so use model state.
		const groups = nextApi?.groups.filter(
			(group) =>
				group.api.location.type === "grid" &&
				group.api.isVisible &&
				group.activePanel,
		);
		const selected = groups?.find((group) => group.id === nextApi?.activeGroup?.id)
			?? groups?.[0];
		const panelId = nextApi
			? selected?.activePanel?.id
			: visiblePaneFromLayout(state.layouts[next.id]);
		if (panelId) navigateToPanel(next.id, panelId);
		else state.setActiveSpace(next.id);
		return true;
	}
	const target = (api.groups ?? []).find((group) => group.id === targetId);
	if (!target?.activePanel) return false;
	return focusPanelContent(api, target.activePanel.id);
}

export function navigatePaneHistory(
	direction: "back" | "forward",
	targetDesktopId?: string,
): boolean {
	const state = useStore.getState();
	const desktopId = targetDesktopId ?? state.activeSpaceId;
	const api = getDockview(desktopId);
	if (!api) return false;
	const panelId = paneFromFocusHistory(api, direction);
	if (!panelId) return false;
	navigateToPanel(desktopId, panelId);
	return true;
}

export function balanceActiveSpacePanes(): void {
	const desktopId = useStore.getState().activeSpaceId;
	const api = getDockview(desktopId);
	if (!api || api.hasMaximizedGroup() || api.groups.length < 2) return;
	// Branch resizing does not emit Dockview's structural/sash events. Use
	// the existing explicit commit owner to persist and publish this action.
	commitExplicitDockviewMutation({
		desktopId,
		api,
		mutate: () => balancePaneSizes(api),
		targetChangedError: () => new Error("Pane balance target changed"),
	});
}

/** 터미널(xterm textarea)·에디터(contenteditable)·입력창 포커스 중엔
 *  각자의 undo가 우선이다 — 그때 ⌘Z를 가로채면 안 된다. */
function focusOwnsUndo(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target instanceof HTMLInputElement) return true;
	if (target instanceof HTMLTextAreaElement) return true;
	return target.isContentEditable;
}

const ACTIONS: readonly {
	id: string;
	run: (targetDesktopId?: string) => boolean;
}[] = [
	{ id: "focus-pane-previous", run: (d) => navigatePaneHistory("back", d) },
	{ id: "focus-pane-next", run: (d) => navigatePaneHistory("forward", d) },
	{ id: "split-right", run: (d) => splitActivePane("right", d) },
	{ id: "split-below", run: (d) => splitActivePane("below", d) },
	{ id: "focus-pane-left", run: (d) => focusPaneDirection("left", d) },
	{ id: "focus-pane-right", run: (d) => focusPaneDirection("right", d) },
	{ id: "focus-pane-up", run: (d) => focusPaneDirection("up", d) },
	{ id: "focus-pane-down", run: (d) => focusPaneDirection("down", d) },
];

/** window keydown에 pane 단축키를 단다. 반환: 해제 함수.
 *
 *  targetDesktopId: popout 창처럼 창이 한 데스크탑만 그릴 때 넘긴다 —
 *  activeSpaceId(메인 창 기준)를 그대로 쓰면 이 창의 단축키가 다른 창의
 *  pane을 조작한다. */
export function installPaneShortcuts(targetDesktopId?: string): () => void {
	const onKey = (event: KeyboardEvent) => {
		const overrides = useStore.getState().shortcutOverrides;
		// pane 이동 undo — 입력 표면이 undo를 소유 중이면 양보한다.
		if (
			matchesChord(shortcutChord("undo-pane-move", overrides), event) &&
			!focusOwnsUndo(event.target)
		) {
			const api = getDockview(useStore.getState().activeSpaceId);
			if (undoPaneMove(api)) event.preventDefault();
			return;
		}
		for (const action of ACTIONS) {
			if (!matchesChord(shortcutChord(action.id, overrides), event)) continue;
			if (action.run(targetDesktopId)) event.preventDefault();
			return;
		}
	};
	window.addEventListener("keydown", onKey);
	return () => window.removeEventListener("keydown", onKey);
}
