/**
 * 여러 서버의 응답을 한 화면으로 합치는 순수 로직. Tauri/DOM 없이 테스트된다.
 *
 * 여기서 지키는 규칙 하나: **대답하지 않은 서버는 조용히 사라지지 않는다.**
 * 세션이 목록에 없으면 사용자는 그 세션이 죽었다고 읽는다. 그래서 합친 목록과
 * 나란히, 대답하지 못한 서버가 각각 무엇 때문이었는지 항상 함께 내놓는다.
 */

import type { RemoteSession } from "./sessions";
import { sessionTitle } from "./sessions";

/** Rust `census::ProbeOutcome`와 같은 모양. */
export type ProbeOutcome =
  | { state: "listed"; sessions: RemoteSession[] }
  | { state: "not_provisioned"; detail: string }
  | { state: "not_configured"; code: string; detail: string }
  | { state: "unreachable"; code: string; detail: string }
  | { state: "timed_out"; seconds: number }
  | { state: "not_attempted" };

/** Rust `census::ServerReport`. 서버 하나당 정확히 하나. */
export interface ServerReport {
  server_id: string;
  server_label: string;
  outcome: ProbeOutcome;
}

/** 합친 목록의 한 줄. 어느 서버의 세션인지 항상 달고 다닌다. */
export interface CensusRow {
  serverId: string;
  serverLabel: string;
  /**
   * Whether the server answered *this* census.
   *
   * False rows come from [`rememberListings`]: the server listed them once and
   * did not answer now. They are drawn, dimmed and unopenable, rather than
   * dropped — for the reason at the top of this file.
   */
  reachable: boolean;
  session: RemoteSession;
}

/** What one server last said, kept for the census in which it stays silent. */
export interface RememberedListing {
  serverLabel: string;
  sessions: RemoteSession[];
}

/**
 * Carry each server's last good listing across a census it failed.
 *
 * The paired-computer path already does exactly this (`app.ts` keeps the
 * sessions and flips `reachable`), and the two transports have to agree: a
 * project is unreachable, not gone, whichever way the phone reaches it.
 * Without this the SSH half of a desktop empties the moment a server times
 * out, and the screen is left with no rows to dim and only a count to
 * apologise with.
 *
 * A server that has never answered contributes nothing: there is no listing to
 * remember, and inventing rows for it would be worse than saying nothing.
 */
export function rememberListings(
  previous: Readonly<Record<string, RememberedListing>>,
  reports: readonly ServerReport[],
): Record<string, RememberedListing> {
  const next = { ...previous };
  for (const report of reports) {
    if (report.outcome.state !== "listed") continue;
    next[report.server_id] = {
      serverLabel: report.server_label,
      sessions: report.outcome.sessions,
    };
  }
  return next;
}

/** 대답하지 못한 서버 한 대와, 사용자가 무엇을 고쳐야 하는지. */
export interface CensusFailure {
  serverId: string;
  serverLabel: string;
  /** 화면에 그대로 쓰는 한국어 문장. */
  message: string;
  /** 세부. 서버가 준 말이라 번역하지 않는다. */
  detail?: string;
}

/**
 * 서버가 대답하지 못한 이유를 사용자가 할 일로 바꾼다.
 *
 * hmux가 없는 서버는 SSH가 완전히 정상인 채로 셸 오류를 돌려준다. 그것을
 * 프로토콜 실패라고 부르면 사용자는 네트워크를 들여다보게 된다 — 고칠 곳은
 * 서버의 PATH다.
 */
export function describeFailure(report: ServerReport): CensusFailure | undefined {
  const base = { serverId: report.server_id, serverLabel: report.server_label };
  switch (report.outcome.state) {
    case "listed":
      return undefined;
    case "not_provisioned":
      return { ...base, message: "hmux가 설치되어 있지 않습니다", detail: report.outcome.detail };
    case "not_configured":
      return {
        ...base,
        message: "이 기기에 연결 정보가 없습니다",
        detail: report.outcome.detail,
      };
    case "unreachable":
      return { ...base, message: "연결하지 못했습니다", detail: report.outcome.detail };
    case "timed_out":
      return {
        ...base,
        message: `${report.outcome.seconds}초 안에 응답을 마치지 못했습니다`,
      };
    case "not_attempted":
      return { ...base, message: "시간이 모자라 물어보지 못했습니다" };
  }
}

/**
 * 모든 서버의 세션을 한 목록으로.
 *
 * 정렬은 붙을 수 있는 세션 먼저, 그다음 서버 이름, 그다음 세션 이름. 서버별로
 * 묶지 않는 이유: 사용자가 찾는 것은 "어느 서버"가 아니라 "어제 남겨둔 그
 * 에이전트"이고, 서버는 그것을 찾은 다음에 필요한 정보다.
 */
export function mergeSessions(
  reports: readonly ServerReport[],
  /**
   * Last good listings, from [`rememberListings`]. Omitted by callers that
   * report on one server at a time: the servers screen writes the failure
   * beside the row, and remembered sessions there would contradict it.
   */
  remembered: Readonly<Record<string, RememberedListing>> = {},
): CensusRow[] {
  const rows: CensusRow[] = [];
  for (const report of reports) {
    const outcome = report.outcome;
    const sessions =
      outcome.state === "listed"
        ? outcome.sessions
        : (remembered[report.server_id]?.sessions ?? []);
    for (const session of sessions) {
      rows.push({
        serverId: report.server_id,
        serverLabel: report.server_label,
        reachable: outcome.state === "listed",
        session,
      });
    }
  }
  // Unreachable rows sort with the ones nobody can attach to. They stay in the
  // list, so the eye still finds them inside their own project.
  const openable = (row: CensusRow): boolean => row.reachable && row.session.ready;
  return rows.sort((left, right) => {
    if (openable(left) !== openable(right)) return openable(left) ? -1 : 1;
    const byServer = left.serverLabel.localeCompare(right.serverLabel, "ko");
    if (byServer !== 0) return byServer;
    const byTitle = sessionTitle(left.session).localeCompare(sessionTitle(right.session), "ko");
    if (byTitle !== 0) return byTitle;
    return left.session.session_id.localeCompare(right.session.session_id, "ko");
  });
}

/** 대답하지 못한 서버들. 순서는 요청한 순서 그대로 — 새로고침마다 뒤섞이지 않게. */
export function failures(reports: readonly ServerReport[]): CensusFailure[] {
  return reports
    .map(describeFailure)
    .filter((failure): failure is CensusFailure => failure !== undefined);
}

/** 실제로 대답한 서버 수. */
export function answeredCount(reports: readonly ServerReport[]): number {
  return reports.filter((report) => report.outcome.state === "listed").length;
}

/**
 * 목록이 비었을 때 화면에 쓸 문장.
 *
 * "세션이 없습니다"와 "아무 서버도 대답하지 않았습니다"는 정반대의 뜻이고,
 * 전자를 후자의 상황에서 보여주면 사용자는 에이전트가 전부 죽었다고 읽는다.
 * 그래서 빈 화면 문구는 계산해서 고른다.
 */
export function emptyMessage(reports: readonly ServerReport[]): string {
  if (reports.length === 0) return "등록된 서버가 없습니다";
  if (answeredCount(reports) === 0) return "대답한 서버가 없습니다 — 아래 이유를 확인하세요";
  return "실행 중인 세션이 없습니다";
}
