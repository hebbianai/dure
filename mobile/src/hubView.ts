/**
 * 컴퓨터 한 대(허브)의 세션 목록.
 *
 * `sessionListView`와 나란한 화면이고 일부러 같은 클래스를 쓴다. 두 전송이
 * 다르다고 해서 목록이 다르게 보일 이유는 없다 — 다른 것은 무엇을 할 수
 * 있는가이고, 그건 줄 안의 문장이 말한다.
 *
 * # 묶는 축이 다른 이유
 *
 * SSH 쪽은 서버 한 대의 목록이라 워크스페이스로 묶는다. 허브 쪽은 **사용자가
 * 노트북 앱에서 직접 만든 데스크탑**으로 묶는다 — 실제 컴퓨터 기기가 아니다.
 * 사이드바가 그 순서로 서 있고, 폰이 다른 축으로 서면 같은 세션을 두 화면에서
 * 다른 자리에서 찾게 된다. 그 구조는 카탈로그가 따로 실어 온다
 * (`src/lib/hub/sidebarLayout.ts`). 상태(전체/활성/종료) 칩은 그 자리를 차지하고
 * 있었으므로 뺐다 — 상태는 줄마다 점과 문장으로 이미 말한다.
 *
 * 그림만 그린다. 판단은 [`hubs`]와 [`sessionRows`]의 순수 함수가 한다.
 */

import { agentBadge, element, groupHeading, statusDot } from "./dom";
import type { HubDesktopGroup, HubSessionRow } from "./hubs";
import {
  groupHubRowsByDesktop,
  groupHubRowsByLayout,
  hubReach,
  toHubSessionRows,
} from "./hubs";
import { t } from "./i18n";
import type { HubLayout, HubProbe, HubRow } from "./ipc";

export interface HubSessionsModel {
  hub: HubRow;
  /** `undefined`는 "아직 붙어 보지 않았다"다 — 빈 목록("세션이 없다")과 다르다. */
  probe: HubProbe | undefined;
  /**
   * 폰이 기억하고 있는 이 컴퓨터의 묶음.
   *
   * 방금 받은 것이 없을 때 쓴다. 노트북을 막 켜면 카탈로그는 오는데 묶음은 아직
   * 안 온다(화면이 뜨기 전이다). 그때 기억이 없으면 목록이 몇 초 동안 다른 축으로
   * 섰다가 제자리로 돌아가고, 그 깜빡임은 앱이 흔들리는 것으로 읽힌다.
   */
  rememberedLayout?: HubLayout;
  busy: boolean;
}

export interface HubSessionsActions {
  back: () => void;
  refresh: () => void;
  open: (session: HubSessionRow) => void;
  openSpace?: (space: string) => void;
}

function spaceItem(group: HubDesktopGroup, actions: HubSessionsActions): HTMLElement {
  const item = element("li", "list__item");
  const open = element("button", "list__open");
  open.type = "button";
  const head = element("span", "card__row-meta");
  head.style.marginTop = "0";
  head.append(
    statusDot(group.rows.some((row) => row.ready) ? "run" : "unknown"),
    element("span", "card__row-title", t(group.label)),
  );
  open.append(head);
  const projects = [...new Set(group.rows.flatMap((row) => (row.project ? [row.project] : [])))];
  open.append(
    element("span", "list__note", `${t("세션")} ${group.rows.length}`),
    element("span", "card__row-mono", projects.join(" · ")),
  );
  open.addEventListener("click", () => actions.openSpace?.(group.label));
  item.append(open);
  return item;
}

/**
 * 세션 한 줄.
 *
 * `.list__open`을 유지한다: 기존 시험들이 라벨이 아니라 이 선택자로 줄을 찾고,
 * 그건 번역을 고칠 때 시험이 깨지지 않게 하려고 일부러 그렇게 쓰였다.
 */
