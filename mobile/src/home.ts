/**
 * 홈 화면.
 *
 * # 무엇이 여기 없는지, 그리고 왜
 *
 * 디자인 시안에는 섹션이 더 있었다 — 상단 통계("시작된 Agents 1,284", "Agent
 * 시간 142h", "생성된 PR 96"), 작업(GitHub·Linear), 계정 사용량 쿼터 바.
 * 넣지 않았다. 이 앱은 그 숫자들을 세는 백엔드가 없고, 그럴듯한 값을 렌더하면
 * 화면이 측정하지 않은 것을 측정했다고 주장한다. 자리를 잡아두는 회색 상자도
 * 두지 않았다 — 영원히 비어 있는 카드는 고장으로 읽힌다.
 *
 * 지금 진짜인 것만 그린다: 서버와 그 응답 상태, 이 폰에서 마지막에 본 세션,
 * 페어링. 위 섹션들은 각각 데이터 출처가 생길 때 여기 돌아온다.
 */

import type { CensusFailure, CensusRow, ServerReport } from "./census";
import { failures, mergeSessions } from "./census";
import { hubReach, hubTitle, sortHubs } from "./hubs";
import type { HubRow, ServerRow } from "./ipc";
import type { RecentVisit } from "./recents";
import { card, cardRow, element, section, statusDot } from "./dom";
import { t } from "./i18n";
import { appLogo } from "./logo";
import { runState, summarize, toRow } from "./sessionRows";

/** 서버 한 대가 지금 어떤 상태인지, 화면이 그릴 수 있는 형태로. */
export interface ServerSummary {
  server: ServerRow;
  /** 두 번째 줄. 세션 수이거나, 대답하지 못한 이유. */
  detail: string;
  /** 점 색. 대답한 서버는 세션 상태를 따르고, 못 한 서버는 차단됨이다. */
  reachable: boolean;
  sessionCount: number;
}

/**
 * 서버별 요약을 만든다.
 *
 * 인구조사(census)를 아직 못 받았으면 `detail`이 "확인 중"이다 — "세션 없음"이
 * 아니다. 두 상태를 같은 문장으로 쓰면, 아직 묻지 않은 서버가 빈 서버로 읽힌다.
 */
export function summarizeServers(
  servers: readonly ServerRow[],
  reports: readonly ServerReport[] | undefined,
): ServerSummary[] {
  const rows = reports ? mergeSessions(reports) : undefined;
  const failed = new Map(
    (reports ? failures(reports) : []).map((failure) => [failure.serverId, failure]),
  );
  return servers.map((server) => {
    const failure = failed.get(server.id);
    if (failure) {
      return { server, detail: failure.message, reachable: false, sessionCount: 0 };
    }
    if (!rows) {
      return { server, detail: t("확인 중"), reachable: true, sessionCount: 0 };
    }
    // 조사는 돌았는데 이 서버가 그 안에 없는 경우. `not_attempted`("시간이
    // 모자라 물어보지 못했습니다")가 실제 결과 중 하나이고, 페어링 직후처럼
    // 서버 목록이 조사보다 새로울 수도 있다. 어느 쪽이든 "세션 없음"은 거짓말이
    // 된다 — 묻지 않은 것과 비어 있는 것은 다르고, 전자를 후자로 말하면
    // 사용자는 서버가 비었다고 믿고 폰을 닫는다.
    const answered = reports?.some((report) => report.server_id === server.id) ?? false;
    if (!answered) {
      return { server, detail: t("확인 중"), reachable: true, sessionCount: 0 };
    }
    const mine = rows.filter((row) => row.serverId === server.id);
    return {
      server,
      detail: summarize(mine.map((row) => toRow(row.session))),
      reachable: true,
      sessionCount: mine.length,
    };
  });
}

export interface HomeActions {
  /** 페어링한 컴퓨터 하나를 연다. 저장된 값으로 붙으므로 카메라가 열리지 않는다. */
  openHub: (hub: HubRow) => void;
  openServer: (server: ServerRow) => void;
  openRecent: (visit: RecentVisit) => void;
  /** 서버를 가로질러 모든 세션을 한 목록으로 보는 화면. */
  openAllSessions: () => void;
  startPairing: () => void;
  openSettings: () => void;
  refresh: () => void;
}

export interface HomeModel {
  /** 페어링한 컴퓨터. 앱을 켤 때 `hub_list`로 복원된다. */
  hubs: readonly HubRow[];
  servers: readonly ServerRow[];
  reports: readonly ServerReport[] | undefined;
  recents: readonly RecentVisit[];
  busy: boolean;
}

