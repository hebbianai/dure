/**
 * 화면 조각을 만드는 공용 빌더.
 *
 * `app.ts`가 990줄이라 여기로 뺐다 — AGENTS.md의 god-file 규칙("건드리는 부분을
 * 별도 모듈로 추출한다")이고, 이 빌더들은 홈·목록·터미널 세 화면이 함께 쓴다.
 * 복제해서 세 벌 두면 상태 점 색 하나 고칠 때 두 곳을 놓친다.
 */

import { t } from "./i18n";
import { DURE_LOADER_DOT_COUNT, dureLoaderGeometry } from "@/lib/ui/dureLoader";
import type { AgentKind, RunState } from "./sessionRows";

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * One SVG exported from Figma, painted in the current text colour.
 *
 * Lives here rather than beside one screen because the pairing screens and the
 * session list both draw icons, and two copies of this would mean two answers
 * to "how does an icon take its colour" the first time one of them changed.
 *
 * Not an `<img>`: the stroke colour baked into an export belongs to the frame
 * it came from, so a white glyph laid on the light primary button disappears.
 * A mask keeps the file's vector and lets the site decide the colour.
 */
export function glyph(source: string, size: number, className?: string): HTMLElement {
  const node = element("span", className ? `glyph ${className}` : "glyph");
  node.style.setProperty("--glyph", `url("${source}")`);
  node.style.setProperty("--glyph-size", `${size}px`);
  node.setAttribute("aria-hidden", "true");
  return node;
}

/**
 * 상태 점.
 *
 * `RunState`를 그대로 클래스 접미사로 쓴다 — 화면에서 다시 분기하지 않는다는
 * 뜻이다. `unknown`은 CSS에서 채우지 않고 테두리만 그린다: 회색으로 채운 점은
 * "종료됨"으로 읽히는데 이건 "모른다"이고, 두 상태가 같은 그림이면 안 된다.
 */
export function statusDot(state: RunState): HTMLElement {
  const dot = element("span", `dot dot--${state}`);
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", STATE_LABEL[state]);
  return dot;
}

/**
 * Desktop and mobile share the loader's geometry and animation stylesheet.
 * This DOM adapter keeps the mobile connection announcement.
 */
export function loader(size: 8 | 12 | 16 | 20 = 12): HTMLElement {
  const spinner = element("span", "dure-loader");
  const geometry = dureLoaderGeometry(size);
  spinner.style.setProperty("--dl-size", `${geometry.size}px`);
  spinner.style.setProperty("--dl-r", `${geometry.radius}px`);
  spinner.style.setProperty("--dl-d", `${geometry.dot}px`);
  spinner.setAttribute("role", "status");
  spinner.setAttribute("aria-label", t("연결 중…"));
  for (let index = 0; index < DURE_LOADER_DOT_COUNT; index += 1) {
    const orbit = element("i");
    orbit.append(element("span"));
    spinner.append(orbit);
  }
  return spinner;
}

/**
 * What stands at the head of a session row: its state, or the loader while this
 * phone is attaching to it.
 *
 * One helper rather than the same conditional in four views — the row is the
 * only place a person can see that their tap was received, and every list that
 * opens a session owes them that.
 */
export function rowLead(state: RunState, opening: boolean): HTMLElement {
  return opening ? loader(8) : statusDot(state);
}

/**
 * The colour the host node is already painted, or `undefined` if it is not.
 *
 * A terminal surface must not paint a second background inside a node that has
 * one. Wherever the host carries padding — and the session's transcript carries
 * the mockup's 16px — the two colours meet, and the difference reads as a frame
 * drawn around the transcript.
 *
 * So the stylesheet stays the one authority for that colour and the surface
 * asks the node it was handed, rather than each surface carrying a hex of its
 * own that has to be kept in step.
 */
export function paintedBackground(host: HTMLElement): string | undefined {
  const painted = getComputedStyle(host).backgroundColor;
  if (!painted || painted === "transparent" || painted === "rgba(0, 0, 0, 0)") return undefined;
  return painted;
}

const STATE_LABEL: Record<RunState, string> = {
  run: "실행 중",
  warn: "주의",
  blocked: "차단됨",
  done: "종료됨",
  unknown: "상태를 알 수 없음",
};

/**
 * 제공자 뱃지.
 *
 * 제공자 이름은 서버가 준 문자열을 그대로 쓴다. 색만 알려진 에이전트에 붙고,
 * 모르는 제공자는 회색으로 남는다 — 이름을 바꿔 부르거나 색으로 사칭하게
 * 만들지 않는다.
 */
export function agentBadge(agent: AgentKind, providerName: string): HTMLElement {
  const badge = element("span", `agent-badge agent-badge--${agent}`);
  badge.append(element("span", "agent-badge__dot"), element("span", undefined, providerName));
  return badge;
}

/** 섹션 하나. 제목은 대문자 작은 라벨, 내용은 카드. */
export function section(label: string, ...children: readonly Node[]): HTMLElement {
  const host = element("section", "section");
  host.append(element("h2", "section__label", label));
  host.append(...children);
  return host;
}

/**
 * 누를 수 있는 카드 행.
 *
 * `<button>`인 이유: `<div onclick>`은 키보드로 닿지 않고 스크린리더가 읽지
 * 않는다. 폰이라 키보드가 없다는 건 지금 이 기기 얘기이고, 접근성 도구는
 * 그것과 별개로 버튼을 찾는다.
 */
