import { File } from "lucide-react";

/** The 14px glyph that stands for one file — Figma 3404:86362 (14px, up from
 *  the 12px of 2391:44516).
 *
 *  종류와 무관하게 lucide `File` 하나다. 시안의 `.gitignore`·`package.json`·
 *  `tsconfig.json`·`README.md`가 전부 같은 모양이고, "최근 파일" 행도 같은
 *  글리프를 쓴다(소유자 결정 2026-08-12).
 *
 *  예전에는 확장자로 14종(FileJson·FileText·FileCode…)을 갈라 그렸다. 그
 *  분류는 파일명이 바로 옆에 있어 장식에 가까웠고, 트리에서 아이콘 열이
 *  행마다 다른 모양으로 튀어 목록의 세로선을 흐렸다. 한 글리프면 아이콘
 *  열은 "여기부터 이름"이라는 자리 표시만 하고 구분은 이름이 맡는다.
 *
 *  `aria-hidden` 장식이다 — 파일명이 바로 옆에 있어 보조기술에 같은 정보를
 *  두 번 보내지 않는다. 인자를 받지 않는 것이 계약이다: 크기·색이 호출부마다
 *  갈리면 목록의 글리프 열이 다시 어긋난다. */
export function FileGlyph() {
	return (
		<File
			aria-hidden="true"
			data-file-glyph=""
			className="size-3.5 shrink-0 text-muted-foreground"
		/>
	);
}
