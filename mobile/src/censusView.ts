/** Home chrome stays fixed while the selected top-level group scrolls. */

import type { CensusFailure, CensusRow } from "./census";
import type { HubLayout } from "./ipc";
import type { HubSessions, UnifiedRow, UnifiedSource } from "./allSessions";
import iconDureMark from "./assets/icon-dure-mark.svg";
import iconSettings from "./assets/icon-settings.svg";
import { element, fadeWhileScrollable, glyph, loader, groupHeading } from "./dom";
import { t } from "./i18n";
import { dureWordmark } from "./logo";
import type { SpacesViewOptions } from "@/lib/spaces/spacesViewOptions";
import iconList from "./assets/icon-list.svg";
import { loadHomeViewOptions } from "./homeViewPreferences";
import { projectHome, type HomeRow } from "./homeProjection";
import { isUnattachable, renderHomeSessionRow } from "./homeSessionRow";
import { renderHomeViewMenu, type HomeMenuSection } from "./homeViewMenu";
import type { MenuAnchor } from "./sessionRowMenuPlacement";

export interface CensusModel {
  /**
   * The session this phone is attaching to right now, if any. Its row shows the
   * loader in place of its status dot — the row is the only place the tap can
   * be acknowledged, and attaching crosses a network.
   */
  readonly opening?: string;
  /** What the SSH census returned. */
  readonly census: readonly CensusRow[];
  /** What the computers this phone has paired with returned. */
  readonly hubs: readonly HubSessions[];
  /** Every layout this phone remembers, merged into one. */
  readonly layout: HubLayout;
  readonly failures: readonly CensusFailure[];
  /** A census is in flight. */
  readonly busy: boolean;
  /**
   * What to write when nothing is listed, already translated.
   *
   * Decided by the caller because the distinction it carries — nobody asked
   * yet, no server answered, every server answered and there is nothing — is
   * about the census, and `census.ts` is where that judgement already lives.
   */
  readonly emptyMessage: string;
  /**
   * The selected tab. Presentation state, so it lives in the phone's store.
   *
   * An unknown or missing name falls back to the first desktop rather than to
   * an empty list: a tab bar with nothing under it reads as a broken sync.
   */
  readonly desktop?: string;
  readonly viewOptions?: SpacesViewOptions;
  readonly viewMenu?: HomeMenuSection;
}

export interface CensusActions {
  readonly changeView?: (value: SpacesViewOptions) => void;
  readonly viewMenu?: (section: HomeMenuSection | undefined) => void;
  readonly open: (source: UnifiedSource) => void;
  readonly selectDesktop: (label: string) => void;
  readonly pair: () => void;
  readonly settings: () => void;
  /**
   * Ask every computer again.
   *
   * No longer a button on this screen — 3096:86209 has no freshness line to
   * hang one on. It is what the pull gesture calls, and what a stalled group's
   * 다시 시도 calls: both are the same census, because there is only one.
   */
  readonly refresh: () => void;
  /**
   * A row was held. Figma 3356:85254 — the menu that answers it is drawn by the
   * screen, not by this list, because it stands over everything.
   *
   * The rectangle is measured at the moment the finger settles and handed over,
   * never re-measured: a render replaces this whole tree (`app.ts` render()),
   * so by the time the menu is drawn the row this came from is gone.
   */
  readonly hold: (row: UnifiedRow, anchor: MenuAnchor) => void;
}

function header(actions: CensusActions): HTMLElement {
  const host = element("header", "home__header");

  // 3356:85138 puts the wordmark back in the bar. It went missing when the
  // freshness line it used to sit beside was retired; the bar has been an empty
  // 68px strip with one button in the corner ever since, which is a header that
  // says nothing about which app this is.
  //
  host.append(dureWordmark());

  const settings = element("button", "home__slot home__settings");
  settings.type = "button";
  settings.setAttribute("aria-label", t("설정"));
  settings.append(glyph(iconSettings, 20));
  settings.addEventListener("click", actions.settings);

  const controls = element("div", "home__controls");
  const options = element("button", "home__slot home__view-options");
  options.type = "button";
  options.setAttribute("aria-label", t("spaces.pane.viewOptions"));
  options.setAttribute("aria-haspopup", "dialog");
  options.append(glyph(iconList, 20));
  options.addEventListener("click", () => actions.viewMenu?.("root"));
  controls.append(options, settings);
  host.append(controls);
  return host;
}

