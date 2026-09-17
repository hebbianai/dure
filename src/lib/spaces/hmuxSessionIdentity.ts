/**
 * 사이드바 한 줄이 가리키는 **hmux 세션 id**.
 *
 * 폰이 세션을 알아보는 유일한 값이라 여기서 한 번만 정한다. 허브 카탈로그도 폰의
 * SSH 인구조사도 이 id 로 같은 세션을 가리키고, 이 값이 틀리면 폰의 목록은
 * "만들어지긴 하는데 아무것도 안 맞는" 상태가 된다 — 빈 화면만 남고 이유는
 * 어디에도 안 나온다.
 *
 * # 왜 pane 종류마다 다른 곳에서 오나
 *
 * 두 종류의 pane 이 hmux 세션에 붙어 있고, 그 신원을 다른 자리에 들고 있다.
 *
 * - 터미널/SSH pane 은 pane 자신의 `hmuxIdentity` 에 들고 있다.
 * - 에이전트 pane 은 들고 있지 않다. pane 은 에이전트 id 만 알고, 세션 신원은
 *   **에이전트 레코드**의 `runtimeBinding` 에 있다.
 *
 * 그래서 에이전트 쪽을 빼먹으면 사이드바에서 제일 많은 줄이 통째로 빠진다.
 * 실제로 그렇게 한 세대를 보냈다(2026-08-12): 표는 멀쩡히 만들어졌고, 타입도
 * 통과했고, 폰에는 아무것도 안 떴다.
 *
 * # 왜 `agent.sessionId` 가 아닌가
 *
 * 그 값은 이 앱이 pane 에 붙인 자기 id 다. hmux 가 아는 세션의 이름이 아니라,
 * 어느 쪽에서도 같은 세션을 가리키지 않는다.
 */

/** 이 함수가 읽는 만큼의 pane. */
export interface HmuxIdentityPane {
	readonly kind: "agent" | "term" | "ssh";
	/** 터미널/SSH pane 이 들고 있는 세션 신원. 없으면 hmux 세션이 아니다. */
	readonly hmuxIdentity?: { readonly sessionId: string };
}

/** 이 함수가 읽는 만큼의 에이전트 레코드. */
export interface HmuxIdentityAgent {
	readonly runtimeBinding?: { readonly runtime: string; readonly sessionId: string };
}

/**
 * 이 pane 이 가리키는 hmux 세션 id. hmux 세션이 아니면 `undefined`.
 *
 * `agent` 는 이 pane 이 에이전트 pane 일 때의 그 에이전트 레코드다. 다른 종류의
 * pane 에는 없어도 된다.
 */
export function paneHmuxSessionId(
	pane: HmuxIdentityPane,
	agent?: HmuxIdentityAgent,
): string | undefined {
	if (pane.kind === "agent") {
		// 에이전트의 hmux 판은 `hmux_managed_v1` 하나뿐이다. 나머지
		// (`legacy_session_v1`, `legacy_ssh_session_v1`)는 hmux 이전의 pty/ssh
		// 레코드라, 그 `sessionId` 는 hmux 가 모르는 값이다 — 그것을 실어 보내면
		// 폰은 있지도 않은 세션의 자리를 들고 있게 된다.
		const binding = agent?.runtimeBinding;
		return binding?.runtime === "hmux_managed_v1" ? binding.sessionId : undefined;
	}
	return pane.hmuxIdentity?.sessionId;
}
