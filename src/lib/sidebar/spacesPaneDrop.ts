import type { DesktopPaneMoveItem } from "@/lib/workspace/desktop/desktopPaneMove";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";

export type SpacesPaneDropPlan =
	| { kind: "noop" }
	| { kind: "reorder"; item: DesktopPaneMoveItem; position: PanelPosition }
	| {
			kind: "exact-transfer";
			item: DesktopPaneMoveItem;
			position: PanelPosition;
	  }
	| { kind: "bulk-transfer"; items: DesktopPaneMoveItem[] };

const EXACT_DIRECTIONS = new Set(["left", "right", "above", "below"]);

function hasExactPosition(position: PanelPosition): boolean {
	return Boolean(
		position.floating ||
			(typeof position.direction === "string" &&
				EXACT_DIRECTIONS.has(position.direction)),
	);
}

function validUniqueItems(
	items: readonly DesktopPaneMoveItem[],
): DesktopPaneMoveItem[] {
	const identities = new Set<string>();
	return items.filter((item) => {
		if (!item?.panelId?.trim() || !item?.fromDesktopId?.trim()) return false;
		const identity = `${item.fromDesktopId}\0${item.panelId}`;
		if (identities.has(identity)) return false;
		identities.add(identity);
		return true;
	});
}

/**
 * Spaces가 만든 pane 이동을 Dockview의 실제 드롭 위치에 맞춰 분기한다.
 * 한 pane은 같은 데스크탑에서도 재배치할 수 있고, 다른 데스크탑이면 정확한
 * target-first 이동을 쓴다. 다중 선택은 순서·원자성 의미가 달라 기존 bulk
 * 이동을 유지한다.
 */
export function planSpacesPaneDrop(
	items: readonly DesktopPaneMoveItem[],
	targetDesktopId: string,
	position: PanelPosition,
): SpacesPaneDropPlan {
	const valid = validUniqueItems(items);
	if (valid.length === 0) return { kind: "noop" };

	if (valid.length === 1) {
		const [item] = valid;
		if (!hasExactPosition(position)) {
			return item.fromDesktopId === targetDesktopId
				? { kind: "noop" }
				: { kind: "bulk-transfer", items: [item] };
		}
		return item.fromDesktopId === targetDesktopId
			? { kind: "reorder", item, position }
			: { kind: "exact-transfer", item, position };
	}

	const movable = valid.filter(
		(item) => item.fromDesktopId !== targetDesktopId,
	);
	return movable.length > 0
		? { kind: "bulk-transfer", items: movable }
		: { kind: "noop" };
}
