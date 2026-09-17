/**
 * "최근 파일" 행의 두 줄 — Figma 2391:46828 "Row/Label" + "Row/Path".
 *
 * 이름과 경로를 한 번에 돌려준다. 호출 쪽에서 경로를 두 번 쪼개면 두 값이
 * 빈 마디 처리 정책이 갈려 어긋난다(`a/b/` 같은 입력에서 이름만 빈 문자열이
 * 되는 식).
 *
 * 자르는 방향이 이 모듈의 존재 이유다. CSS `truncate`는 꼬리를 자르는데
 * 경로에서 버려도 되는 건 머리 쪽(홈 디렉터리·워크스페이스 루트)이고 정작
 * 구분에 필요한 건 꼬리다. `~/Documents/Develop/agent-ide/src/components/spaces`
 * 를 꼬리부터 자르면 모든 행이 `~/Documents/Dev…`로 같아 보인다. 그래서 마디
 * 단위로 앞을 접고 `…/`를 붙인다.
 */
export interface RecentFileLabel {
	/** 파일 이름 — 행의 윗줄 */
	readonly name: string;
	/** 파일이 든 폴더 — 행의 아랫줄. 보여줄 게 없으면 빈 문자열 */
	readonly directory: string;
}

const DEFAULT_SEGMENTS = 3;

export function recentFileLabel(
	filePath: string,
	maxSegments = DEFAULT_SEGMENTS,
): RecentFileLabel {
	const segments = filePath.split("/").filter(Boolean);
	const name = segments.length > 0 ? segments[segments.length - 1] : filePath;
	const directory = segments.slice(0, -1);
	if (directory.length === 0) return { name, directory: "" };
	// 0 이하는 "제한 없음"이 아니라 "보여줄 마디가 없다"는 뜻이다. 폭에서
	// 예산을 계산하는 호출자가 0으로 수렴했을 때 가장 긴 라벨이 나오면
	// 의도가 정확히 뒤집힌다.
	if (maxSegments <= 0) return { name, directory: "" };
	if (directory.length <= maxSegments) {
		return { name, directory: directory.join("/") };
	}
	return { name, directory: `…/${directory.slice(-maxSegments).join("/")}` };
}
