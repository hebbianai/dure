/**
 * 사이드바가 만든 묶음을, 폰이 같은 모양으로 그릴 수 있는 표로.
 *
 * 데스크탑("Workspace", "Onchain", "Artrooms")은 사용자가 이 앱에서 만든 것이고
 * hmux 는 그것을 모른다. 그래서 폰이 알려면 이 앱이 말해 줘야 하고, 이 파일이 그
 * 말의 내용을 만든다. 받는 쪽은 `src-tauri/src/hub/layout.rs`.
 *
 * # 키는 hmux 세션 id 다
 *
 * 어느 값이 그것인지는 [`paneHmuxSessionId`] 한 군데가 정한다. 이 앱이 pane 에
 * 붙인 자기 id 로 키를 잡으면 표는 멀쩡히 만들어지고 폰에서는 **하나도 안 맞는다**
 * — 빈 화면만 보이고 왜 그런지는 어디에도 안 나온다.
 *
 * 그래서 hmux 세션 id 가 없는 줄은 표에 넣지 않는다. 그런 pane 은 폰이 애초에 볼
 * 수 없는 것이다.
 *
 * # 저장소 묶음은 사이드바와 같은 함수를 쓴다
 *
 * [`groupSpacesByRepository`] 를 여기서 다시 구현하지 않는다. 두 벌이 되면 폰과
 * 사이드바가 같은 세션을 다른 프로젝트 아래에 놓는 날이 오고, 그 차이는 두 화면을
 * 나란히 보는 사람에게만 보인다.
 *
 * # 분류가 없는 세션은 표에 없다
 *
 * 사이드바에 없는 세션은 여기 없고, 폰은 그런 세션을 **그리지 않는다** — 소유자
 * 결정이다(2026-08-12). 억지로 "분류 없음" 묶음을 만들면 사용자가 정리한 적 없는
 * 것들이 화면 아래에 쌓이고, 그건 사이드바를 정리한 사람이 보려던 화면이 아니다.
 *
 * 예외가 하나 있다. 사이드바 맨 아래의 **열리지 않은 에이전트**는 사용자가 보고
 * 있는 목록의 일부라서 같이 간다([`UNOPENED_DESKTOP`]).
 */

import type { SessionPresentation } from "./sessionPresentation";
import { groupSpacesByRepository } from "@/lib/spaces/spaceRepositoryGroups";
import { sshHostSecretId } from "@/lib/ssh/sshCredentialClaim";
import type { SshHostConfig } from "@/types";

/**
 * 열리지 않은 에이전트가 폰에서 서는 묶음의 이름.
 *
 * 사이드바 머리글의 한국어 원문(=번역 키)을 그대로 쓴다. 폰이 자기 로케일로
 * 번역하게 하려는 것이다 — 여기서 `t()` 를 부르면 폰은 **노트북의 언어**로 된
 * 머리글을 보게 된다.
 *
 * 사용자가 데스크탑을 정확히 이 이름으로 만들면 두 묶음이 한 묶음이 된다. 이름이
 * 겹치는 것 이상의 일은 일어나지 않아서 그대로 둔다 — 구별하려면 전선에 표시가
 * 하나 더 필요하고, 그 표시는 이 한 가지 경우 말고는 쓸 데가 없다.
 */
export const UNOPENED_DESKTOP = "열리지 않은 에이전트";

/** 이 앱이 폰에게 말해 주는, 세션 하나의 자리. */
interface SessionPlacement {
	readonly desktop: string;
	readonly project: string;
	readonly title: string;
	readonly order: number;
	/**
	 * 이 세션이 올라앉은 git 브랜치.
	 *
	 * 선택인 것이 의도다 — git 저장소가 아닌 세션도 있고, 아직 상태를 못 읽은
	 * 세션도 있다. 모르면 싣지 않고, 폰은 그때 아무것도 그리지 않는다.
	 *
	 * Live row metadata travels in `presentation`; only placement fields are
	 * projected into the phone's durable layout cache.
	 */
	readonly branch?: string;
	readonly presentation?: SessionPresentation;
}

interface HubRemoteHost {
	readonly id: string;
	readonly name: string;
	readonly host: string;
	readonly port: number;
	readonly user: string;
	readonly auth: SshHostConfig["auth"];
	readonly secret_id?: string;
	readonly key_path?: string;
}

export interface SidebarLayout {
	/** hmux 세션 id → 그 세션이 사이드바에서 앉아 있는 자리. */
	readonly placements: Record<string, SessionPlacement>;
	/**
	 * 데스크탑이 사이드바에 선 순서. 이름만으로는 순서를 알 수 없다.
	 *
	 * snake_case 인 이유: 이 값은 Tauri IPC 로 그대로 건너가고 받는 쪽 serde 가
	 * 이 이름으로 읽는다. 바로 위의 `PairingOffer.device_id` 가 같은 이유로 같은
	 * 모양이다.
	 */
	readonly desktop_order: string[];
	readonly remote_hosts: HubRemoteHost[];
}

/** 이 함수가 읽는 만큼의 데스크탑. */
export interface LayoutDesktop {
	readonly id: string;
	readonly name: string;
}

