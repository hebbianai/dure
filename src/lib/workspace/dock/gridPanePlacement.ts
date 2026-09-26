// Prefer a nearby split that fits, then another readable group. Existing panes
// keep their topology; placement only divides the chosen group's available space.
import type { DockviewApi } from "dockview-react";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";

export interface PlacementCandidate {
	id: string;
	width: number;
	height: number;
}

export interface GridSplitChoice {
	referenceGroupId: string;
	direction: "right" | "below";
}

/** Ordinary terminals or explicit rail placements form a full-height right rail.
 * Match visible Agent groups, falling back to terminals before the first Agent.
 * Use their post-add mean width, counting a tabbed group once. */
export function rightRailPosition(api: DockviewApi): PanelPosition | undefined {
	if (api.panels.length === 0) return undefined;
	if (!Number.isFinite(api.width) || api.width <= 0)
		return { direction: "right" };
	const agentWidths = new Map<string, number>();
	const terminalWidths = new Map<string, number>();
	for (const panel of api.panels) {
		const { group } = panel;
		const width = group.api.width;
		if (
			group.api.location.type === "grid" &&
			group.api.isVisible &&
			Number.isFinite(width) &&
			width > 0
		) {
			if (panel.api.component === "agent") agentWidths.set(group.id, width);
			else if (panel.api.component === "terminal")
				terminalWidths.set(group.id, width);
		}
	}
	const widths = agentWidths.size > 0 ? agentWidths : terminalWidths;
	if (widths.size === 0) return { direction: "right" };
	const meanWidth =
		[...widths.values()].reduce((sum, width) => sum + width, 0) / widths.size;
	// Existing widths scale by (W - x) / W, so a peer rail needs x = mean / (1 + mean / W).
	// Reusing the pre-add mean would request all available width for a second pane.
	return {
		direction: "right",
		initialWidth: Math.round(meanWidth / (1 + meanWidth / api.width)),
	};
}

/** 가장 큰 그룹을 긴 축으로 분할한다. 크기를 아직 모르면(0/음수 포함 —
 *  마운트 직후) undefined를 돌려 호출부가 기존 폴백(활성 그룹 오른쪽)을
 *  쓰게 한다. 폭/높이가 같은 정사각형은 가로 분할(right) — 터미널·에디터
 *  내용이 가로로 긴 매체라 세로 기둥보다 좌우 이웃이 먼저다. */
export function pickGridSplit(
	candidates: readonly PlacementCandidate[],
): GridSplitChoice | undefined {
	let best: PlacementCandidate | undefined;
	for (const candidate of candidates) {
		if (!measured(candidate)) continue;
		if (
			!best ||
			candidate.width * candidate.height > best.width * best.height
		) {
			best = candidate;
		}
	}
	if (!best) return undefined;
	return {
		referenceGroupId: best.id,
		direction: best.width >= best.height ? "right" : "below",
	};
}

interface PaneSize {
	readonly width: number;
	readonly height: number;
}

const DEFAULT_MINIMUM: PaneSize = { width: 320, height: 220 };
const measured = ({ width, height }: PaneSize) =>
	Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
const directions = ({
	width,
	height,
}: PaneSize): GridSplitChoice["direction"][] =>
	width >= height ? ["right", "below"] : ["below", "right"];
const splitSize = (
	pane: PaneSize,
	direction: GridSplitChoice["direction"],
): PaneSize => ({
	width: pane.width / (direction === "right" ? 2 : 1),
	height: pane.height / (direction === "below" ? 2 : 1),
});

/** Minimum sizes are readability targets, not hard constraints: a full Space
 * still accepts visible panes, using the split closest to meeting both targets. */
export function pickAutoSplit(
	candidates: readonly PlacementCandidate[],
	activeGroupId: string | undefined,
	minimumSize: PaneSize = DEFAULT_MINIMUM,
): GridSplitChoice | undefined {
	const ordered = candidates
		.filter(measured)
		.sort((a, b) => b.width * b.height - a.width * a.height);
	const fittingSplit = (
		pane: PlacementCandidate,
	): GridSplitChoice | undefined => {
		for (const direction of directions(pane)) {
			const size = splitSize(pane, direction);
			if (size.width >= minimumSize.width && size.height >= minimumSize.height)
				return { referenceGroupId: pane.id, direction };
		}
		return undefined;
	};
	const active = ordered.find((candidate) => candidate.id === activeGroupId);
	const nearby = active && fittingSplit(active);
	if (nearby) return nearby;
	for (const pane of ordered) {
		const choice = fittingSplit(pane);
		if (choice) return choice;
	}
	let best: GridSplitChoice | undefined;
	let bestScore = -1;
	for (const pane of ordered) {
		for (const direction of directions(pane)) {
			const size = splitSize(pane, direction);
			const score = Math.min(
				size.width / minimumSize.width,
				size.height / minimumSize.height,
			);
			if (score > bestScore) {
				best = { referenceGroupId: pane.id, direction };
				bestScore = score;
			}
		}
	}
	return best;
}

/** 새 패널을 스택하지 않고 별도 그룹으로 분할하는 기본 위치. 첫 패널이면
 *  undefined(전체를 채움), 크기를 아직 모르면(테스트 더블·마운트 직후) 종전
 *  폴백(활성 그룹 오른쪽). floating/popout 그룹은 제외한다. "한 에이전트당 한
 *  패널" — 여러 패널이 한 그룹에 쌓여 탭바 숨김에 가려지는 문제를 막는 계약은
 *  그대로다. */
export function autoSplitPosition(
	api: DockviewApi,
	options: { preferredPanelId?: string; minimumSize?: PaneSize } = {},
): PanelPosition | undefined {
	if (api.panels.length === 0) return undefined;
	const activeGroup =
		(options.preferredPanelId
			? api.getPanel(options.preferredPanelId)?.group
			: undefined) ?? api.activeGroup;
	const grid = pickAutoSplit(
		(api.groups ?? [])
			.filter(
				(group) =>
					group.api?.location?.type === "grid" && group.api.isVisible !== false,
			)
			.map((group) => ({
				id: group.id,
				width: group.api.width,
				height: group.api.height,
			})),
		activeGroup?.api?.location?.type === "grid" ? activeGroup.id : undefined,
		options.minimumSize,
	);
	if (!grid) return { direction: "right" };
	return { referenceGroup: grid.referenceGroupId, direction: grid.direction };
}
