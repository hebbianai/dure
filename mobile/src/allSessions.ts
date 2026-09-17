/**
 * 두 경로에서 온 세션을 **한 목록**으로. Tauri/DOM 없이 시험된다.
 *
 * 폰은 같은 세션에 두 길로 닿는다. SSH 로 서버에 직접 붙는 길과, 노트북의 허브를
 * 거치는 길이다. 지금까지
 * 두 길은 두 화면이었고, 그래서 사용자는 자기 세션을 찾으려면 어느 길로 오는
 * 것인지를 먼저 알아야 했다 — 그건 앱의 사정이지 사용자의 관심사가 아니다.
 *
 * 이 파일은 그 둘을 사용자가 노트북에서 만든 데스크탑 아래에 함께 세운다.
 *
 * # 무엇이 어느 목록에 있는가
 *
 * - **허브 카탈로그**는 노트북 로컬 세션과 노트북이 닿는 원격 세션을 함께 나른다.
 *   노트북이 꺼지면 통째로 사라진다.
 * - **SSH 인구조사**는 등록한 서버들의 세션이다. 노트북과 무관하게 살아 있다.
 *
 * 그래서 노트북을 끄면 데스크탑 묶음은 서 있는데 그 안의 로컬 줄만 없어진다.
 * 그것이 사용자가 설계한 모양이다 — 서버 줄은 열리고 노트북 줄은 못 연다.
 *
 * # 없어진 줄을 지어내지 않는다
 *
 * 기억하고 있는 것은 **자리**뿐이다(`layout_store`). 제목·제공자·상태는 기억하지
 * 않는다. 그래서 지금 어느 목록에도 없는 세션은 줄로 그리지 않되, 사용자가
 * 만든 데스크탑 묶음은 남겨 둔다.
 *
 * 제목을 캐시하지 않는 것은 자리 문제가 아니라 판단이다. 제목은 대화 내용에서
 * 나온다(`conv.rs`). 그것을 폰의 평문 파일에 남기는 것은 별도의 결정이고, 이
 * 화면을 위해 슬쩍 넘어갈 일이 아니다.
 */

import type { CensusRow } from "./census";
import type { HubLayout, HubPlacement, HubProbeSession } from "./ipc";
import type { AgentKind, RunState } from "./sessionRows";
import { agentKind, lifecycleState } from "./sessionRows";
import type { RemoteSession } from "./sessions";

/** 이 줄이 어느 길로 왔는지, 그리고 여는 데 필요한 것. */
export type UnifiedSource =
  | {
      kind: "ssh";
      serverId: string;
      serverLabel: string;
      reachable: boolean;
      session: RemoteSession;
    }
  | {
      kind: "hub";
      hubId: string;
      hubLabel: string;
      reachable: boolean;
      session: HubProbeSession;
    };

/**
 * Can the row be attached to: the machine answers *and* the session is up.
 *
 * Both arms of `UnifiedSource` carry `reachable`, so neither this nor any
 * caller has to ask which transport a row came by. That question used to be
 * asked inline as `kind !== "hub" || reachable`, which quietly meant every SSH
 * row was reachable — the whole reason a dead server's projects fell out of the
 * list instead of going dim.
 */
export function sourceOpenable(source: UnifiedSource): boolean {
  return source.reachable && source.session.ready;
}

/** 합친 목록의 한 줄. */
export interface UnifiedRow {
  /** hmux 세션 id. 두 목록이 같은 세션을 가리킬 때 쓰는 값이다. */
  sessionId: string;
  title: string;
  state: RunState;
  agent: AgentKind;
  /** 뱃지에 적을 이름 — 실행 프로그램이 제공자를 이긴다. */
  label: string;
  /** 사이드바에서 이 세션이 속한 프로젝트. */
  project: string;
  /** 그 세션이 올라앉은 git 브랜치. 노트북이 모르면 없다. */
  branch?: string;
  /** 사이드바에서의 자리. 정렬에만 쓴다. */
  order: number;
  source: UnifiedSource;
}

/** 한 데스크탑. */
export interface UnifiedGroup {
  readonly label: string;
  readonly rows: UnifiedRow[];
}