/** 이 함수가 읽는 만큼의 space. */
export interface LayoutSpace {
	readonly desktopId: string;
	readonly projectName: string;
	readonly title: string;
	readonly projectId?: string;
	readonly hostId?: string;
	/**
	 * 없으면 hmux 세션이 아니다 — 폰이 볼 수 없으므로 표에 넣지 않는다.
	 *
	 * `?:` 가 아니라 `| undefined` 인 것이 의도다. 선택 속성으로 두면 값을 아예
	 * 안 실어 보내는 호출자도 타입이 통과하고, 표는 멀쩡히 만들어지고, 폰에는
	 * 하나도 안 뜬다 — 2026-08-12 에 실제로 그렇게 한 세대를 보냈다. 이렇게
	 * 두면 그 호출자는 컴파일되지 않는다.
	 */
	readonly hmuxSessionId: string | undefined;
	/**
	 * 이 세션이 올라앉은 git 브랜치. 저장소가 아니거나 아직 상태를 못 읽었으면
	 * 없다 — 그때는 표에 싣지 않고, 폰은 아무것도 그리지 않는다.
	 */
	readonly branch?: string;
	readonly presentation?: SessionPresentation;
}

/**
 * 이 함수가 읽는 만큼의, 열리지 않은 에이전트.
 *
 * 순서는 **호출자가 준 순서 그대로** 쓴다. 사이드바 화면은 이 목록을 안 읽음·상태·
 * 체크포인트 시각으로 정렬하는데, 그 값들은 몇 초마다 바뀐다. 그 순서를 여기에
 * 들이면 표가 계속 달라지고, 표가 달라질 때마다 IPC 한 번과 폰의 파일 쓰기 한
 * 번이 따라온다 — 아무도 아무것도 안 옮겼는데.
 */
export interface LayoutUnopenedAgent {
	/** 위 [`LayoutSpace.hmuxSessionId`] 와 같은 이유로 선택 속성이 아니다. */
	readonly hmuxSessionId: string | undefined;
	readonly projectName: string;
	readonly title: string;
	readonly hostId?: string;
	/** 위 [`LayoutSpace.branch`] 와 같은 값. 모르면 없다. */
	readonly branch?: string;
	readonly presentation?: SessionPresentation;
}

export function buildSidebarLayout(
	desktops: readonly LayoutDesktop[],
	spaces: readonly LayoutSpace[],
	unopened: readonly LayoutUnopenedAgent[] = [],
	sshHosts: readonly SshHostConfig[] = [],
): SidebarLayout {
	const placements: Record<string, SessionPlacement> = {};
	const desktopOrder: string[] = [];

	for (const desktop of desktops) {
		// 이름이 없는 데스크탑은 이름이 없는 채로 나간다. 여기서 지어내면 폰과
		// 사이드바가 다른 이름을 부르게 되고, 그게 이 표가 존재하는 이유와 정반대다.
		desktopOrder.push(desktop.name);

		const mine = spaces.filter((space) => space.desktopId === desktop.id);
		let order = 0;
		for (const group of groupSpacesByRepository(mine)) {
			for (const space of group.spaces) {
				const sessionId = space.hmuxSessionId;
				if (!sessionId) continue;
				// 같은 세션이 두 자리에 보이면(숨긴 pane 의 원래 자리 등) 먼저 나온
				// 것이 이긴다. 사이드바가 위에서부터 그리므로 그 자리가 사용자가
				// 보고 있는 자리다.
				if (placements[sessionId]) continue;
				placements[sessionId] = {
					desktop: desktop.name,
					project: group.label,
					title: space.title,
					order,
					// 모르면 키 자체를 넣지 않는다. `branch: undefined` 는 JSON 에서
					// 사라지지만, 이 표는 직전 것과 문자열로 비교되므로 키를 조건부로
					// 두는 편이 그 비교를 흔들지 않는다.
					...(space.branch === undefined ? {} : { branch: space.branch }),
					...(space.presentation ? { presentation: space.presentation } : {}),
				};
				order += 1;
			}
		}
	}

	// 열리지 않은 에이전트는 사이드바에서도 맨 아래다. 폰에서 순서가 뒤집히면 두
	// 화면을 나란히 보는 사람에게만 보이는 차이가 된다.
	let unopenedOrder = 0;
	for (const agent of unopened) {
		const sessionId = agent.hmuxSessionId;
		if (!sessionId) continue;
		// 열려 있는 자리가 이긴다. 열린 pane 과 "열리지 않은" 목록에 같은 세션이
		// 동시에 보이는 순간이 있고(닫는 중), 그때 사용자가 보고 있는 것은 열린
		// 쪽이다.
		if (placements[sessionId]) continue;
		if (!desktopOrder.includes(UNOPENED_DESKTOP)) desktopOrder.push(UNOPENED_DESKTOP);
		placements[sessionId] = {
			desktop: UNOPENED_DESKTOP,
			project: agent.projectName,
			title: agent.title,
			order: unopenedOrder,
			...(agent.branch === undefined ? {} : { branch: agent.branch }),
			...(agent.presentation ? { presentation: agent.presentation } : {}),
		};
		unopenedOrder += 1;
	}

	const remoteIds = new Set([
		...spaces.flatMap((space) =>
			space.hmuxSessionId && space.hostId ? [space.hostId] : [],
		),
		...unopened.flatMap((agent) =>
			agent.hmuxSessionId && agent.hostId ? [agent.hostId] : [],
		),
	]);
	const remote_hosts = sshHosts
		.filter((host) => remoteIds.has(host.id))
		.map((host) => {
			const secretId = sshHostSecretId(host);
			return {
				id: host.id,
				name: host.name,
				host: host.host,
				port: host.port,
				user: host.user,
				auth: host.auth,
				...(secretId ? { secret_id: secretId } : {}),
				...(host.keyPath ? { key_path: host.keyPath } : {}),
			};
		});

	return { placements, desktop_order: desktopOrder, remote_hosts };
}
