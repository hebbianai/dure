/** Plan native SSH session creation without deciding presentation identity.
 * The opener reserves its pane ID separately before publishing pending ownership;
 * the pane can later change content without renaming the runtime session. */

import type {
	RemoteHmuxCatalogTargetV1,
	RemoteHmuxStandaloneCreateRequestV1,
} from "@/lib/hmux/remote/remoteHmuxBroker";

/** 이 계획이 쓰는 만큼의 난수. 시험이 결과를 고정할 수 있게 주입한다. */
export interface RemoteHmuxOpenIds {
	/** Native session identity, independent of the view that presents it. */
	readonly sessionSuffix: string;
	readonly requestSuffix: string;
	readonly launchProofSuffix: string;
	readonly bridgeSuffix: string;
}

export interface RemoteHmuxTerminalOpenPlan {
	/** 이 pane 이 만든 원격 세션이라는 증명에 쓸 id. */
	readonly targetSessionId: string;
	readonly create: RemoteHmuxStandaloneCreateRequestV1;
}

/**
 * 터미널의 처음 크기.
 *
 * 실제 크기는 pane 이 붙은 뒤 첫 resize 가 정한다. 여기 값은 그 전까지 원격 셸이
 * 쓰는 것이라, 0 이나 1 같은 값을 주면 프롬프트가 접힌 채로 첫 화면이 그려진다.
 * 로컬 standalone 생성이 쓰는 값과 같게 둔다.
 */
export const REMOTE_HMUX_INITIAL_COLUMNS = 120;
export const REMOTE_HMUX_INITIAL_ROWS = 30;

/**
 * 원격 hmux 세션 하나를 만들 계획. 부수효과 없음.
 *
 * `commandIntercepts` 는 핸드오프 쪽과 같은 목록이다. 원격 셸에서 `claude` 나
 * `codex` 를 치면 그것이 관리형 세션으로 승격될 수 있어야 하고, 두 입구가 다른
 * 목록을 들고 있으면 같은 서버에서 같은 명령이 어떤 날은 승격되고 어떤 날은 안
 * 된다.
 */
export function planRemoteHmuxTerminalOpen(input: {
	readonly target: RemoteHmuxCatalogTargetV1;
	readonly ids: RemoteHmuxOpenIds;
	readonly cwd?: string;
	readonly columns?: number;
	readonly rows?: number;
}): RemoteHmuxTerminalOpenPlan {
	const targetSessionId = `standalone_${input.ids.sessionSuffix}`;
	return {
		targetSessionId,
		create: {
			target: input.target,
			requestId: `remote_open_${input.ids.requestSuffix}`,
			targetSessionId,
			launchOwnerProof: `remote_launch_${input.ids.launchProofSuffix}`,
			// 호스트 이름은 사용자가 지은 것이라 공백도 한글도 들어올 수 있다.
			// 원격 프로토콜은 제한된 식별자만 받으므로 우리가 만든 id 에 묶는다.
			sessionName: `remote-${targetSessionId}`,
			bridgeNonce: `bridge_${input.ids.bridgeSuffix}`,
			...(input.cwd ? { cwd: input.cwd } : {}),
			initialColumns: input.columns ?? REMOTE_HMUX_INITIAL_COLUMNS,
			initialRows: input.rows ?? REMOTE_HMUX_INITIAL_ROWS,
			commandIntercepts: [
				{ command: "claude", providerId: "claude" },
				{ command: "codex", providerId: "codex" },
			],
		},
	};
}