export interface UnifiedListing {
  readonly groups: UnifiedGroup[];
  /**
   * 살아 있는데 사이드바에 자리가 없어 그리지 않은 세션의 수.
   *
   * 안 그리는 것은 소유자 결정이지만(2026-08-12), 몇 개인지 아무 데도 안 적으면
   * 사용자는 세션이 사라졌다고 읽는다.
   */
  readonly hidden: number;
}

/**
 * 노트북 여러 대의 묶음을 하나로.
 *
 * 노트북 두 대를 페어링한 사람은 사이드바도 두 벌이고, 이 화면은 한 벌이다.
 * 합치는 규칙은 **먼저 나온 쪽이 이긴다**: 허브 id 순으로 훑으므로 화면을 다시
 * 그려도 같은 결과가 나온다. 시각 순으로 하면 두 노트북이 같은 서버 세션을
 * 각자의 데스크탑에 놓았을 때 줄이 화면마다 다른 묶음으로 튄다.
 *
 * 두 노트북에 같은 이름의 데스크탑이 있으면 한 묶음이 된다. 이름이 겹치는 것
 * 이상의 일은 일어나지 않아서 그대로 둔다 — 구별하려면 머리글마다 어느 컴퓨터인지
 * 를 달아야 하고, 그건 대부분의 사용자에게 없는 문제의 값을 매 줄에 물리는 것이다.
 */
export function mergeLayouts(layouts: Record<string, HubLayout>): HubLayout {
  const placements: Record<string, HubPlacement> = {};
  const desktopOrder: string[] = [];
  for (const hubId of Object.keys(layouts).sort()) {
    const layout = layouts[hubId];
    for (const name of layout.desktop_order) {
      if (!desktopOrder.includes(name)) desktopOrder.push(name);
    }
    for (const [sessionId, seat] of Object.entries(layout.placements)) {
      if (!placements[sessionId]) placements[sessionId] = seat;
    }
  }
  return { placements, desktop_order: desktopOrder };
}

/**
 * What the laptop calls each session, by session id.
 *
 * A paired computer's listing carries the title its sidebar draws (the hub
 * catalog's `display_title`, folded into `session_name` on the way in). The
 * SSH census carries only the hmux session name, and for an agent that is the
 * worktree slug — `codex-14`, `feat/mobile` — which on the phone read as a
 * list of branches. So whichever route a row is drawn from, the laptop's word
 * for the session wins over hmux's, and the phone names it as the sidebar does.
 *
 * First computer wins, in listing order, for the same reason `mergeLayouts`
 * lets the first hub win: the same result on every redraw.
 */
function laptopTitles(hubs: readonly HubSessions[]): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  for (const hub of hubs) {
    for (const session of hub.sessions) {
      const name = session.session_name?.trim();
      if (name && name.length > 0 && !titles.has(session.session_id)) {
        titles.set(session.session_id, name);
      }
    }
  }
  return titles;
}

/** 어느 경로든 합친 목록의 한 줄로. */
function fromSource(
  source: UnifiedSource,
  seat: HubPlacement,
  titles: ReadonlyMap<string, string>,
): UnifiedRow {
  const name = titles.get(source.session.session_id) ?? source.session.session_name?.trim();
  return {
    sessionId: source.session.session_id,
    title: name && name.length > 0 ? name : source.session.session_id,
    state: lifecycleState(source.session.lifecycle),
    agent: agentKind(source.session.provider_id),
    label: source.session.launch_program ?? source.session.provider_id,
    project: seat.project,
    branch: seat.branch ?? undefined,
    order: seat.order,
    source,
  };
}

/** 이 함수가 읽는 만큼의 허브 조회 결과. */
export interface HubSessions {
  readonly hubId: string;
  readonly hubLabel: string;
  readonly reachable: boolean;
  readonly sessions: readonly HubProbeSession[];
}