/**
 * The strip the pull gesture opens, and the only thing it draws.
 *
 * Zero-height until a finger pulls it (`pullToRefresh.ts` writes the height),
 * then held open by the census it started. It carries the loader rather than an
 * arrow because the loader is already what this app means by "crossing a
 * network", and a second vocabulary for the same wait would be one to learn.
 *
 * # Why there is a button inside it
 *
 * A drag is not an affordance everyone has. VoiceOver claims one-finger drags
 * for its own navigation, so a person using it would have no way at all to
 * re-ask — and the freshness button this replaced was reachable by anything
 * that could focus. The control is off-screen rather than hidden: `display:
 * none` and `visibility: hidden` both take it away from the screen reader too,
 * which would be drawing nothing and calling it accessible.
 */
function pullStrip(model: CensusModel, actions: CensusActions): HTMLElement {
  const strip = element(
    "div",
    model.busy ? "home__pull home__pull--busy" : "home__pull",
  );
  if (model.busy) {
    strip.append(loader(16));
  } else {
    // A bare mark while the finger is down. Not the loader: `loader()` carries
    // `role="status"` and the words "연결 중…", and a settled home screen that
    // keeps one in a zero-height box announces a wait that is not happening.
    strip.append(element("span", "home__pull-mark"));
  }

  const again = element("button", "home__refresh", t("다시 확인"));
  again.type = "button";
  again.disabled = model.busy;
  again.addEventListener("click", actions.refresh);
  strip.append(again);
  return strip;
}

/**
 * The desktop tabs, and the "+" that pairs another computer.
 *
 * The row stands even with one desktop or none. It used to be hidden then, on
 * the reasoning that one tab is not a choice — but the mockup's "+" lives at
 * the end of this row (2849:80681, and again in 3096:86362), so hiding it also
 * hid the only way to add a second computer from this screen, in exactly the
 * state where somebody would want it.
 *
 * The two 2026-09 home frames disagree about that "+": 3096:86354 draws it and
 * 3096:86209 / 3096:86271 turn the same component's layer off. Kept, because
 * one frame asking for it and two omitting it is likelier an instance override
 * than a decision — and because dropping it would leave pairing reachable only
 * through 설정, which is a capability loss no frame asked for. If the designer
 * confirms it is gone, this is one button and its rule to delete.
 */
function tabs(groups: readonly { key: string; label: string }[], selected: string, actions: CensusActions): HTMLElement {
  const bar = element("div", "tabs");
  bar.setAttribute("role", "tablist");
  for (const { key, label } of groups) {
    // Run the name through the translator. Most are user-made and pass
    // straight through, but the sidebar's own "열리지 않은 에이전트" group has
    // to stand in this phone's language.
    const tab = element("button", "tab", t(label));
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(key === selected));
    if (key === selected) tab.classList.add("tab--on");
    tab.addEventListener("click", () => actions.selectDesktop(key));
    bar.append(tab);
  }
  // No "+" after the last tab: it paired a computer, which read as "add a
  // tab", and a tab cannot be added from the phone — the strip is the
  // laptop's desktop order. Pairing lives under 설정 › 컴퓨터 and the first
  // launch (2026-09-15 승연: "탭추가 없애고 그냥 + 아이콘도 없애").
  return bar;
}


