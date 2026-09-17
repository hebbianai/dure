/**
 * 그리드 내부 경계 삽입 판정 (hebbian-frontend-hv89).
 *
 * 사용자 요청(2026-07-29): "기존 두 컬럼 사이에 새 컬럼을 끼워 넣는" 배치가
 * 안 된다. 컨테이너 바깥 가장자리는 dndEdges가 전폭 드롭을 주지만, 안쪽
 * 경계는 dockview가 그 자리 leaf를 split할 뿐이라 전체 높이 컬럼이 안 나온다.
 * 왼쪽 컬럼이 위/아래 두 그룹으로 나뉘어 있으면 결과는 그 중 하나의 반쪽에
 * 붙는다 — 사용자가 원한 건 두 컬럼 사이를 가르는 전체 높이 컬럼이다.
 *
 * 이 모듈은 직렬화된 gridview 트리와 포인터 위치만 받아 "어느 branch의 몇 번째
 * 자리에 끼울지"를 계산한다. DOM도 dockview 인스턴스도 건드리지 않아
 * 오버레이 렌더링과 드롭 실행이 같은 판정을 공유할 수 있다.
 *
 * 경쟁 제품 확인(2026-07-30): VS Code 에디터 그리드와 Zed 모두 그룹 가장자리
 * 밴드만 제공해 같은 한계를 갖는다 — 두 컬럼 사이 전체 높이 삽입은 sash를
 * 직접 겨냥해야 가능하다. 그래서 밴드가 아니라 **경계선(sash) 자체**를
 * 겨냥하는 판정으로 간다.
 */

type GridOrientation = "HORIZONTAL" | "VERTICAL";

/** dockview `api.toJSON().grid`의 노드 모양 중 이 판정에 필요한 부분만. */
export interface SerializedGridNode {
	type: "branch" | "leaf";
	/** 부모 축에서 이 노드가 차지하는 크기(px). 루트 노드에는 없을 수 있다. */
	size?: number;
	/** Dockview retains the last visible size while a leaf is hidden. */
	visible?: boolean;
	data: SerializedGridNode[] | unknown;
}

export interface SerializedGrid {
	orientation: GridOrientation;
	root: SerializedGridNode;
	width: number;
	height: number;
}

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface InsertionTarget {
	/** gridview location — 부모 branch 경로 + 삽입 index (그 자리 앞에 들어간다). */
	location: number[];
	/** 새로 생기는 것이 컬럼(HORIZONTAL branch)인지 로우(VERTICAL)인지. */
	orientation: GridOrientation;
	/** 오버레이로 그릴 경계 밴드 (컨테이너 좌표). */
	rect: Box;
	/** 이 경계가 가르는 branch의 깊이 — 0이 루트(전폭/전고). */
	depth: number;
}

/** 경계선에서 이 거리 안이면 '경계 삽입'으로 본다. 그룹 가장자리 밴드보다
 *  좁아야 한다 — 안 그러면 일반 split 추천을 통째로 잡아먹는다. */
export const DEFAULT_BOUNDARY_BAND_PX = 14;

function childrenOf(node: SerializedGridNode): SerializedGridNode[] {
	return node.type === "branch" && Array.isArray(node.data) ? node.data : [];
}

function isVisibleNode(node: SerializedGridNode): boolean {
	if (node.visible === false) return false;
	if (node.type === "leaf") return true;
	return childrenOf(node).some(isVisibleNode);
}

function visibleChildrenOf(node: SerializedGridNode) {
	return childrenOf(node)
		.map((child, index) => ({ child, index }))
		.filter(({ child }) => isVisibleNode(child));
}

/** branch의 자식 축 크기 합이 실제 박스와 어긋날 수 있다(반올림·저장 시점
 *  차이). 비율로 환산해 현재 박스에 맞춘다 — 안 그러면 깊은 경계일수록
 *  오버레이가 밀린다. */
function childExtents(
	children: SerializedGridNode[],
	available: number,
): number[] {
	const sizes = children.map((child) =>
		typeof child.size === "number" ? child.size : 0,
	);
	const total = sizes.reduce((sum, size) => sum + size, 0);
	if (total <= 0) {
		const even = available / Math.max(1, children.length);
		return children.map(() => even);
	}
	return sizes.map((size) => (size / total) * available);
}

function flip(orientation: GridOrientation): GridOrientation {
	return orientation === "HORIZONTAL" ? "VERTICAL" : "HORIZONTAL";
}

/**
 * 포인터가 그리드 **안쪽 경계** 위에 있으면 그 삽입 자리를 돌려준다.
 *
 * Choose the nearest boundary where activation bands overlap. Equal distances
 * prefer the shallowest branch, preserving full-span insertion at a junction.
 *
 * 바깥 가장자리(각 branch의 0번·마지막 자리)는 대상이 아니다 — 루트 가장자리는
 * dndEdges가, 그룹 가장자리는 dockview 기본 밴드가 이미 처리한다.
 */