export interface CardRowOptions {
  title: string;
  /** 제목 앞. 상태 점이나 아이콘. */
  lead?: Node;
  /** 제목 아래 회색 줄. 문자열이면 그대로, 노드면 그 노드를 넣는다. */
  meta?: string | readonly Node[];
  /** 오른쪽 끝. 기본은 셰브런. */
  trailing?: Node;
  onOpen?: () => void;
}

export function cardRow(options: CardRowOptions): HTMLElement {
  const row = element("button", "card__row");
  row.type = "button";
  if (options.lead) row.append(options.lead);

  const body = element("div", "card__row-body");
  body.append(element("span", "card__row-title", options.title));
  if (options.meta !== undefined) {
    const meta = element("span", "card__row-meta");
    if (typeof options.meta === "string") {
      meta.textContent = options.meta;
    } else {
      meta.append(...options.meta);
    }
    body.append(meta);
  }
  row.append(body);

  row.append(options.trailing ?? element("span", "card__row-chevron", "›"));
  if (options.onOpen) {
    row.addEventListener("click", options.onOpen);
  } else {
    // 누를 데가 없는 행은 버튼처럼 보이지 않아야 한다. 눌러도 아무 일이 없는
    // 버튼은 앱이 멈춘 것처럼 읽힌다.
    row.disabled = true;
  }
  return row;
}

/** 행들을 담는 카드. 행 사이 선은 CSS가 긋고 바깥 테두리는 카드가 갖는다. */
export function card(...rows: readonly Node[]): HTMLElement {
  const host = element("div", "card");
  host.append(...rows);
  return host;
}

/** 필터 칩 하나. 눌린 상태는 `aria-pressed`로, CSS가 그걸 보고 칠한다. */
export function chip(label: string, pressed: boolean, onPress: () => void): HTMLElement {
  const button = element("button", "chip", label);
  button.type = "button";
  button.setAttribute("aria-pressed", String(pressed));
  button.addEventListener("click", onPress);
  return button;
}

/** 번호 붙은 안내 단계. 첫 실행 화면과 페어링 화면이 같은 모양을 쓴다. */
export interface Step {
  title: string;
  body: string;
}

export function steps(items: readonly Step[]): HTMLElement {
  const list = element("ol", "steps");
  items.forEach((step, index) => {
    const item = element("li", "steps__item");
    item.append(element("span", "steps__index", String(index + 1)));
    const body = element("div");
    body.append(
      element("div", "steps__title", step.title),
      element("div", "steps__body", step.body),
    );
    item.append(body);
    list.append(item);
  });
  return list;
}

/**
 * The scrim and panel every bottom sheet sits in.
 *
 * Lived in `scmSheets.ts` while the source-control screen was the only place
 * that opened one. The home screen's 추가 sheet (Figma 3096:86354) is the second
 * consumer, and a second copy of the frame is exactly the drift that file's own
 * header comment warns about — a sheet that sits two pixels differently from
 * its sibling reads as a bug in whichever one you see second.
 *
 * Tapping the scrim dismisses. The mockups draw no close button, and this is
 * what stands in its place; without it there is no way back on the screen. A
 * sheet that must *not* be dismissable that way builds its own host instead
 * (`renderConfirmDialog`), because that is a different promise.
 *
 * @param modifier extra class on the host, for a sheet whose surface differs.
 */
export function sheetShell(
  title: string,
  dismiss: () => void,
  modifier?: string,
): { host: HTMLElement; panel: HTMLElement } {
  const host = element("div", modifier ? `sheet ${modifier}` : "sheet");
  host.addEventListener("click", (event) => {
    if (event.target === host) dismiss();
  });
  const panel = element("div", "sheet__panel");
  panel.append(element("div", "sheet__grip"));
  panel.append(element("h2", "sheet__title", title));
  host.append(panel);
  return { host, panel };
}

/**
 * Keeps a fade class on `strip` only while there is more on that side.
 * A fade at a strip's end is a promise of more; once the strip is at its end
 * it would be a lie over the last item (2026-09-15 승연). Read on scroll and
 * whenever the strip is laid out — a render replaces the tree, so the first
 * read has to wait for the layout the observer reports. The key tray's strip
 * reads it along its row; the lists that scroll under a header read it down
 * their column and mark their start too, so a row half under the header
 * fades rather than being cut (2026-09-15 승연: "스크롤하면 끊기는거 … 모든
 * 부분에 적용"). A string names the end class alone.
 */
export function fadeWhileScrollable(
  strip: HTMLElement,
  cut: string | { readonly start?: string; readonly end?: string },
  axis: "x" | "y" = "x",
): void {
  const classes = typeof cut === "string" ? { end: cut } : cut;
  const update = (): void => {
    const [position, size, extent] =
      axis === "x"
        ? [strip.scrollLeft, strip.clientWidth, strip.scrollWidth]
        : [strip.scrollTop, strip.clientHeight, strip.scrollHeight];
    if (classes.end) strip.classList.toggle(classes.end, position + size < extent - 1);
    if (classes.start) strip.classList.toggle(classes.start, position > 1);
  };
  strip.addEventListener("scroll", update, { passive: true });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(update).observe(strip);
}

/** 묶음 제목 + 개수. */
export function groupHeading(label: string, count: number): HTMLElement {
  const heading = element("div", "group-heading");
  heading.append(
    element("span", undefined, label),
    element("span", "group-heading__count", String(count)),
  );
  return heading;
}
