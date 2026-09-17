// Spaces 검색의 한 권위 — 같은 검색창의 질의가 목록마다 다른 술어로
// 갈라져 있었다(열린 행·미오픈·감지 워크트리가 각자 인라인 조립, 감사
// 마찰 #13: 브랜치·경로로 열린 에이전트를 못 찾음). 정규화와 매칭, 그리고
// 표면별 haystack 조립을 여기서 소유해 "같은 검색어는 어느 목록에서든
// 같은 종류의 근거로 찾힌다"를 한 곳에서 보장한다.

export function normalizeSpacesQuery(query: string): string {
	return query.trim().toLocaleLowerCase();
}

export function matchesSpacesQuery(
	normalizedQuery: string,
	parts: readonly (string | null | undefined)[],
): boolean {
	if (!normalizedQuery) return true;
	return parts
		.filter(Boolean)
		.join("\n")
		.toLocaleLowerCase()
		.includes(normalizedQuery);
}

/** 열린 세션 행 — 화면(detail)은 활동이 경로를 대체하지만 검색은 경로·cwd로도
 *  찾혀야 한다. title은 행 재설계 후 안정된 표시 이름이다. */
export function openSpaceRowSearchParts(row: {
	title: string;
	detail: string;
	projectName: string;
	provider: string | null | undefined;
	cwd: string;
	relativePath: string | undefined;
}): (string | null | undefined)[] {
	return [
		row.title,
		row.detail,
		row.projectName,
		row.provider,
		row.cwd,
		row.relativePath,
	];
}

export function unopenedAgentSearchParts(agent: {
	displayName: string;
	name: string | undefined;
	provider: string;
	projectName: string;
	worktreePath: string;
	branch: string | undefined;
}): (string | null | undefined)[] {
	return [
		agent.displayName,
		agent.name,
		agent.provider,
		agent.projectName,
		agent.worktreePath,
		agent.branch,
	];
}
