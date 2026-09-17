/**
 * 서버 한 대의 세션 목록.
 *
 * `app.ts`가 1000줄을 넘어서 여기로 뺐다 — AGENTS.md의 god-file 규칙이다.
 * 그림만 그리고, 판단은 [`sessionRows`]의 순수 함수가 한다: 상태 축, 제공자
 * 축, 필터, 묶음. 화면에서 `lifecycle` 문자열을 다시 해석하는 곳은 없다.
 */

import type { ServerRow } from "./ipc";
import { agentBadge, chip, element, groupHeading, rowLead } from "./dom";
import { t } from "./i18n";
import type { RowFilter, SessionRow } from "./sessionRows";
import { groupRows, matchesFilter, toRow } from "./sessionRows";
import type { RemoteSession } from "./sessions";
import { sortSessions } from "./sessions";

export interface SessionListModel {
  server: ServerRow;
  /** `undefined`는 "아직 묻지 않았다"다 — 빈 배열("없다")과 다른 상태다. */
  sessions: readonly RemoteSession[] | undefined;
  filter: RowFilter;
  busy: boolean;
  /** The session being attached to right now, if any. */
  opening?: string;
}

export interface SessionListActions {
  back: () => void;
  refresh: () => void;
  setFilter: (filter: RowFilter) => void;
  open: (session: RemoteSession) => void;
}

/** 칩 라벨. 원문이 곧 번역 키다 — `t()`는 한국어 문장을 키로 쓴다. */
const FILTER_LABEL: Record<RowFilter, string> = {
  all: "전체",
  live: "활성",
  ended: "종료",
};

/**
 * 세션 한 줄.
 *
 * `.list__open` 클래스를 유지한다: 기존 시험들이 이 선택자로 줄을 찾고, 그
 * 시험들은 라벨 대신 구조로 찾도록 일부러 그렇게 쓰여 있다. 클래스를 바꾸면
 * 배선이 멀쩡한데도 시험이 깨지고, 그건 진짜 회귀와 구별되지 않는다.
 */
function sessionItem(
  row: SessionRow,
  opening: boolean,
  actions: SessionListActions,
): HTMLElement {
  const item = element("li", "list__item");
  const open = element("button", "list__open");
  open.type = "button";

  const head = element("span", "card__row-meta");
  head.style.marginTop = "0";
  head.append(rowLead(row.state, opening), element("span", "card__row-title", row.title));
  open.append(head);

  // 한 줄에 하나만. 제공자와 실행 프로그램을 나란히 적으면 `local-shell · ssh`가
  // 되는데, 앞쪽은 사용자에게 아무것도 말해주지 않으면서 자리를 먹는다.
  // 워크스페이스도 뺐다 — 이제 그룹 제목이 그 말을 한다.
  const meta = element("span", "card__row-meta");
  meta.append(agentBadge(row.agent, rowLabel(row)));
  open.append(meta);

  // 붙을 수 없는 세션은 그 이유를 적는다. 회색으로 비활성만 시키면 사용자는
  // 앱이 멈춘 줄 알고 계속 누른다.
  if (!row.session.ready) {
    // Under the list's "연결할 수 없음" heading; the row only dims and carries
    // its lifecycle word — no sentence (2026-09-15 승연, 안 3).
    meta.append(element("span", "card__row-mono", row.session.lifecycle));
    item.classList.add("card__row--unattachable");
    open.disabled = true;
  } else {
    open.append(element("span", "list__note", t("읽기 전용으로 연결")));
    open.addEventListener("click", () => actions.open(row.session));
  }

  item.append(open);
  return item;
}

/**
 * 한 줄에 적을 이름: 아는 것 중 가장 쓸모 있는 것.
 *
 * 실행 프로그램이 제공자를 이긴다. `hmux new -- ssh host`로 띄운 세션의 제공자는
 * `local-shell`인데, 그건 "터미널입니다"라는 말이라 목록에서 세션을 가르는 데
 * 쓸모가 없다. `ssh`는 쓸모가 있다.
 *
 * 에이전트 세션은 제공자가 곧 답이라(`claude`, `codex`) 그대로 남는다 — 그쪽은
 * 실행 프로그램을 기록하지 않거나, 기록해도 제공자만큼 말해주지 않는다.
 */
