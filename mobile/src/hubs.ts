/**
 * 페어링한 컴퓨터(허브)의 순수 로직. Tauri/DOM 없이 테스트된다.
 *
 * # 왜 SSH 서버와 같은 목록이 아닌가
 *
 * 두 경로는 공존하고, 무엇을 할 수 있는지가 서로 다르다. 허브는
 * 앱이 켜져 있어야 닿고 대신 앱만 아는 것까지 나르며, SSH는 앱이 꺼져 있어도
 * 닿는다. 한 목록에 섞으면 줄마다 되는 일이 달라지는데 화면은 그것을 말하지
 * 않게 되고, 사용자는 눌러 보고 나서야 안다.
 *
 * 표시 축(`state`, `agent`)은 [`sessionRows`]의 함수를 그대로 쓴다. 여기서 다시
 * 만들면 같은 상태의 세션이 두 화면에서 다른 색으로 뜬다.
 */

import type { HubLayout, HubProbeSession, HubRow } from "./ipc";
import type { AgentKind, GroupableRow, RunState } from "./sessionRows";
import { agentKind, lifecycleState } from "./sessionRows";

/**
 * 목록에 그릴 컴퓨터 한 줄.
 *
 * `id`(인증서 지문)를 라벨의 폴백으로 쓰지 않는다 — 지문은 사람이 기계를
 * 알아보는 데 쓸 수 없는 값이고, 라벨이 빈 컴퓨터는 주소로 부르는 편이 낫다.
 */
export function hubTitle(hub: HubRow): string {
  const label = hub.box_label.trim();
  return label.length > 0 ? label : hub.endpoint;
}

/**
 * 정렬: 이름, 그다음 id.
 *
 * 이름이 같은 컴퓨터 둘(공장 기본 호스트명은 흔하다)이 화면을 새로 그릴 때마다
 * 자리를 바꾸지 않도록 id까지 내려가서 결정한다.
 */
export function sortHubs(hubs: readonly HubRow[]): HubRow[] {
  return [...hubs].sort((left, right) => {
    const byTitle = hubTitle(left).localeCompare(hubTitle(right), "ko");
    if (byTitle !== 0) return byTitle;
    return left.id.localeCompare(right.id, "ko");
  });
}

/**
 * 이 컴퓨터에 어디서 닿을 수 있는지, 한 줄로.
 *
 * 이 문장이 목록에 있는 이유: 릴레이가 없는 컴퓨터는 집을 나서는 순간 조용히
 * 안 붙는데, 그 실패는 앱이 고장난 것과 구별되지 않는다. 나가기 전에 읽을 수
 * 있는 자리는 목록뿐이다.
 *
 * `t()`를 여기서 부르지 않고 한국어 원문(=번역 키)을 돌려준다. 화면이 번역하고,
 * 이 함수는 로케일과 무관하게 같은 값을 돌려주는 순수 함수로 남는다 —
 * `sessionListView`의 `FILTER_LABEL`이 같은 규칙이다.
 */
export function hubReach(hub: HubRow): string {
  return reachOf(hub.relay_offered);
}

/**
 * The same sentence for an offer that is not a saved row yet.
 *
 * The confirm screen runs before anything is stored, so it has no `HubRow` to
 * ask. Kept beside `hubReach` rather than copied: two copies of a sentence
 * drift, and a phone that says "reachable from anywhere" in one screen and
 * "pair again" in the next is describing two different computers.
 */
export function reachOf(relayOffered: boolean): string {
  return relayOffered
    ? "밖에서도 연결됩니다"
    : "인터넷 릴레이가 없습니다 · 다시 페어링하세요";
}