/** 열 수 있는 경로가 먼저고, 같은 상태면 직접 SSH가 먼저다. */
function preferredSources(input: {
  readonly census: readonly CensusRow[];
  readonly hubs: readonly HubSessions[];
}): UnifiedSource[] {
  const sources: UnifiedSource[] = [
    ...input.census.map(
      (row): UnifiedSource => ({
        kind: "ssh",
        serverId: row.serverId,
        serverLabel: row.serverLabel,
        reachable: row.reachable,
        session: row.session,
      }),
    ),
    ...input.hubs.flatMap((hub) =>
      hub.sessions.map(
        (session): UnifiedSource => ({
          kind: "hub",
          hubId: hub.hubId,
          hubLabel: hub.hubLabel,
          reachable: hub.reachable,
          session,
        }),
      ),
    ),
  ];
  return sources.sort(
    (left, right) => Number(sourceOpenable(right)) - Number(sourceOpenable(left)),
  );
}

/**
 * Which paired computer can answer about this session.
 *
 * Not "which list did the row come from". [`buildUnifiedListing`] prefers the
 * direct SSH entry when both routes are equally openable, so a row opened from
 * there would otherwise have no hub to ask — even though the same laptop is
 * paired and lists the very same session id one catalog over. Which transport
 * opened the terminal has nothing to do with which computer knows the repository.
 */
export function hubKnowing(
  hubs: readonly HubSessions[],
  sessionId: string,
): string | undefined {
  return hubs.find((hub) => hub.sessions.some((session) => session.session_id === sessionId))
    ?.hubId;
}

/**
 * 두 목록과 배치표를 받아 화면이 그릴 묶음으로.
 *
 * # 같은 세션이 두 목록에 있으면 열 수 있는 경로가 이긴다
 *
 * 둘 다 열리거나 둘 다 닫혔으면 직접 SSH 쪽이 먼저다. 한쪽만 열리면 그 경로를
 * 남긴다. 끊긴 직접 서버가 살아 있는 허브 경로까지 가리면 안 된다.
 */
export function buildUnifiedListing(input: {
  readonly census: readonly CensusRow[];
  readonly hubs: readonly HubSessions[];
  readonly layout: HubLayout;
}): UnifiedListing {
  const { census, hubs, layout } = input;
  const titles = laptopTitles(hubs);
  const known = new Set(layout.desktop_order);
  const byDesktop = new Map<string, UnifiedRow[]>();
  const seen = new Set<string>();
  let hidden = 0;

  const place = (sessionId: string, make: (seat: HubPlacement) => UnifiedRow): void => {
    if (seen.has(sessionId)) return;
    seen.add(sessionId);
    const seat = layout.placements[sessionId];
    // 자리가 없거나, 자리는 있는데 그 데스크탑이 순서에 없다(노트북 화면이 방금
    // 지운 데스크탑이다). 어느 쪽이든 폰이 되살릴 자리가 아니다.
    if (!seat || !known.has(seat.desktop)) {
      hidden += 1;
      return;
    }
    const rows = byDesktop.get(seat.desktop);
    if (rows) rows.push(make(seat));
    else byDesktop.set(seat.desktop, [make(seat)]);
  };

  for (const source of preferredSources({ census, hubs })) {
    place(source.session.session_id, (seat) => fromSource(source, seat, titles));
  }

  // 자리는 있는데 지금 어느 목록에도 없는 세션. 세션 수는 노출하지 않고,
  // 사용자가 만든 데스크탑 묶음을 남길 정도의 존재 여부만 기억한다.
  const remembered = new Set<string>();
  for (const [sessionId, seat] of Object.entries(layout.placements)) {
    if (seen.has(sessionId) || !known.has(seat.desktop)) continue;
    remembered.add(seat.desktop);
  }

  const groups: UnifiedGroup[] = [];
  for (const label of layout.desktop_order) {
    const rows = byDesktop.get(label) ?? [];
    // 줄도 없고 안 보이는 것도 없는 묶음은 머리글만 남는다. 빈 머리글이 서면
    // 사용자는 세션이 사라졌다고 읽는다.
    if (rows.length === 0 && !remembered.has(label)) continue;
    groups.push({
      label,
      rows: rows.sort((left, right) => left.order - right.order),
    });
  }

  return { groups, hidden };
}