function sessionItem(row: HubSessionRow, actions: HubSessionsActions): HTMLElement {
  const item = element("li", "list__item");
  const open = element("button", "list__open");
  open.type = "button";

  const head = element("span", "card__row-meta");
  head.style.marginTop = "0";
  head.append(statusDot(row.state), element("span", "card__row-title", row.title));
  open.append(head);

  const meta = element("span", "card__row-meta");
  meta.append(agentBadge(row.agent, row.label));
  // 사이드바에서 이 세션이 앉아 있는 프로젝트. 머리글을 두 겹으로 다는 대신
  // 줄 안에 적는다 — 데스크탑 안의 순서가 이미 프로젝트별로 뭉쳐 온다.
  if (row.project) meta.append(element("span", "card__row-mono", row.project));
  meta.append(element("span", "card__row-mono", row.session.box_label));
  open.append(meta);

  if (!row.ready) {
    // Under the list's "연결할 수 없음" heading; the row only dims and carries
    // its lifecycle word — no sentence (2026-09-15 승연, 안 3).
    meta.append(element("span", "card__row-mono", row.session.lifecycle));
    item.classList.add("card__row--unattachable");
    open.disabled = true;
  } else {
    open.append(element("span", "list__note", t("터미널 열기")));
    open.addEventListener("click", () => actions.open(row));
  }

  item.append(open);
  return item;
}

/** 상단 바. 컴퓨터 이름과, 어디서 닿는지. */
function header(model: HubSessionsModel, actions: HubSessionsActions): HTMLElement {
  const bar = element("div", "app-bar");

  const back = element("button", "icon-button", "‹");
  back.type = "button";
  back.setAttribute("aria-label", t("뒤로"));
  back.addEventListener("click", actions.back);

  const title = element("div");
  title.style.flex = "1";
  title.style.minWidth = "0";
  title.append(
    element("h1", "app-bar__title", model.hub.box_label || model.hub.endpoint),
    // 이 폰이 이 컴퓨터를 무엇으로 인식하고 있는지. 붙은 뒤에는 저쪽이 알려준
    // 기기 이름까지 적는다 — 화면이 기억한 값이 아니라 저쪽의 답이라, 폰을 두
    // 대 쓰는 사람이 어느 기기로 붙어 있는지 여기서 확인한다.
    element(
      "div",
      "card__row-mono",
      model.probe
        ? `${model.hub.endpoint} · ${model.probe.device_label}`
        : model.hub.endpoint,
    ),
  );

  const refresh = element("button", "icon-button", model.busy ? "…" : "↻");
  refresh.type = "button";
  refresh.setAttribute("aria-label", t("다시 조회"));
  refresh.disabled = model.busy;
  refresh.addEventListener("click", actions.refresh);

  bar.append(back, title, refresh);
  return bar;
}

/**
 * 대답하지 못한 상자를 화면에 남긴다.
 *
 * 허브는 여러 상자의 목록을 합쳐서 준다. 대답하지 못한 상자를 조용히 빼면
 * 사용자는 없는 세션을 죽은 세션으로 읽고, 폰을 꺼낸 이유가 바로 그 상자일 수
 * 있다 — `census.ts`가 SSH 경로에서 같은 규칙을 지킨다.
 */
function unreachable(list: readonly string[]): HTMLElement | undefined {
  if (list.length === 0) return undefined;
  const block = element("div", "failures");
  block.append(
    element("p", "failures__title", t("대답하지 못한 상자 {count}개", { count: list.length })),
  );
  const items = element("ul", "failures__list");
  for (const detail of list) {
    const item = element("li", "failures__item");
    item.append(element("span", "failures__detail", detail));
    items.append(item);
  }
  block.append(items);
  return block;
}

