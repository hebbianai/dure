/** 세션 목록을 화면 행으로 옮기는 순수 로직. Tauri/DOM 없이 테스트된다. */

import type { RemoteSession } from "./sessions";
import { t } from "./i18n";
import { sessionTitle } from "./sessions";

/**
 * 행 왼쪽 점의 색.
 *
 * `lifecycle` 문자열을 화면에서 다시 해석하는 게 아니라, 표시용 축으로 한 번만
 * 접는다. 데스크탑의 `--status-*`와 같은 네 값을 쓰는데, 두 앱이 나란히 놓였을
 * 때 같은 상태가 다른 색이면 그건 색이 아니라 정보가 어긋난 것이다.
 *
 * 모르는 `lifecycle`은 `unknown`이다 — 초록으로 떨어지지 않는다. 상태를 모르는
 * 세션을 "실행 중"으로 그리는 건 화면이 아는 척하는 것이고, 그 화면을 보고
 * 사람이 판단한다.
 */
export type RunState = "run" | "warn" | "blocked" | "done" | "unknown";

const LIFECYCLE_STATE: Record<string, RunState> = {
  ready: "run",
  running: "run",
  starting: "warn",
  restoring: "warn",
  degraded: "warn",
  blocked: "blocked",
  failed: "blocked",
  ended: "done",
  exited: "done",
  stopped: "done",
};

/**
 * `lifecycle` 문자열 하나를 표시 축으로.
 *
 * 세션 타입이 아니라 문자열을 받는 이유: 허브 경로의 세션(`HubProbeSession`)은
 * SSH 경로의 `RemoteSession`과 다른 모양인데, **같은 상태는 같은 색이어야
 * 한다.** 두 경로가 각자 이 표를 갖게 두면 한쪽에 `restoring`이 추가된 날 같은
 * 세션이 두 화면에서 다른 색으로 뜬다.
 */
export function lifecycleState(lifecycle: string): RunState {
  return LIFECYCLE_STATE[lifecycle.trim().toLowerCase()] ?? "unknown";
}

export function runState(session: RemoteSession): RunState {
  return lifecycleState(session.lifecycle);
}

/** 알려진 제공자. 색을 붙일 수 있는 것만 이름을 가진다. */
export type AgentKind = "claude" | "codex" | "kimi" | "other";

/**
 * `provider_id`에서 에이전트 종류를 읽는다.
 *
 * 부분 문자열 매칭인 이유: 제공자 id는 `claude-code`, `local-shell`처럼 접미사를
 * 갖고 오며 그 접미사는 우리 것이 아니다. 정확히 일치를 요구하면 제공자가
 * 이름을 조금 바꾼 날 색이 조용히 사라진다.
 *
 * 다만 `other`가 기본값이고 색은 회색이다 — 모르는 제공자를 claude 색으로
 * 그리면 화면이 틀린 사실을 주장한다.
 */
export function agentKind(providerId: string): AgentKind {
  const id = providerId.trim().toLowerCase();
  if (id.includes("claude")) return "claude";
  if (id.includes("codex") || id.includes("openai")) return "codex";
  if (id.includes("kimi")) return "kimi";
  return "other";
}

/** 한 줄로 보여줄 행. 화면은 이걸 그리기만 한다. */
export interface SessionRow {
  session: RemoteSession;
  /** 굵은 제목 — 세션 이름, 없으면 세션 id. */
  title: string;
  /** 점 색을 고르는 축. */
  state: RunState;
  /** 제공자 뱃지 색을 고르는 축. */
  agent: AgentKind;
  /** 제목 아래 회색 줄: 워크스페이스. */
  workspace: string;
  /** 제공자 이름 그대로. 모르는 것도 적는다 — 색만 회색이 된다. */
  provider: string;
  /**
   * 무엇을 실행 중인지 한 단어로, 알 때만.
   *
   * 제공자와 따로 두는 이유: `ssh gate1@…`로 띄운 세션은 제공자가 여전히
   * 로컬 셸이다. 목록에서 그 둘을 가르는 것이 이 줄의 전부다.
   */
  launchProgram?: string;
}

