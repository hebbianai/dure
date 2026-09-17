// pane 분할 대상 해석 — 탭 헤더의 분할 버튼/메뉴와 터미널 우클릭 분할이 같은
// 답을 내도록 한 곳에서 결정한다.
//
// 분할은 "이 pane이 지금 실행 중인 곳"을 이어받는 동작이다(tmux와 같은 기대):
// 원격 pane은 같은 SSH 호스트로, 로컬 pane은 로컬로 열고, 두 경우 모두 런타임이
// 추적한 실제 작업 폴더를 물려받는다 — 홈으로 접속해 `cd folder`를 했으면 새
// pane도 folder에서 시작한다. 예전에는 탭 헤더 분할이 binding을 보지 않아
// 원격 pane도 로컬 셸을 열었고, live cwd 대신 pane의 최초 params.cwd를 썼다.

import type { TerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import type { AgentPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";

export type PaneSplitTarget =
	| { kind: "local"; cwd?: string }
	| { kind: "ssh"; hostId: string; cwd?: string };

/** 분할 결정에 쓰는 pane params 조각 — 탭 헤더·탭 우클릭·단축키가 공유한다. */
export interface PaneSplitPaneParams extends Partial<AgentPaneParameters> {
	agentId?: string;
	sessionId?: string;
	hostId?: string;
	cwd?: string;
	binding?: TerminalPaneBindingV1;
}

export interface PaneSplitInputs {
	/** pane의 durable 런타임 신원 — 실행 위치의 1차 근거 */
	binding?: TerminalPaneBindingV1;
	/** binding이 없는 구 SSH pane 레이아웃의 params.hostId */
	paneHostId?: string;
	/** binding이 없는 SSH 에이전트 pane의 프로젝트 호스트 */
	projectSshHostId?: string;
	/** 런타임이 추적한 실제 cwd(sessionCwd) — `cd`를 따라간다 */
	liveCwd?: string;
	/** pane params의 최초 cwd */
	paneCwd?: string;
	/** 에이전트 pane의 워크트리 경로 (마지막 폴백) */
	worktreePath?: string;
}

function firstPath(
	...candidates: readonly (string | undefined)[]
): string | undefined {
	for (const candidate of candidates) {
		const trimmed = candidate?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

/** 분할 실행 위치 — binding이 있으면 그것이 진실이다. local binding에 남아 있는
 *  옛 hostId params가 pane을 엉뚱한 원격으로 끌고 가지 못하게 한다. */
function splitHostId(inputs: PaneSplitInputs): string | undefined {
	if (inputs.binding) {
		return inputs.binding.source === "ssh" ? inputs.binding.hostId : undefined;
	}
	const fallback = inputs.paneHostId ?? inputs.projectSshHostId;
	return fallback && fallback !== "local" ? fallback : undefined;
}

export function resolvePaneSplitTarget(
	inputs: PaneSplitInputs,
): PaneSplitTarget {
	const cwd = firstPath(inputs.liveCwd, inputs.paneCwd, inputs.worktreePath);
	const hostId = splitHostId(inputs);
	return hostId
		? { kind: "ssh", hostId, ...(cwd ? { cwd } : {}) }
		: { kind: "local", ...(cwd ? { cwd } : {}) };
}