export function renderHomeScreen(model: CensusModel, actions: CensusActions): HTMLElement {
  const screen = element("section", "home");
  const options = model.viewOptions ?? loadHomeViewOptions();
  const now = Date.now();
  const projected = projectHome(model, options, now);
  const selected = projected.groups.find(group => group.key === model.desktop) ?? projected.groups[0];
  screen.dataset.group = JSON.stringify([options.groupBy, selected?.key]);
  screen.append(header(actions));
  // The strip stands only when it has a tab. With none — every group hidden
  // by a filter, or no desktop yet under the Space grouping — it was a lone
  // "+" under the wordmark, and the way in from here is the FAB. Pairing
  // another computer keeps its seat at the end of a strip that exists, and
  // its own door under 설정 › 호스트; Home is never reached with nothing paired
  // (2026-09-15 승연).
  const tabGroups = options.groupBy === "space" && model.layout.desktop_order.length === 0 ? [] : projected.groups;
  if (tabGroups.length) screen.append(tabs(tabGroups, selected?.key ?? "", actions));
  const body = element("div", "home__body");
  // Rows that scroll under the tab strip fade at the edge rather than being
  // cut, and the foot fades while there is more (`fadeWhileScrollable`).
  fadeWhileScrollable(body, { start: "scroll-fade--start", end: "scroll-fade--end" }, "y");
  body.append(pullStrip(model, actions));
  const list = element("ul", "list home__list");
  const rows = selected?.rows ?? [];
  const draw = (row: HomeRow): void => {
    list.append(renderHomeSessionRow(row, options, row.row.sessionId === model.opening, now, actions));
  };
  for (const row of rows) if (!isUnattachable(row)) draw(row);
  // Sessions that cannot be attached gather at the end under one heading,
  // dimmed, with their lifecycle on the line — the heading says why, once,
  // instead of a sentence under every row (2026-09-15 승연, 안 3).
  const unattachable = rows.filter(isUnattachable);
  if (unattachable.length) {
    const heading = element("li", "list__heading");
    heading.append(groupHeading(t("연결할 수 없음"), unattachable.length));
    list.append(heading);
    for (const row of unattachable) draw(row);
  }
  body.append(list);
  if (!selected?.rows.length) {
    const hidden = projected.hidden > 0 ? t("세션 {count}개가 모두 사이드바 밖에 있습니다 — 노트북 앱에서 데스크탑에 올려 둔 것이 여기 보입니다", { count: projected.hidden }) : undefined;
    const filtered = Object.values(options.filters).some(values => values.length);
    body.append(emptyBody(model, filtered ? t("spaces.empty.noMatches") : hidden));
  }
  screen.append(body);
  if (model.viewMenu) {
    for (const child of screen.children) if (child instanceof HTMLElement) child.inert = true;
    screen.append(renderHomeViewMenu(options, model.viewMenu, projected.choices, {
      change: value => actions.changeView?.(value),
      navigate: section => actions.viewMenu?.(section),
    }));
  }
  return screen;
}

/**
 * Nothing to list. Figma 3096:86335.
 *
 * The mockup writes one sentence — "mac-studio.local에 연결됨." — and that
 * sentence asserts three things at once: a computer is paired, it answered, and
 * it reported no sessions. This screen reaches five different empty states, and
 * only one of them is that. So the mockup's *layout* is used for all five and
 * the first line comes from whichever fact is actually true:
 *
 * - a computer answered, nothing failed, and it has nothing running → the
 *   mockup's sentence, with that computer's own name;
 * - anything else → the sentence `census.ts` already decided, which knows the
 *   difference between not having asked, having no server, and no server
 *   answering. Painting "연결됨" over a census that failed would be the screen
 *   claiming a success it did not have.
 *
 * The second line is unconditional because the FAB it points at is: `app.ts`
 * draws it for every home screen that gets this far.
 */
function emptyBody(model: CensusModel, note: string | undefined): HTMLElement {
  const block = element("div", "home__empty");
  // The Dure mark, not `loader()`. This screen has finished asking; a spinner
  // here would say it is still fetching the list it just finished fetching.
  block.append(glyph(iconDureMark, 36, "home__empty-mark"));

  // "세션 없음" is true in four of the five states. In the fifth the sessions
  // are alive and merely unplaced, and "no sessions" would read as every agent
  // having died — so that one says what it means instead.
  block.append(
    element("p", "home__empty-title", note === undefined ? t("세션 없음") : t("표시할 세션 없음")),
  );

  const body = element("p", "home__empty-body");
  const connected = note === undefined ? soleReachableHub(model) : undefined;
  body.append(
    element(
      "span",
      undefined,
      connected === undefined
        ? (note ?? (model.failures.length > 0 ? t("연결하지 못했습니다") : model.emptyMessage))
        : t("{hub}에 연결됨.", { hub: connected }),
    ),
  );
  body.append(element("br"));
  body.append(element("span", undefined, t("+를 눌러 에이전트를 시작하세요.")));
  block.append(body);
  return block;
}

/**
 * The one computer whose name can stand in "…에 연결됨", or nothing.
 *
 * Requires exactly one reachable computer and a census that lost nobody. With
 * two, naming one of them hides the other; with a failure outstanding, the
 * sentence would claim the whole census succeeded.
 */
function soleReachableHub(model: CensusModel): string | undefined {
  if (model.failures.length > 0) return undefined;
  const reachable = model.hubs.filter((hub) => hub.reachable);
  if (reachable.length !== 1) return undefined;
  const label = reachable[0].hubLabel.trim();
  return label.length > 0 ? label : undefined;
}
