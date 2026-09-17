/**
 * SSH 호스트 버튼이 여는 것: **그 서버의 hmux 세션**.
 *
 * 계획은 [`planRemoteHmuxTerminalOpen`] 이 세우고, 여기는 그 계획을 실제 원격
 * 생성과 pane 열기로 옮긴다. 왜 legacy PTY 가 아니라 원격 hmux 여야 하는지는
 * 계획 쪽 머리말에 있다 — 짧게는, legacy pane 은 세션 id 가 없어서 폰이 볼 수도
 * 붙을 수도 없다.
 *
 * # 실패하면 만든 것을 두고 나오지 않는다
 *
 * 원격 세션은 pane 보다 **먼저** 만들어진다(주인을 증명한 채로 시작해야 해서).
 * 그 뒤 어디서 실패하든 그 세션은 이미 저쪽 기계에 있고, 여기서 손을 놓으면
 * 아무도 그것을 청소하지 않는다. 그래서 생성 이후의 모든 실패는
 * `departGracefully` 를 지나서 나간다.
 *
 * 떠나기가 또 실패해도 **죽이러 가지 않는다.** 전송이 불확실한 것과 저쪽이 이미
 * 다른 클라이언트를 받은 것이 여기서 구별되지 않고, 그 상태에서의 강제 종료는
 * 남의 화면을 끄는 일이 된다. 핸드오프 경로가 같은 이유로 같은 규칙을 지킨다.
 */

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { DockviewApi } from "dockview-react";
import { nanoid } from "nanoid";
import { hmuxPaneOwnerId } from "@/lib/hmux/hmuxPaneRetirement";
import {
	planRemoteHmuxCatalogTarget,
	type RemoteHmuxCatalogSessionV1,
	type RemoteHmuxCatalogTargetV1,
} from "@/lib/hmux/remote/remoteHmuxBroker";
import {
	hasDurableRemoteHmuxPaneReference,
	type RemoteHmuxPaneRegistration,
	registerRemoteHmuxPaneDurably,
	remoteHmuxMountedPaneApplies,
	remoteHmuxPaneRegistrationApplies,
} from "@/lib/hmux/remote/remoteHmuxPaneRegistration";
import { planRemoteHmuxTerminalOpen } from "@/lib/hmux/remote/remoteHmuxTerminalOpen";
import { t } from "@/lib/i18n";
import {
	remoteHmuxCommandInput,
	remoteHmuxDepartGracefully,
	remoteHmuxKnownHostTrust,
	remoteHmuxStandaloneCreate,
} from "@/lib/ipc";
import { recoverCurrentDurableStoreProjection } from "@/lib/persistence/currentDurableProjectionRecovery";
import { noteSshHostUsed } from "@/lib/ssh/recentSshHost";
import {
	type RemoteHmuxStandalonePaneBindingV1,
	remoteHmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import { showErrorToast } from "@/lib/toast";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import {
	getDockview,
	waitForDesktopDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { autoSplitPosition } from "@/lib/workspace/dock/gridPanePlacement";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";
import { useStore } from "@/store";

export class RemoteHmuxOpenError extends Error {
	readonly code: string;
	readonly nextAction?: string;
	constructor(code: string, message: string, nextAction?: string) {
		super(message);
		this.name = "RemoteHmuxOpenError";
		this.code = code;
		this.nextAction = nextAction;
	}
}

/**
 * 등록된 SSH 호스트 하나에 원격 hmux 세션을 만들고, 그 세션으로 pane 을 연다.
 *
 * 입구는 둘뿐이고 각자 실패를 말하는 자리를 소유한다: UI 는
 * [`openRemoteHmuxTerminalDetached`](토스트), CLI 영수증 경로는 이 함수를
 * 직접 await 하고 오류를 CLI 응답으로 되돌린다. 실패를 삼키는 세 번째 입구를
 * 만들지 말 것.
 *
 * `desktopId` 는 소유자 증명에 들어간다 — 어느 데스크탑의 어느 pane 이 이 원격
 * 세션을 만들었는지가 그 증명의 내용이다.
 */
export interface RemoteHmuxTerminalOpenReceipt {
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly panelId: string;
	readonly binding: RemoteHmuxStandalonePaneBindingV1;
	readonly cwd: string | null;
	readonly readiness: {
		readonly pane: "mounted";
		readonly session: RemoteHmuxCatalogSessionV1["lifecycle"];
	};
}

export interface RemoteHmuxTerminalOpenInput {
	readonly api: DockviewApi;
	readonly desktopId: string;
	readonly hostId: string;
	readonly hostName?: string;
	readonly cwd?: string;
	readonly position?: PanelPosition;
	/** One-shot command typed into the remote shell (with submit) before the
	 * pane is exposed — command panes (remote login, ssh setup). Delivery
	 * failure departs the created session and never shows the pane. */
	readonly commandLine?: string;
	/** Tab title override; defaults to the host name. */
	readonly title?: string;
}

export async function openRemoteHmuxTerminal(
	input: RemoteHmuxTerminalOpenInput,
): Promise<RemoteHmuxTerminalOpenReceipt> {
	const hosts = useStore.getState().sshHosts;
	const host = hosts.find((candidate) => candidate.id === input.hostId);
	if (!host) {
		throw new RemoteHmuxOpenError(
			"remote_hmux_host_not_registered",
			`SSH host ${input.hostId} is not registered`,
			"Register the SSH host in Dure, then use its ID with --host.",
		);
	}

	const expected = input.position?.replacement;
	let replacement: RemoteHmuxPaneRegistration["replacement"];
	if (expected) {
		const pane = input.api.getPanel(expected.id);
		if (!pane || pane.api !== expected) {
			throw new RemoteHmuxOpenError(
				"remote_hmux_pane_changed",
				"the selected pane content changed before remote creation",
			);
		}
		replacement = {
			pane: dockPanelReference(pane),
			isCurrent: () =>
				getDockview(input.desktopId)?.getPanel(expected.id)?.api === expected,
		};
	}
	const trust = await remoteHmuxKnownHostTrust(host.id, host.host, host.port);
	const target: RemoteHmuxCatalogTargetV1 = planRemoteHmuxCatalogTarget(
		hosts,
		host.id,
		trust,
	);
	const plan = planRemoteHmuxTerminalOpen({
		target,
		cwd: input.cwd,
		ids: {
			sessionSuffix: nanoid(24),
			requestSuffix: nanoid(24),
			launchProofSuffix: nanoid(32),
			bridgeSuffix: nanoid(32),
		},
	});
	const panelId = replacement?.pane.id ?? createPaneId();
	const paneOwnerId = hmuxPaneOwnerId(
		getCurrentWebviewWindow().label,
		input.desktopId,
		panelId,
	);

	// 이 호출은 저쪽이 **이 pane 의 것으로** 실행 증명을 붙들기 전에는 돌아오지
	// 않는다. 그래서 여기서부터는 만든 것이 저쪽에 있다.
	const receipt = await remoteHmuxStandaloneCreate(plan.create, paneOwnerId);
	const session: RemoteHmuxCatalogSessionV1 = receipt.session;
	let binding: RemoteHmuxStandalonePaneBindingV1;
	let paneRegistered = false;
	let registration: RemoteHmuxPaneRegistration | undefined;
	const depart = async () => {
		await remoteHmuxDepartGracefully(target, session, paneOwnerId).catch(() => {
			// 전송이 불확실한 것과 저쪽이 이미 다른 클라이언트를 받은 것이
			// 여기서 구별되지 않는다. 강제 종료로 넘어가지 않는다.
		});
	};

	try {
		// 계획한 id 로 만들어지지 않았으면 우리가 확정해 둔 주인과 어긋난다. 그
		// pane 을 열면 **다른 세션의 주인 행세**를 하게 되므로, 열지 않고 되돌린다.
		if (session.sessionId !== plan.targetSessionId) {
			throw new RemoteHmuxOpenError(
				"remote_hmux_session_identity_mismatch",
				"the remote did not create the session with the requested id",
			);
		}
		binding = remoteHmuxStandaloneBinding(
			session.sessionId,
			session.workspaceId,
			host.id,
			receipt.bridgeNonce,
		);
		const title =
			input.title ?? (input.hostName || host.name || t("common.terminal"));
		const params = {
			sessionId: session.sessionId,
			...(input.cwd ? { cwd: input.cwd } : {}),
			binding,
		};
		const currentApi = await waitForDesktopDockview(input.desktopId);
		if (!currentApi) {
			throw new RemoteHmuxOpenError(
				"remote_hmux_desktop_unavailable_before_pane_commit",
				"the target desktop is no longer available",
			);
		}
		registration = {
			host,
			spaceId: input.desktopId,
			panelId,
			binding,
			definition: {
				id: panelId,
				contentComponent: "terminal",
				title,
				params,
			},
			fallbackLayout: currentApi.toJSON(),
			position: replacement
				? undefined
				: (input.position ?? autoSplitPosition(currentApi)),
			replacement,
		};
		if (input.commandLine) {
			await remoteHmuxCommandInput({
				target,
				session,
				text: input.commandLine,
				submit: true,
			});
		}
		paneRegistered = await registerRemoteHmuxPaneDurably(registration);
		if (!paneRegistered) {
			throw new RemoteHmuxOpenError(
				"remote_hmux_host_changed_before_pane_commit",
				"SSH host changed before pane commit",
			);
		}
		const projected = await recoverCurrentDurableStoreProjection({
			forceProjectionDesktopIds: [input.desktopId],
		});
		if (!projected) {
			throw new RemoteHmuxOpenError(
				"remote_hmux_pane_projection_failed",
				"durable projection failed before pane mount",
			);
		}
		if (!remoteHmuxPaneRegistrationApplies(registration, useStore.getState())) {
			throw new RemoteHmuxOpenError(
				"remote_hmux_pane_registration_superseded",
				"SSH host or pane registration changed before pane mount",
			);
		}
		const mountApi = await waitForDesktopDockview(input.desktopId);
		if (!mountApi) {
			throw new RemoteHmuxOpenError(
				"remote_hmux_desktop_unavailable_before_pane_mount",
				"the target desktop is no longer available",
			);
		}
		if (!remoteHmuxPaneRegistrationApplies(registration, useStore.getState())) {
			throw new RemoteHmuxOpenError(
				"remote_hmux_pane_registration_superseded",
				"SSH host or pane registration changed before pane focus",
			);
		}
		const panel = mountApi.getPanel(panelId);
		if (!panel || !remoteHmuxMountedPaneApplies(registration, panel)) {
			throw new RemoteHmuxOpenError(
				"remote_hmux_pane_projection_incomplete",
				"the durable pane generation was not mounted",
			);
		}
		panel.api.setActive();
		// pane 이 실제로 열린 뒤에만 기록한다 — 분할 메뉴의 "최근"은 사용자가
		// 고른 적이 아니라 실제로 붙은 적이 있는 호스트를 가리켜야 한다.
		noteSshHostUsed(host.id);
	} catch (error) {
		if (!paneRegistered || !registration) {
			await depart();
		} else {
			try {
				if (!(await hasDurableRemoteHmuxPaneReference(registration))) {
					await depart();
				}
			} catch (referenceError) {
				console.error(
					"[remote Hmux pane] durable reference check failed",
					referenceError,
				);
			}
		}
		throw error;
	}
	return {
		sessionId: session.sessionId,
		workspaceId: session.workspaceId,
		panelId,
		binding,
		cwd: input.cwd ?? null,
		readiness: { pane: "mounted", session: session.lifecycle },
	};
}

/**
 * Reports creation failures for callers without an error surface. Preserve the
 * actual failure detail; a gateway refusal does not imply a missing runtime.
 */
export function openRemoteHmuxTerminalDetached(
	input: RemoteHmuxTerminalOpenInput,
): Promise<void> {
	return openRemoteHmuxTerminal(input)
		.then(() => undefined)
		.catch((error: unknown) => {
			const detail = error instanceof Error ? error.message : String(error);
			showErrorToast(
				t("hmux.remote.openFailed", {
					host: input.hostName || input.hostId,
					detail,
				}),
			);
		});
}
