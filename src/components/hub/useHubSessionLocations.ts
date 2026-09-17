/**
 * Where every session the phone can ask about actually runs.
 *
 * One table, read by every hub round trip that has to turn an hmux session id
 * into a repository — the changed-file list and one file's patch today. A
 * second copy would be a second authority for the same question, and the day
 * the two drift the phone is shown another repository's contents on a screen
 * that looks entirely correct.
 *
 * # Every session the phone can ask about
 *
 * The git button sits on every session header, and the hub catalog lists every
 * session class, so the table has to cover all of them. An agent's worktree
 * lives on its record; a terminal or SSH pane carries its own cwd. Covering
 * only agents would tell somebody that a terminal standing in their own sidebar
 * is unknown to the computer running it.
 *
 * # Why a ref, not a dependency
 *
 * Agents and spaces change constantly (a name, a status dot). Listing them as
 * effect dependencies would tear down and re-register a listener on every one
 * of those changes, and a request that arrived in the gap would go unanswered.
 * So this hook hands back a ref whose `current` is always the newest table, and
 * the listeners read through it.
 */

import { useMemo, useRef } from "react";
import type { RefObject } from "react";
import { useSpaces } from "@/components/spaces/useSpaces";
import type { SessionLocation } from "@/lib/hub/gitStatusBridge";
import { paneHmuxSessionId } from "@/lib/spaces/hmuxSessionIdentity";
import { useStore } from "@/store";

export function useHubSessionLocations(): RefObject<Map<string, SessionLocation>> {
	const agents = useStore((state) => state.agents);
	const spaces = useSpaces();

	const locations = useMemo(() => {
		const table = new Map<string, SessionLocation>();
		for (const space of spaces) {
			// 줄이 이미 들고 있는 값을 쓴다. 여기서 다시 만들면 안 된다 —
			// `SpaceRow` 에는 `hmuxIdentity` 가 없어서(`useSpaces` 가 내부
			// `Space` 에서만 읽는다) 터미널/SSH pane 은 조용히 `undefined` 가
			// 되고, 폰은 자기 사이드바에 서 있는 세션을 "이 컴퓨터에서 찾지
			// 못했습니다" 로 듣는다. `hmuxSessionIdentity` 의 머리말이 경고하는
			// 실수의 반대쪽 절반이다.
			const sessionId = space.hmuxSessionId;
			if (sessionId === undefined) continue;
			// An SSH pane's repository is on the other box; the local readers run
			// git here. But this window is paired with that box — it is how the
			// session got there — so it can ask that box instead of refusing.
			//
			// The workspace id comes from the agent's runtime binding, not from
			// the row: `SpaceRow` carries `hmuxWorkspaceId` only for terminal and
			// SSH panes, and an agent pane — the case this exists for — leaves it
			// undefined. The box id is `space.hostId` because that is the id this
			// window publishes in its own sidebar layout, and the backend resolves
			// the host from exactly that list.
			if (space.hostId !== undefined) {
				const binding =
					space.kind === "agent"
						? agents.find((agent) => agent.id === space.agentId)?.runtimeBinding
						: undefined;
				const workspaceId =
					binding?.runtime === "hmux_managed_v1" && binding.source === "ssh"
						? binding.workspaceId
						: space.hmuxWorkspaceId;
				table.set(sessionId, {
					kind: "remote",
					boxId: space.hostId,
					...(workspaceId === undefined ? {} : { workspaceId }),
				});
				continue;
			}
			const worktreePath =
				space.kind === "agent"
					? agents.find((agent) => agent.id === space.agentId)?.worktreePath
					: space.cwd;
			if (worktreePath) table.set(sessionId, { kind: "local", worktreePath });
		}
		// Agents with no pane open are in the phone's list too — the sidebar shows
		// them under 열지 않은, and tapping one opens this screen.
		for (const agent of agents) {
			const sessionId = paneHmuxSessionId({ kind: "agent" }, agent);
			if (sessionId === undefined || table.has(sessionId)) continue;
			const binding = agent.runtimeBinding;
			if (binding?.runtime === "hmux_managed_v1" && binding.source === "ssh") {
				// Same rule as an open row: the id the layout published, and the
				// workspace the binding recorded.
				table.set(sessionId, {
					kind: "remote",
					// `Agent` 에는 `hostId` 가 없다 — 배치표는 이 자리에서
					// `agent.hostId` 를 쓰지만 그것은 `sidebarLayout` 이 만든
					// 파생 행의 값이고, 원본은 이 바인딩이다. 같은 값이다.
					boxId: binding.hostId,
					workspaceId: binding.workspaceId,
				});
				continue;
			}
			if (agent.worktreePath) {
				table.set(sessionId, { kind: "local", worktreePath: agent.worktreePath });
			}
		}
		return table;
	}, [agents, spaces]);

	const current = useRef(locations);
	current.current = locations;
	return current;
}