/** 상단 바. 제목과 설정 하나 — 시안과 같다. */
function appBar(actions: HomeActions): HTMLElement {
  const bar = element("div", "app-bar");
  bar.append(element("h1", "app-bar__title", "Dure"));

  const refresh = element("button", "icon-button", "↻");
  refresh.type = "button";
  // 클래스로 구별한다: `aria-label`은 `t()`를 지나므로 로케일마다 달라지고,
  // 그걸 선택자로 쓰는 시험은 번역을 고칠 때 깨진다.
  refresh.classList.add("icon-button--refresh");
  refresh.setAttribute("aria-label", t("다시 확인"));
  refresh.addEventListener("click", actions.refresh);

  const settings = element("button", "icon-button", "⚙");
  settings.type = "button";
  settings.classList.add("icon-button--settings");
  settings.setAttribute("aria-label", t("설정"));
  settings.addEventListener("click", actions.openSettings);

  bar.append(refresh, settings);
  return bar;
}

/**
 * 아무것도 페어링되지 않았을 때의 첫 화면.
 *
 * 로고가 여기 있는 이유: 이 화면은 앱을 처음 연 사람이 보는 유일한 화면이고,
 * QR을 스캔하기 전까지는 목록도 세션도 없어서 화면이 자기가 무슨 앱인지 말할
 * 다른 수단이 없다. 홈 화면 아이콘과 같은 파일을 쓴다(`logo.ts`).
 *
 * 문구는 "데스크탑에 연결"이 아니다 — SSH 경로는 페어링이 끝나면 노트북이
 * 경로에서 빠지고, 그게 그 기능이 존재하는 이유다. 화면이 데스크탑을 부르면
 * 노트북을 켜 둬야 하는 것처럼 읽힌다.
 */
export function renderEmpty(actions: HomeActions): HTMLElement {
  const host = element("div");
  host.append(appBar(actions));

  const hero = element("div", "hero");
  hero.append(appLogo(96));
  hero.append(
    element("h2", "hero__title", t("컴퓨터를 연결하세요")),
    element(
      "p",
      "hero__body",
      t("노트북에서 QR을 한 번 스캔하면, 그 뒤로는 폰이 그 컴퓨터의 에이전트 세션 목록을 직접 받아 옵니다."),
    ),
  );

  const action = element("button", "hero__action");
  action.type = "button";
  action.append(
    element("span", undefined, "▣"),
    element("span", undefined, t("QR 스캔으로 페어링")),
  );
  action.addEventListener("click", actions.startPairing);
  hero.append(action);
  host.append(hero);

  const guide = element("div", "screen");
  guide.append(element("h2", "section__label", t("진행 방법")));
  guide.append(
    (() => {
      const list = element("ol", "steps");
      // 두 갈래를 다 적는다. 위 버튼 하나가 둘 다 받고(스캔한 문자열을 보고
      // Rust가 어느 흐름인지 판별한다), 되는 일이 서로 다르다 — 하나만 적으면
      // 다른 쪽 QR을 든 사람은 자기 QR이 틀린 줄 안다.
      const items = [
        {
          title: t("노트북 앱에서 QR 열기"),
          body: t("설정 → 모바일. 릴레이를 켜 두면 같은 와이파이가 아니어도 붙습니다."),
        },
        {
          title: t("또는 노트북에서 명령 실행"),
          body: t("hmux pair offline — 서버에 SSH로 붙는 다른 길이고, QR과 6글자 코드가 함께 나옵니다."),
        },
        {
          title: t("위 버튼으로 스캔"),
          body: t("어느 QR인지는 앱이 알아서 구별합니다."),
        },
      ];
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
    })(),
  );
  host.append(guide);
  return host;
}