export function toRow(session: RemoteSession): SessionRow {
  return {
    session,
    title: sessionTitle(session),
    state: runState(session),
    agent: agentKind(session.provider_id),
    workspace: session.workspace_id,
    provider: session.provider_id,
    launchProgram: session.launch_program ?? undefined,
  };
}

/**
 * 목록 위 칩이 고를 수 있는 것.
 *
 * `all`이 기본이고 나머지는 좁히기만 한다. 화면이 기본으로 무언가를 숨기면
 * 사용자는 없는 세션을 찾아 헤매게 되고, 그건 목록이 아니라 함정이다.
 */
export type RowFilter = "all" | "live" | "ended";

/**
 * 필터·묶음·요약이 실제로 읽는 것의 전부.
 *
 * `SessionRow`를 통째로 요구하지 않는 이유는 [`lifecycleState`]와 같다 — 허브
 * 경로의 행도 같은 칩과 같은 묶음을 써야 하고, 그러려면 이 세 함수가 두 행
 * 타입의 공통분모만 알면 된다. 복제하면 "활성"의 뜻이 화면마다 갈린다.
 */
export interface GroupableRow {
  state: RunState;
  /** 묶음 키이자 제목. `SessionRow.workspace`와 같은 값이다. */
  workspace: string;
}

export function matchesFilter(row: Pick<GroupableRow, "state">, filter: RowFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "live":
      // `ready`가 아니라 `state`로 판단한다: 시작 중인 세션도 살아 있는 쪽에
      // 두는 게 맞고, `ready`만 보면 그게 빠진다.
      return row.state === "run" || row.state === "warn";
    case "ended":
      return row.state === "done";
  }
}

/** 화면의 한 묶음. 접히는 단위이자, 제목에 개수를 다는 단위. */
export interface RowGroup<Row = SessionRow> {
  /** 안정적인 키 — 화면 상태(접힘 등)를 여기에 매단다. */
  key: string;
  label: string;
  rows: Row[];
}

/**
 * 세션을 데스크탑(워크스페이스)으로 묶는다.
 *
 * 클래스(managed/standalone)로 묶던 것을 바꿨다. 그 축은 세션이 *무엇인지*를
 * 말하지 사용자가 어디서 일하고 있었는지를 말하지 않는다 — 한 데스크탑의
 * 에이전트와 셸이 두 그룹으로 갈라지고, 서로 다른 데스크탑의 셸들이 한
 * 그룹으로 뭉친다. 폰에서 세션을 찾는 사람은 "어느 데스크탑이었지"로 찾는다.
 *
 * 라벨은 워크스페이스 id 그대로다. 이 앱은 데스크탑 이름을 모른다 — 카탈로그가
 * 나르지 않는다 — 그리고 id를 잘라 쓰면 두 데스크탑이 같은 라벨을 갖게 된다.
 */
export function groupRows<Row extends GroupableRow>(rows: readonly Row[]): RowGroup<Row>[] {
  const groups = new Map<string, RowGroup<Row>>();
  for (const row of rows) {
    const key = row.workspace.trim() || "unknown";
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(key, { key, label: key, rows: [row] });
    }
  }
  const isLive = (group: RowGroup<Row>): boolean =>
    group.rows.some((row) => row.state === "run" || row.state === "warn");
  return [...groups.values()].sort((left, right) => {
    if (isLive(left) !== isLive(right)) return isLive(left) ? -1 : 1;
    return left.label.localeCompare(right.label, "ko");
  });
}

/**
 * 서버 줄의 두 번째 줄에 쓸 요약.
 *
 * 개수를 세어 말하는 것까지만 한다. 스크린샷에 있던 "워크트리 40개"는 이 앱이
 * 워크트리를 모르기 때문에 여기서 만들 수 없다 — 세션 수를 워크트리 수라고
 * 부르면 숫자는 그럴듯하고 뜻은 틀리다.
 */
export function summarize(rows: readonly Pick<GroupableRow, "state">[]): string {
  if (rows.length === 0) return t("세션 없음");
  const live = rows.filter((row) => row.state === "run" || row.state === "warn").length;
  return live > 0
    ? t("세션 {total}개 · 활성 {live}개", { total: rows.length, live })
    : t("세션 {total}개", { total: rows.length });
}
