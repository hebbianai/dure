/**
 * 앱 로고.
 *
 * 홈 화면 아이콘과 **같은 파일**을 가리킨다. 복사본을 두면 아이콘을 바꾼 날
 * 스캔 화면만 옛 로고로 남고, 그 어긋남은 아이콘을 바꾼 사람에게 보이지 않는다
 * — 그 사람은 홈 화면만 보고 끝낸다.
 *
 * SVG로 다시 그리지 않는 이유도 같다. 이 로고는 손으로 옮겨 적을 수 있는
 * 도형이 아니라서, 옮겨 적은 것은 비슷한 다른 그림이 된다.
 */

import logoUrl from "../src-tauri/icons/icon.png";
import wordmarkUrl from "./assets/logo-dure-wordmark.svg";
import { element } from "./dom";

/** The 63×16 Dure wordmark exported from Figma. */
export function dureWordmark(): HTMLElement {
  const mark = element("span", "dure-wordmark");
  mark.style.setProperty("--glyph", `url("${wordmarkUrl}")`);
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", "Dure");
  return mark;
}

/**
 * @param size 한 변의 CSS 픽셀. 원본은 512px 정사각이라 어느 크기로도 선명하다.
 */
export function appLogo(size: number): HTMLElement {
  const logo = element("img", "app-logo");
  logo.src = logoUrl;
  logo.width = size;
  logo.height = size;
  // 장식이다. 옆에 언제나 앱 이름이 글자로 있으므로, 스크린리더가 이것을 한 번
  // 더 읽으면 같은 말을 두 번 듣게 된다.
  logo.alt = "";
  logo.setAttribute("aria-hidden", "true");
  return logo;
}
