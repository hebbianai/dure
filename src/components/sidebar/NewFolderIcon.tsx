import { STROKE_PROPS } from "@/components/sidebar/RailIcons";

/**
 * Figma "Icon / FolderPlus2" (2005:12376) — 새 폴더. 파일 탭 머리행의 액션
 * 글리프다(2391:44372).
 *
 * lucide `folder-plus`가 아니다. 그쪽은 더하기를 폴더 **안** 중앙(24 그리드
 * 기준 12,13)에 놓는데, 시안은 왼쪽 모서리(4,14)에 걸치고 폴더 외곽선의 왼쪽
 * 아래를 그 자리만큼 열어 둔다(`Z` 없이 `v3.5`에서 끊긴다). 뜻이 다르다:
 * 안쪽 더하기는 "폴더에 무언가를 넣는다"로, 모서리 더하기는 "폴더 자체를
 * 더한다"로 읽히고 이 액션은 후자다.
 *
 * 좌표는 눈짐작이 아니라 시안 노드 2391:44372의 내보낸 SVG를 24 그리드로
 * 역산한 값이다. 폴더 몸통은 lucide `folder`와 같은 2..22 / 3..20을 지난다.
 *
 * 더하기 가로 팔이 x=1에서 시작해 round cap이 x=0까지 칠한다 — 이 폴더의 다른
 * 글리프보다 왼쪽으로 한 칸 넓다. 시안이 그렇게 그렸고(내보낸 path의 bbox가
 * x 1에서 시작한다) viewBox 안쪽이라 잘리지도 않는다. lucide 규격에 맞추겠다고
 * 오른쪽으로 밀면 더하기가 폴더 변에 걸치는 그 관계가 깨진다.
 *
 * 레일 아이콘이 아니라 RailIcons가 아닌 자기 파일에 산다 — FileGlyph와 같은
 * 선례다. 규격(24 그리드·stroke 2·round)만 RailIcons에서 가져다 쓴다.
 */
export function NewFolderIcon({ className }: { className?: string }) {
	return (
		<svg {...STROKE_PROPS} className={className} aria-hidden>
			<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v3.5" />
			<path d="M4 11v6" />
			<path d="M1 14h6" />
		</svg>
	);
}