export function renderHubSessions(
  model: HubSessionsModel,
  actions: HubSessionsActions,
  selectedSpace?: string,
): HTMLElement {
  const screen = element("section", "screen");
  screen.append(header(model, actions));

  // 아직 붙어 보지 않은 상태. "세션이 없다"고 쓰지 않는 이유는 그게 거짓말이기
  // 때문이다.
  if (model.probe === undefined) {
    const empty = element("div", "empty");
    empty.append(
      element("p", undefined, model.busy ? t("연결 중…") : t("아직 연결하지 않았습니다")),
      element("p", "empty__hint", t(hubReach(model.hub))),
    );
    screen.append(empty);
    return screen;
  }

  const rows = toHubSessionRows(model.probe.sessions);

  if (rows.length === 0) {
    const empty = element("div", "empty");
    empty.append(element("p", undefined, t("이 컴퓨터에 세션이 없습니다")));
    screen.append(empty);
    const blocked = unreachable(model.probe.unreachable);
    if (blocked) screen.append(blocked);
    return screen;
  }

  // **사용자가 만든 데스크탑이 먼저다.** 사이드바가 그 순서로 서 있다.
  //
  // 묶음이 하나뿐이어도 제목을 단다. 하나일 때 감추면 둘이 되는 날 화면이 갑자기
  // 다른 모양이 된다.
  // 방금 받은 것이 먼저, 없으면 기억해 둔 것. 둘 다 없을 때만 다른 축으로 선다.
  const layout = model.probe.layout ?? model.rememberedLayout;
  const grouping = layout
    ? groupHubRowsByLayout(rows, layout)
    : // 구조를 아직 못 받았고 기억도 없다(이 컴퓨터에 처음 붙는 중). 아무것도 안
      // 그리면 세션이 없는 것과 구별되지 않으므로, 상자별로라도 그리고 그 사실을
      // 위에 적는다.
      { groups: groupHubRowsByDesktop(rows), hidden: 0 };

  if (!layout) {
    screen.append(
      element(
        "p",
        "banner banner--warn",
        t("컴퓨터에서 만든 묶음을 아직 받지 못했습니다. 컴퓨터별로 보여줍니다."),
      ),
    );
  }

  // 세션은 있는데 하나도 사이드바에 없다. "N개는 표시하지 않습니다" 한 줄만
  // 남으면 화면은 고장난 것처럼 보인다 — 무엇을 하면 보이는지까지 말한다.
  if (grouping.groups.length === 0) {
    const empty = element("div", "empty");
    empty.append(
      element(
        "p",
        undefined,
        t("이 컴퓨터의 세션 {count}개가 모두 사이드바 밖에 있습니다", { count: rows.length }),
      ),
      element(
        "p",
        "empty__hint",
        t("노트북 앱에서 데스크탑에 올려 둔 세션이 여기 보입니다."),
      ),
    );
    screen.append(empty);
    const blockedNow = unreachable(model.probe.unreachable);
    if (blockedNow) screen.append(blockedNow);
    return screen;
  }

  if (!selectedSpace) {
    const list = element("ul", "list");
    for (const group of grouping.groups) list.append(spaceItem(group, actions));
    screen.append(list);
  } else {
    const group = grouping.groups.find((candidate) => candidate.label === selectedSpace);
    if (!group) {
      const empty = element("div", "empty");
      empty.append(element("p", undefined, t("이 컴퓨터에 세션이 없습니다")));
      screen.append(empty);
      return screen;
    }
    // 이름을 번역기에 통과시킨다. 대부분은 사용자가 지은 이름이라 사전에 없고
    // 그대로 나오지만, 사이드바가 만든 "열리지 않은 에이전트" 묶음은 이 폰의
    // 언어로 서야 한다 — 노트북이 번역해 보내면 폰은 **노트북의 언어**로 된
    // 머리글을 보게 된다.
    const live = group.rows.filter((row) => row.ready);
    const unattachable = group.rows.filter((row) => !row.ready);
    if (live.length) {
      screen.append(groupHeading(t(group.label), live.length));
      const list = element("ul", "list");
      for (const row of live) list.append(sessionItem(row, actions));
      screen.append(list);
    }
    // Sessions that cannot be attached gather at the end under one heading —
    // the heading says why, once (2026-09-15 승연, 안 3).
    if (unattachable.length) {
      screen.append(groupHeading(t("연결할 수 없음"), unattachable.length));
      const list = element("ul", "list");
      for (const row of unattachable) list.append(sessionItem(row, actions));
      screen.append(list);
    }
  }

  // 안 그리는 것은 소유자 결정이지만, 몇 개를 뺐는지 아무 데도 안 적으면 사용자는
  // 세션이 사라졌다고 읽는다.
  if (grouping.hidden > 0) {
    screen.append(
      element(
        "p",
        "list__note",
        t("컴퓨터 화면에 없는 세션 {count}개는 표시하지 않습니다", {
          count: grouping.hidden,
        }),
      ),
    );
  }

  const blocked = unreachable(model.probe.unreachable);
  if (blocked) screen.append(blocked);

  return screen;
}
