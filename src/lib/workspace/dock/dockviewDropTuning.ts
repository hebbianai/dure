// DockviewReact의 드래그/드롭·floating 튜닝 — Workspace에서 추출(god-file).
// 값들은 전부 "레이아웃 조작 UX"라는 한 관심사다.
import type { IDockviewReactProps } from "dockview-react";

type DropTuning = Pick<
	IDockviewReactProps,
	| "dropOverlayModel"
	| "dndEdges"
	| "floatingGroupBounds"
	| "disableTabsOverflowList"
>;

export const DOCKVIEW_DROP_TUNING: DropTuning = {
	// 드롭 존 판정 보정 — dockview 기본은 각 변 "20% 비율" 밴드라 큰
	// pane에선 밴드가 수백 px로 비대해지고(중앙 합류 존 잠식) 작은
	// pane에선 center가 60%로 쪼그라든다. Zed(drop_target_size=0.2,
	// 짧은 변 기준)·VS Code(가장자리 고정 밴드) 방식대로 짧은 변 기준
	// 픽셀 밴드(24~80px 클램프)로 통일해 pane 크기와 무관하게 일관된
	// 추천을 만든다.
	dropOverlayModel: ({ location, group }) => {
		if (location !== "content" || !group) return undefined;
		const shortSide = Math.min(group.width, group.height);
		const activation = Math.round(Math.max(24, Math.min(80, shortSide * 0.2)));
		return { activationSize: { type: "pixels", value: activation } };
	},
	// 루트 가장자리 존 확장 — 컨테이너 가장자리로 드래그하면 그 자리
	// 그룹의 split 대신 전체 폭/높이 컬럼·로우 드롭을 제안한다. dockview
	// dnd 리스너는 capture phase라 루트(조상)가 그룹보다 먼저 판정하므로
	// 이 밴드 폭이 곧 우선권 범위다 (기본 10px는 사실상 못 맞춘다 —
	// VS Code·Zed의 고정 가장자리 밴드와 같은 UX).
	dndEdges: {
		activationSize: { type: "pixels", value: 24 },
		size: { type: "pixels", value: 20 },
	},
	// 떠 있는 그룹(shift+드래그 dialog pane)이 화면 밖으로 완전히 나가면
	// top bar를 다시 잡을 방법이 없다 — 뷰포트 안으로 이동을 클램프한다.
	floatingGroupBounds: "boundedWithinViewport",
	// 그룹당 pane 하나(전폭 단일 탭) 구조라 탭 오버플로 목록("›1")이 뜰 이유가
	// 없다 — 좁을 때 헤더가 접히는 건 PaneChrome의 반응형 처리 몫이다
	// (사용자 요청 2026-08-01: 이 버튼이 필요할 일은 없게).
	disableTabsOverflowList: true,
};