function rowLabel(row: SessionRow): string {
  return row.launchProgram ?? row.provider;
}

export function renderSessionList(
  model: SessionListModel,
  actions: SessionListActions,
): HTMLElement {
  const screen = element("section", "screen");

  const header = element("div", "app-bar");
  const back = element("button", "icon-button", "‹");
  back.type = "button";
  back.setAttribute("aria-label", t("뒤로"));
  back.addEventListener("click", actions.back);

  const title = element("div");
  title.style.flex = "1";
  title.style.minWidth = "0";
  title.append(element("h1", "app-bar__title", model.server.label || model.server.host));
  title.append(
    element(
      "div",
      "card__row-mono",
      `${model.server.username}@${model.server.host}`,
    ),
  );

  const refresh = element("button", "icon-button", model.busy ? "…" : "↻");
  refresh.type = "button";
  refresh.setAttribute("aria-label", t("다시 조회"));
  refresh.disabled = model.busy;
  refresh.addEventListener("click", actions.refresh);

  header.append(back, title, refresh);
  screen.append(header);

  // 아직 묻지 않은 상태. "세션이 없다"고 쓰지 않는 이유는 그게 거짓말이기
  // 때문이다 — 조회는 위 버튼이 한다.
  if (model.sessions === undefined) {
    const empty = element("div", "empty");
    empty.append(
      element("p", undefined, model.busy ? t("조회 중…") : t("아직 조회하지 않았습니다")),
      element(
        "p",
        "empty__hint",
        t("서버의 `hmux mobile-gateway`에 세션 목록을 요청해 찾습니다."),
      ),
    );
    screen.append(empty);
    return screen;
  }

  const rows = sortSessions(model.sessions).map(toRow);

  if (rows.length === 0) {
    const empty = element("div", "empty");
    empty.append(element("p", undefined, t("이 서버에 세션이 없습니다")));
    screen.append(empty);
    return screen;
  }

  // 칩은 세션이 있을 때만 그린다. 빈 목록 위의 필터는 누를 이유가 없다.
  const chips = element("div", "chips");
  for (const filter of ["all", "live", "ended"] as const) {
    const count = rows.filter((row) => matchesFilter(row, filter)).length;
    chips.append(
      chip(`${t(FILTER_LABEL[filter])} ${count}`, model.filter === filter, () =>
        actions.setFilter(filter),
      ),
    );
  }
  screen.append(chips);

  const visible = rows.filter((row) => matchesFilter(row, model.filter));

  // 필터가 전부 걸러낸 경우. 목록이 비어 보이는 것과 서버가 빈 것을 구별해
  // 말한다 — 같은 빈 화면이면 사용자는 세션이 사라졌다고 읽는다.
  if (visible.length === 0) {
    const empty = element("div", "empty");
    empty.append(
      element(
        "p",
        undefined,
        t("{filter}에 해당하는 세션이 없습니다", { filter: t(FILTER_LABEL[model.filter]) }),
      ),
      element("p", "empty__hint", t("전체 {total}개 중 0개", { total: rows.length })),
    );
    screen.append(empty);
    return screen;
  }

  // 묶음이 하나뿐이면 제목을 달지 않는다. "standalone 3"만 적힌 머리글은
  // 정보가 아니라 줄 하나를 잡아먹는 장식이다.
  const groups = groupRows(visible);
  const unattachable: Parameters<typeof sessionItem>[0][] = [];
  for (const group of groups) {
    const live = group.rows.filter((row) => row.session.ready);
    unattachable.push(...group.rows.filter((row) => !row.session.ready));
    if (!live.length) continue;
    if (groups.length > 1) screen.append(groupHeading(group.label, live.length));
    const list = element("ul", "list");
    for (const row of live) {
      list.append(sessionItem(row, row.session.session_id === model.opening, actions));
    }
    screen.append(list);
  }
  // Sessions that cannot be attached gather at the end under one heading —
  // the heading says why, once (2026-09-15 승연, 안 3).
  if (unattachable.length) {
    screen.append(groupHeading(t("연결할 수 없음"), unattachable.length));
    const list = element("ul", "list");
    for (const row of unattachable) {
      list.append(sessionItem(row, row.session.session_id === model.opening, actions));
    }
    screen.append(list);
  }

  return screen;
}
