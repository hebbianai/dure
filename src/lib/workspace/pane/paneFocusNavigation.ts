// pane 포커스의 방향 이동 판정 — 순수 모듈. 활성 그룹 중심에서 해당 방향에
// 있는 그룹 중 "방향 축 거리 우선, 수직 축 어긋남 벌점" 최소를 고른다
// (tmux select-pane / Warp 방향 이동과 같은 관례).
import { recordOf } from "@/lib/workspace/layout/serializedLayoutJson";

export interface PaneRect {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export type PaneDirection = "left" | "right" | "up" | "down";

const AXIS: Record<
	PaneDirection,
	{ main: (r: PaneRect) => number; cross: (r: PaneRect) => number; sign: 1 | -1 }
> = {
	left: { main: (r) => r.x + r.width / 2, cross: (r) => r.y + r.height / 2, sign: -1 },
	right: { main: (r) => r.x + r.width / 2, cross: (r) => r.y + r.height / 2, sign: 1 },
	up: { main: (r) => r.y + r.height / 2, cross: (r) => r.x + r.width / 2, sign: -1 },
	down: { main: (r) => r.y + r.height / 2, cross: (r) => r.x + r.width / 2, sign: 1 },
};

/** Returns undefined at an edge; the caller owns cross-Space navigation.
 * Cross-axis distance is weighted twice to prefer aligned neighbors. */
export function pickDirectionalPane(
	rects: readonly PaneRect[],
	activeId: string,
	direction: PaneDirection,
): string | undefined {
	const active = rects.find((rect) => rect.id === activeId);
	if (!active) return undefined;
	const axis = AXIS[direction];
	const origin = { main: axis.main(active), cross: axis.cross(active) };
	let best: { id: string; score: number } | undefined;
	for (const rect of rects) {
		if (rect.id === activeId) continue;
		const delta = (axis.main(rect) - origin.main) * axis.sign;
		if (delta <= 0.5) continue; // 반대편·같은 줄(부동소수 잡음 포함)은 제외
		const skew = Math.abs(axis.cross(rect) - origin.cross);
		const score = delta + skew * 2;
		if (!best || score < best.score) best = { id: rect.id, score };
	}
	return best?.id;
}

/** Cold Spaces have no live groups. Keep their last selected visible grid
 * pane, or the first visible pane, without reviving retained hidden slots. */
export function visiblePaneFromLayout(layout: unknown): string | undefined {
	const snapshot = recordOf(layout);
	const candidates: { groupId: unknown; panelId: string }[] = [];
	const visit = (value: unknown): void => {
		const node = recordOf(value);
		if (!node || node.visible === false) return;
		if (node.type === "branch" && Array.isArray(node.data)) {
			node.data.forEach(visit);
		} else if (node.type === "leaf") {
			const group = recordOf(node.data);
			const views = Array.isArray(group?.views)
				? group.views.filter(
					(id): id is string => typeof id === "string" && id.length > 0,
				)
				: [];
			const selected = group?.activeView;
			const panelId =
				typeof selected === "string" && views.includes(selected)
					? selected
					: views[0];
			if (panelId) candidates.push({ groupId: group?.id, panelId });
		}
	};
	visit(recordOf(snapshot?.grid)?.root);
	return (
		candidates.find((candidate) => candidate.groupId === snapshot?.activeGroup)
		?? candidates[0]
	)?.panelId;
}