/**
 * 이 폰이 이름을 댈 수 있는 모든 세션 — 노트북이 자리를 publish 했든 안 했든.
 *
 * `buildUnifiedListing`은 사이드바 자리가 있는 세션만 통과시킨다. 그건 홈 화면이
 * 데스크탑 탭을 세우기 위한 규칙이고, 자리가 없으면 홈은 `flattenRows`로 떨어져
 * 평평한 목록을 그린다. 그 두 갈래를 화면마다 다시 쓰면 한 화면은 세션을 알고
 * 다른 화면은 모르는 상태가 된다 — 실제로 인박스 화면이 그랬다: 레이아웃이 없는
 * 동안 "세션 열기"가 홈에서는 나오고 인박스에서는 나오지 않았다.
 */
export function allSessionRows(input: {
  readonly census: readonly CensusRow[];
  readonly hubs: readonly HubSessions[];
  readonly layout: HubLayout;
}): UnifiedRow[] {
  const listing = buildUnifiedListing(input);
  if (listing.groups.length > 0) return listing.groups.flatMap((group) => group.rows);
  return flattenRows({ census: input.census, hubs: input.hubs });
}

/** One project inside a desktop — the sidebar's repository grouping. */
export interface ProjectGroup {
  readonly label: string;
  readonly rows: UnifiedRow[];
}

/**
 * Split one desktop's rows into the projects the sidebar put them in.
 *
 * The desktop is the tab; the project is the heading under it. Both come from
 * the same placement the laptop published, so the phone and the sidebar break
 * the list at the same places.
 *
 * Rows with no project keep their order in a single unlabelled group rather
 * than being invented a heading. A group named for something the user never
 * created reads as a folder they forgot making.
 */
export function groupByProject(rows: readonly UnifiedRow[]): ProjectGroup[] {
  const groups: ProjectGroup[] = [];
  const byLabel = new Map<string, ProjectGroup>();
  // Insertion order, which is placement order — the rows arrive already sorted
  // by `order`, so re-sorting here would fight the sidebar for the same axis.
  for (const row of rows) {
    const label = row.project.trim();
    const existing = byLabel.get(label);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    const group: ProjectGroup = { label, rows: [row] };
    byLabel.set(label, group);
    groups.push(group);
  }
  return groups;
}

/**
 * 묶음을 모를 때 쓰는, 묶지 않은 줄들.
 *
 * 노트북을 한 번도 페어링하지 않은 사람에게는 데스크탑이라는 것이 없다. 그 사람의
 * 화면을 [`buildUnifiedListing`] 으로 그리면 모든 줄이 "자리 없음" 으로 떨어져
 * 목록이 통째로 사라진다.
 *
 * 정렬은 예전 인구조사 화면 그대로다 — 붙을 수 있는 것 먼저, 그다음 기계 이름,
 * 그다음 세션 이름. 이 갈래에는 사이드바 순서라는 것이 없으므로 화면이 스스로
 * 정해야 하고, 폰을 꺼낸 사람이 찾는 것은 지금 도는 것이다.
 */
export function flattenRows(input: {
  readonly census: readonly CensusRow[];
  readonly hubs: readonly HubSessions[];
}): UnifiedRow[] {
  // 자리가 없으므로 자리 값은 빈 것으로 둔다. 화면은 `project` 가 비면 그 칸을
  // 그리지 않는다 — 여기서 그럴듯한 이름을 지어내면 그건 사용자가 만든 적 없는
  // 묶음 이름이 된다.
  const seat: HubPlacement = { desktop: "", project: "", order: 0 };
  const titles = laptopTitles(input.hubs);
  const rows: UnifiedRow[] = [];
  const seen = new Set<string>();
  for (const source of preferredSources(input)) {
    if (seen.has(source.session.session_id)) continue;
    seen.add(source.session.session_id);
    rows.push(fromSource(source, seat, titles));
  }
  const openable = (row: UnifiedRow): boolean => sourceOpenable(row.source);
  const machine = (row: UnifiedRow): string =>
    row.source.kind === "ssh" ? row.source.serverLabel : row.source.hubLabel;
  return rows.sort((left, right) => {
    if (openable(left) !== openable(right)) return openable(left) ? -1 : 1;
    const byMachine = machine(left).localeCompare(machine(right), "ko");
    if (byMachine !== 0) return byMachine;
    const byTitle = left.title.localeCompare(right.title, "ko");
    if (byTitle !== 0) return byTitle;
    return left.sessionId.localeCompare(right.sessionId, "ko");
  });
}
