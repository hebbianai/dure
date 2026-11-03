import type * as React from "react";
import { IconButton } from "@/components/ui/icon-button";

/** pane 헤더 오른쪽 액션 버튼 — 시안 2070:31476 (22px 박스 / 14px 아이콘 / 6px 라운드).
 *
 *  시안은 이 버튼들을 늘 보이게 둔다. 예전에는 hover에서만 나타났는데, pane이
 *  여러 개일 때 어느 pane에 마우스를 올려야 버튼이 나오는지 알 수 없어
 *  분할·닫기가 사실상 우클릭 메뉴 전용이었다. */
export function PaneActionButton({
	label,
	onClick,
	children,
	active,
	showTooltip,
}: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
	/** 눌린 상태로 남는 토글(고정 등) — 색으로 현재 상태를 알린다. */
	active?: boolean;
	/** Off for a glyph that names itself (the close ✕). */
	showTooltip?: boolean;
}) {
	return (
		<IconButton
			title={label}
			showTooltip={showTooltip}
			// Toggle buttons (pin) pass their state; plain actions leave it
			// undefined so IconButton renders no aria-pressed for them.
			pressed={active}
			className="size-[22px] shrink-0 rounded-sm p-1 duration-150 hover:bg-glass-tint-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			// 헤더 전체가 드래그 표면이라, 버튼 위에서 시작한 포인터는 막아야 한다.
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => {
				event.stopPropagation();
				onClick();
			}}
		>
			{children}
		</IconButton>
	);
}