export function interiorInsertionTarget(
	grid: SerializedGrid,
	point: { x: number; y: number },
	bandPx: number = DEFAULT_BOUNDARY_BAND_PX,
): InsertionTarget | null {
	if (!(grid.width > 0) || !(grid.height > 0)) return null;
	let best: InsertionTarget | null = null;
	let bestDistance = Infinity;

	const visit = (
		node: SerializedGridNode,
		box: Box,
		orientation: GridOrientation,
		path: number[],
	) => {
		const children = visibleChildrenOf(node);
		if (children.length === 0) return;
		const horizontal = orientation === "HORIZONTAL";
		const available = horizontal ? box.width : box.height;
		const extents = childExtents(
			children.map(({ child }) => child),
			available,
		);

		let offset = horizontal ? box.x : box.y;
		for (
			let visibleIndex = 0;
			visibleIndex < children.length;
			visibleIndex += 1
		) {
			const { child, index } = children[visibleIndex];
			const extent = extents[visibleIndex];
			const childBox: Box = horizontal
				? { x: offset, y: box.y, width: extent, height: box.height }
				: { x: box.x, y: offset, width: box.width, height: extent };

			// 자식 앞의 경계. index 0은 branch 바깥 가장자리라 건너뛴다.
			if (visibleIndex > 0) {
				const along = horizontal ? point.x : point.y;
				const across = horizontal ? point.y : point.x;
				const acrossStart = horizontal ? box.y : box.x;
				const acrossEnd = acrossStart + (horizontal ? box.height : box.width);
				const withinBranch = across >= acrossStart && across <= acrossEnd;
				const distance = Math.abs(along - offset);
				if (withinBranch && distance <= bandPx) {
					const depth = path.length;
					if (
						best === null ||
						distance < bestDistance ||
						(distance === bestDistance && depth < best.depth)
					) {
						bestDistance = distance;
						best = {
							location: [...path, index],
							orientation,
							rect: horizontal
								? {
										x: offset - bandPx,
										y: box.y,
										width: bandPx * 2,
										height: box.height,
									}
								: {
										x: box.x,
										y: offset - bandPx,
										width: box.width,
										height: bandPx * 2,
									},
							depth,
						};
					}
				}
			}

			visit(child, childBox, flip(orientation), [...path, index]);
			offset += extent;
		}
	};

	visit(
		grid.root,
		{ x: 0, y: 0, width: grid.width, height: grid.height },
		grid.orientation,
		[],
	);
	return best;
}

/** 이 삽입이 실제로 '전체 폭/높이를 가르는' 것인지 — 루트 branch의 경계만
 *  그렇다. 오버레이 문구·강조를 다르게 줄 때 쓴다. */
export function isFullSpanInsertion(target: InsertionTarget): boolean {
	return target.depth === 0;
}

/**
 * target이 끌던 pane 자신의 양옆 경계인지 — 삽입 후 빈 원래 그룹이 제거되면
 * 순서가 그대로인 무의미 이동이라 제안하지 않는다(자기 그룹 위 드롭 억제와
 * 같은 원칙). 성립 조건: 끌던 pane의 그룹이 그 branch의 직속 leaf이고 pane
 * 혼자일 때뿐이다 — 중첩 branch 안에 있거나 그룹에 다른 pane이 남으면 삽입이
 * 구조를 실제로 바꾼다.
 */
export function isNoopSelfInsertion(
	grid: SerializedGrid,
	target: InsertionTarget,
	panelId: string,
): boolean {
	let node = grid.root;
	for (const step of target.location.slice(0, -1)) {
		const next = childrenOf(node)[step];
		if (!next) return false;
		node = next;
	}
	const children = childrenOf(node);
	const leafIndex = children.findIndex((child) => {
		if (child.type !== "leaf") return false;
		const views = (child.data as { views?: unknown } | null)?.views;
		return (
			Array.isArray(views) && views.length === 1 && views.includes(panelId)
		);
	});
	if (leafIndex < 0) return false;
	const insertIndex = target.location[target.location.length - 1];
	const visibleChildren = visibleChildrenOf(node);
	const visibleLeafIndex = visibleChildren.findIndex(
		({ index }) => index === leafIndex,
	);
	if (visibleLeafIndex < 0) return false;
	const visibleInsertIndex = visibleChildren.filter(
		({ index }) => index < insertIndex,
	).length;
	return (
		visibleInsertIndex === visibleLeafIndex ||
		visibleInsertIndex === visibleLeafIndex + 1
	);
}
