// 숨기기 직전 pane의 "원래 자리" 힌트 — 가장 가까운 이웃 그룹과, 그 이웃
// 기준으로 이 pane이 있던 방향. 복원 시 같은 이웃 옆 같은 방향으로 열면
// 대개 원래 슬롯에 돌아온다(이웃이 사라졌으면 기본 배치 폴백).
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import type { HiddenPaneRecord } from "@/lib/workspace/pane/hiddenPanesStore";
import {
	type PaneRect,
	pickDirectionalPane,
} from "@/lib/workspace/pane/paneFocusNavigation";

const DIRECTIONS = ["left", "right", "up", "down"] as const;
/** 이웃이 이 pane의 <이웃 방향>에 있으면, 복원은 이웃 기준 반대쪽이다. */
const RESTORE_SIDE: Record<
	(typeof DIRECTIONS)[number],
	"left" | "right" | "above" | "below"
> = {
	left: "right",
	right: "left",
	up: "below",
	down: "above",
};

export function paneHideAnchor(
	desktopId: string,
	panelId: string,
): HiddenPaneRecord["anchor"] {
	const api = getDockview(desktopId);
	const panel = api?.getPanel(panelId);
	if (!api || !panel) return undefined;
	if (panel.group.api.location.type === "floating") {
		// floating은 hidden 직렬화가 깨져 제거 후 재생성한다 — 현재 rect를
		// 컨테이너 기준 좌표로 기록(.dv-resize-container의 left/top이 그 좌표).
		const host = panel.group.element.closest(".dv-resize-container");
		if (!(host instanceof HTMLElement)) return undefined;
		return {
			floating: {
				x: Number.parseFloat(host.style.left) || 0,
				y: Number.parseFloat(host.style.top) || 0,
				width: host.offsetWidth || 560,
				height: host.offsetHeight || 420,
			},
		};
	}
	const rects: PaneRect[] = (api.groups ?? [])
		.filter((group) => group.api?.location?.type === "grid")
		.map((group) => {
			const box = group.element.getBoundingClientRect();
			return { id: group.id, x: box.x, y: box.y, width: box.width, height: box.height };
		});
	const own = rects.find((rect) => rect.id === panel.group.id);
	if (!own) return undefined;
	const center = (rect: PaneRect) => ({
		x: rect.x + rect.width / 2,
		y: rect.y + rect.height / 2,
	});
	const origin = center(own);
	// 네 방향 후보 중 실제로 가장 가까운 이웃을 고른다 — 방향 순서 첫 히트를
	// 쓰면 대각 반대편이 먼저 걸려 엉뚱한 자리로 복원됐다(사용자 재현).
	let best:
		| { referencePanelId: string; direction: (typeof RESTORE_SIDE)[keyof typeof RESTORE_SIDE]; distance: number }
		| undefined;
	for (const direction of DIRECTIONS) {
		const neighborGroupId = pickDirectionalPane(rects, panel.group.id, direction);
		if (!neighborGroupId) continue;
		const neighborGroup = (api.groups ?? []).find(
			(group) => group.id === neighborGroupId,
		);
		const referencePanelId = neighborGroup?.activePanel?.id;
		const rect = rects.find((candidate) => candidate.id === neighborGroupId);
		if (!referencePanelId || !rect) continue;
		const to = center(rect);
		const distance = Math.hypot(to.x - origin.x, to.y - origin.y);
		if (!best || distance < best.distance) {
			best = { referencePanelId, direction: RESTORE_SIDE[direction], distance };
		}
	}
	return best
		? { referencePanelId: best.referencePanelId, direction: best.direction }
		: undefined;
}
