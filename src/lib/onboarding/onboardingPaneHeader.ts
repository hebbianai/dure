/** Only current content and the group-owned header affect this projection. */
interface HeaderGroup {
	panels: readonly { api: { component: string } }[];
	header: { hidden: boolean };
}

/**
 * The guide supplies its own title and accessible close action, so its sole
 * group does not need a duplicate tab header. Closing still uses Dockview's
 * normal removal and the existing persisted dismissal preference.
 * Headers belong to groups: restore the header if another pane shares this
 * group so that pane's controls remain available.
 */
export function onboardingPaneHeaderHidden(group: HeaderGroup): boolean {
	return group.panels.length === 1 && group.panels[0]?.api.component === "onboarding";
}

/** 현재 그룹 전부에 위 규칙을 적용한다(레이아웃 복원·pane 추가/제거 후 호출). */
export function syncOnboardingPaneHeaders(
	groups: readonly HeaderGroup[],
): void {
	for (const group of groups) {
		const hidden = onboardingPaneHeaderHidden(group);
		// 값이 같으면 건드리지 않는다 — dockview는 setter에서 레이아웃을 다시 재므로
		// 매 이벤트마다 쓰면 불필요한 리레이아웃이 쌓인다.
		if (group.header.hidden !== hidden) group.header.hidden = hidden;
	}
}