/** 허브 세션 한 줄. [`sessionRows.SessionRow`]의 허브판이다. */
export interface HubSessionRow extends GroupableRow {
  session: HubProbeSession;
  /** 굵은 제목 — 세션 이름, 없으면 세션 id. */
  title: string;
  state: RunState;
  agent: AgentKind;
  /** 묶음 키. 데스크탑(워크스페이스)이다. */
  workspace: string;
  /**
   * 뱃지에 적을 이름: 아는 것 중 가장 쓸모 있는 것.
   *
   * 실행 프로그램이 제공자를 이긴다 — `hmux new -- ssh host`로 띄운 세션의
   * 제공자는 `local-shell`이고, 그건 "터미널입니다"라는 말이라 목록에서 세션을
   * 가르는 데 쓸모가 없다. `sessionListView`가 SSH 경로에서 같은 규칙을 쓴다.
   */
  label: string;
  /** Rust가 계산해 준 값 그대로. 화면이 `lifecycle`을 다시 해석하지 않는다. */
  ready: boolean;
  /**
   * 노트북 사이드바에서 이 세션이 속한 프로젝트. 묶음을 받았을 때만 있다.
   *
   * 머리글을 두 겹으로 달지 않으려고 줄 안에 적는다. 데스크탑 안의 순서가 이미
   * 프로젝트별로 뭉쳐 오므로(`buildSidebarLayout`), 줄에 이름만 있으면 사이드바와
   * 같은 모양으로 읽힌다.
   */
  project?: string;
}

export function toHubSessionRow(session: HubProbeSession): HubSessionRow {
  const name = session.session_name?.trim();
  return {
    session,
    // id를 앞 몇 자로 자르지 않는다: 같은 접두사를 가진 두 세션이 화면에서
    // 구별되지 않게 되고, 그 상태로 고른 세션은 사용자가 고를 수 없는 것을
    // 고른 것이 된다. `sessions.sessionTitle`이 같은 이유로 같은 규칙이다.
    title: name && name.length > 0 ? name : session.session_id,
    state: lifecycleState(session.lifecycle),
    agent: agentKind(session.provider_id),
    workspace: session.workspace_id,
    label: session.launch_program ?? session.provider_id,
    ready: session.ready,
  };
}

/**
 * 정렬: 붙을 수 있는 세션이 먼저, 그다음 이름.
 *
 * 허브 카탈로그는 상자·워크스페이스 순으로 오기 때문에, 종료된 세션이 위에
 * 쌓이면 살아 있는 세션을 찾으려고 스크롤해야 한다. 폰에서 그 스크롤은
 * 목록을 못 쓰게 만드는 것과 같다.
 */
export function sortHubSessionRows(rows: readonly HubSessionRow[]): HubSessionRow[] {
  return [...rows].sort((left, right) => {
    if (left.ready !== right.ready) return left.ready ? -1 : 1;
    const byTitle = left.title.localeCompare(right.title, "ko");
    if (byTitle !== 0) return byTitle;
    return left.session.session_id.localeCompare(right.session.session_id, "ko");
  });
}

/** 목록 하나를 화면이 그릴 행들로. 매핑과 정렬을 한 번에 지나간다. */
export function toHubSessionRows(sessions: readonly HubProbeSession[]): HubSessionRow[] {
  return sortHubSessionRows(sessions.map(toHubSessionRow));
}

/** 한 데스크탑과 거기 있는 세션들. */
export interface HubDesktopGroup {
  /** 화면에 그대로 적는 이름. */
  readonly label: string;
  readonly rows: HubSessionRow[];
}

/**
 * 묶음을 아직 못 받았을 때의 대체 묶기 — **상자별**.
 *
 * 사용자가 만든 데스크탑이 진짜 축이다([`groupHubRowsByLayout`]). 이 함수는 그
 * 구조가 아직 안 왔을 때만 쓴다. 그때 아무것도 안 그리면 화면은 세션이 없는 것과
 * 구별되지 않고, 그건 이 목록이 말하려던 것과 정반대다.
 *
 * 묶는 축이 `box_label` 인 이유는 그것이 카탈로그가 나르는 **읽을 수 있는 유일한
 * 이름**이기 때문이다. 워크스페이스는 id 만 오고, 그것을 제목으로 쓰면 사람이
 * 알아볼 수 없는 문자열이 화면 머리에 온다.
 *
 * 살아 있는 세션이 있는 상자가 먼저다. 폰을 꺼낸 사람이 찾는 것은 지금 도는
 * 것이고, 꺼진 기계가 위에 있으면 그만큼 스크롤한다.
 */
