import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** `@theme`에 직접 넣은 글자 크기 — Tailwind가 `text-<이름>` 유틸을 만든다.
 *  (index.css의 `--text-meta`)
 *
 *  tailwind-merge에게 따로 알려줘야 한다. 얘는 클래스 이름만 보고 무리를
 *  가르는데, `text-meta`처럼 모르는 이름은 크기가 아니라 *색*으로 넘긴다
 *  (`text-red-500` 꼴이라고 본다). 그러면 같은 cn() 안의 진짜 색 클래스와
 *  충돌한다고 판단해 크기 쪽을 조용히 지운다:
 *
 *      cn("text-meta", "text-muted-foreground")  →  "text-muted-foreground"
 *
 *  실제로 데스크탑 그룹 이름이 11px 대신 16px(= h3가 물려받은 body 크기)로
 *  나오고 있었다. 클래스는 코드에 그대로 적혀 있고 CSS에도 `.text-meta`가
 *  멀쩡히 생성되므로, 브라우저에서 계산된 값을 보기 전엔 원인이 안 보인다.
 *  경고도 오류도 없다.
 *
 *  `--text-*` 키를 새로 추가하면 여기에도 넣을 것. */
const CUSTOM_FONT_SIZES = ["field", "meta"] as const;

const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: [...CUSTOM_FONT_SIZES] }] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