export function renderHome(model: HomeModel, actions: HomeActions): HTMLElement {
  if (model.servers.length === 0 && model.hubs.length === 0) return renderEmpty(actions);

  const host = element("div");
  host.append(appBar(actions));

  const screen = element("div", "screen");

  // 컴퓨터가 먼저다. 앱만 아는 것까지 나르는 경로이고, 사용자가 폰을 꺼내며
  // 떠올리는 단위가 "그 노트북"이지 "그 서버 계정"이 아니다.
  //
  // 상태 점을 찍지 않는다. 이 목록은 저장된 것을 그리는 것이라 지금 켜져
  // 있는지 모르고, 초록 점은 그걸 안다고 주장하게 된다 — 눌러서 붙어 봐야
  // 알 수 있고 그 답은 다음 화면에 있다.
  if (model.hubs.length > 0) {
    screen.append(
      section(
        t("컴퓨터"),
        card(
          ...sortHubs(model.hubs).map((hub) =>
            cardRow({
              title: hubTitle(hub),
              meta: [
                element("span", "card__row-mono", hub.endpoint),
                element("span", undefined, "·"),
                element("span", undefined, t(hubReach(hub))),
              ],
              onOpen: () => actions.openHub(hub),
            }),
          ),
        ),
      ),
    );
  }

  // 서버(SSH). 지금 터미널을 열 수 있는 유일한 경로라 컴퓨터 아래에 그대로 남는다.
  if (model.servers.length > 0) {
    const summaries = summarizeServers(model.servers, model.reports);
    screen.append(
      section(
        model.busy ? t("서버 · 확인 중") : t("서버"),
        card(
          ...summaries.map((summary) =>
            cardRow({
              lead: statusDot(summary.reachable ? "run" : "blocked"),
              title: summary.server.label || summary.server.host,
              meta: [
                element(
                  "span",
                  "card__row-mono",
                  `${summary.server.username}@${summary.server.host}`,
                ),
                element("span", undefined, "·"),
                element("span", undefined, summary.detail),
              ],
              onOpen: () => actions.openServer(summary.server),
            }),
          ),
        ),
      ),
    );
  }

  // 재개. 이 폰의 표현 상태라서 서버가 대답하지 않아도 보여줄 수 있다 —
  // 다만 눌렀을 때 붙지 못하면 그건 목록 화면이 말한다.
  if (model.recents.length > 0) {
    screen.append(
      section(
        t("재개"),
        card(
          ...model.recents.slice(0, 3).map((visit) =>
            cardRow({
              lead: element("span", "card__row-chevron", "❯"),
              title: visit.title,
              meta: `${visit.serverLabel}`,
              onOpen: () => actions.openRecent(visit),
            }),
          ),
        ),
      ),
    );
  }

  // 빠른 작업. 지금 진짜로 동작하는 것만 둔다 — 자리를 채우려고 동작하지 않는
  // 타일을 두면 그게 첫 고장 신고가 된다.
  const quick = element("div", "quick-grid");

  // "모든 세션"은 SSH 서버를 가로지르는 조사다. 컴퓨터만 있는 폰에서는 눌러도
  // "등록된 서버가 없습니다"로 끝나므로 아예 그리지 않는다.
  if (model.servers.length > 0) {
    const all = element("button", "quick-tile");
    all.type = "button";
    all.append(element("span", undefined, "≡"), element("span", undefined, t("모든 세션")));
    all.addEventListener("click", actions.openAllSessions);
    quick.append(all);
  }

  const pair = element("button", "quick-tile");
  pair.type = "button";
  // "서버 추가"가 아니다: 같은 버튼이 컴퓨터 QR도 받는다.
  pair.append(element("span", undefined, "▣"), element("span", undefined, t("QR 스캔")));
  pair.addEventListener("click", actions.startPairing);
  quick.append(pair);

  screen.append(section(t("빠른 작업"), quick));

  host.append(screen);
  return host;
}

/**
 * 대답하지 못한 서버를 홈 아래에 모아 적는다.
 *
 * 목록에서 조용히 빼지 않는다 — 사라진 서버는 없는 서버로 읽히고, 사용자가
 * 폰을 꺼낸 이유가 바로 그 서버일 수 있다. `census.ts`가 이미 같은 규칙을
 * 지키고 있어서 문장을 그대로 쓴다.
 */
export function renderUnreachable(list: readonly CensusFailure[]): HTMLElement | undefined {
  if (list.length === 0) return undefined;
  const host = element("div", "blockers");
  host.append(
    element("h2", undefined, t("대답하지 못한 서버 {count}대", { count: list.length })),
  );
  const items = element("ul");
  for (const failure of list) {
    const item = element("li");
    item.append(element("span", undefined, `${failure.serverLabel}: ${failure.message}`));
    if (failure.detail) item.append(element("div", "list__note", failure.detail));
    items.append(item);
  }
  host.append(items);
  return host;
}

/**
 * 모든 서버의 세션을 한 줄로 합친 목록에서, 살아 있는 것만 앞으로.
 *
 * 홈이 아니라 목록 화면이 쓰는 정렬이지만 여기 두는 이유는 `CensusRow`를 다루는
 * 로직이 이미 여기 모여 있기 때문이다.
 */
export function liveFirst(rows: readonly CensusRow[]): CensusRow[] {
  const rank = (row: CensusRow): number => {
    const state = runState(row.session);
    if (state === "run") return 0;
    if (state === "warn") return 1;
    if (state === "unknown") return 2;
    if (state === "blocked") return 3;
    return 4;
  };
  return [...rows].sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) return byRank;
    return left.serverLabel.localeCompare(right.serverLabel, "ko");
  });
}