export function groupHubRowsByDesktop(rows: readonly HubSessionRow[]): HubDesktopGroup[] {
  const groups = new Map<string, HubDesktopGroup>();
  for (const row of rows) {
    const label = row.session.box_label.trim() || "이름 없는 컴퓨터";
    const existing = groups.get(label);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(label, { label, rows: [row] });
    }
  }
  const isLive = (group: HubDesktopGroup): boolean =>
    group.rows.some((row) => row.state === "run" || row.state === "warn");
  return [...groups.values()].sort((left, right) => {
    if (isLive(left) !== isLive(right)) return isLive(left) ? -1 : 1;
    return left.label.localeCompare(right.label, "ko");
  });
}

/** 묶은 결과와, 묶이지 않아 화면에서 뺀 수. */
export interface HubGrouping {
  readonly groups: HubDesktopGroup[];
  /**
   * 사이드바에 없어서 그리지 않은 세션의 수.
   *
   * 세는 이유: 안 그리는 것은 소유자 결정이지만, 몇 개를 뺐는지 아무 데도 안
   * 적으면 사용자는 세션이 **사라졌다**고 읽는다. 화면은 이 수를 한 줄로만 말한다.
   */
  readonly hidden: number;
}

/**
 * 세션을 **사용자가 노트북에서 만든 데스크탑별로** 묶는다.
 *
 * 이것이 이 목록의 진짜 축이다. 상자(기계)로 묶으면 사이드바와 다른 축이 되고,
 * 사용자는 같은 세션을 두 화면에서 다른 자리에서 찾게 된다. 데스크탑은 이 앱에서
 * 만든 것이라 hmux 도 카탈로그도 모르고, 그래서 노트북 화면이 표를 따로 내려보낸다
 * (`src/lib/hub/sidebarLayout.ts`).
 *
 * # 표에 없는 세션은 그리지 않는다
 *
 * 사이드바에 없는 세션은 사용자가 정리한 적 없는 것이다. 억지로 "분류 없음" 묶음을
 * 만들면 그런 것들이 목록 아래에 쌓이고, 그건 사이드바를 정리한 사람이 보려던
 * 화면이 아니다(2026-08-12 소유자 결정). 대신 [`HubGrouping.hidden`] 으로 몇 개를
 * 뺐는지는 말한다.
 *
 * # 순서는 사이드바가 정한다
 *
 * 데스크탑은 `desktop_order` 그대로, 그 안은 `order` 그대로다. 여기서 다시
 * 정렬하면 — 살아 있는 것을 위로 올린다든지 — 폰과 사이드바가 다른 순서로 서고,
 * 그 차이는 두 화면을 나란히 보는 사람에게만 보인다.
 */
export function groupHubRowsByLayout(
  rows: readonly HubSessionRow[],
  layout: HubLayout,
): HubGrouping {
  const seated = new Map<string, { order: number; row: HubSessionRow }[]>();
  let hidden = 0;

  for (const row of rows) {
    const seat = layout.placements[row.session.session_id];
    // 표에 없거나, 표에는 있는데 데스크탑 순서에는 없는 자리. 뒤엣것은 노트북
    // 화면이 방금 지운 데스크탑이라, 폰이 되살릴 자리가 아니다.
    if (!seat || !layout.desktop_order.includes(seat.desktop)) {
      hidden += 1;
      continue;
    }
    const placed = { order: seat.order, row: { ...row, project: seat.project } };
    const existing = seated.get(seat.desktop);
    if (existing) existing.push(placed);
    else seated.set(seat.desktop, [placed]);
  }

  const groups: HubDesktopGroup[] = [];
  for (const label of layout.desktop_order) {
    const desktopRows = seated.get(label);
    if (!desktopRows || desktopRows.length === 0) continue;
    groups.push({
      label,
      rows: [...desktopRows].sort((left, right) => left.order - right.order).map(({ row }) => row),
    });
  }
  return { groups, hidden };
}
