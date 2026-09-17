import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { nanoid } from "nanoid";
import { hmuxPaneOwnerId } from "@/lib/hmux/hmuxPaneRetirement";
import {
	planRemoteHmuxCatalogTarget,
	type RemoteHmuxStandaloneCreateRequestV1,
} from "@/lib/hmux/remote/remoteHmuxBroker";
import {
	acceptRemoteHmuxAttachReceipt,
	beginRemoteHmuxPaneTransition,
	isRemoteHmuxPaneTransitionV1,
} from "@/lib/hmux/remote/remoteHmuxPaneTransition";
import {
	type RemoteShellHostDraft,
	remoteShellHostCandidate,
} from "@/lib/hmux/remote/remoteHmuxShellRegistration";
import { hasDurableRemoteHmuxShellPreparation } from "@/lib/hmux/remote/remoteHmuxShellPreparation";
import {
	matchRemoteHmuxHost,
	parseRemoteHmuxShellRequest,
	type RemoteShellRequest,
} from "@/lib/hmux/remote/remoteHmuxShellRequest";
import {
	remoteHmuxDepartGracefully,
	remoteHmuxKnownHostTrust,
	remoteHmuxStandaloneCreate,
	sshConfigHosts,
} from "@/lib/ipc";
import { registerSshLoginHostDurably } from "@/lib/ssh/sshCredentialLifecycle";
import {
	bindingFromPane,
	type HmuxManagedPaneBindingV1,
	type HmuxStandalonePaneBindingV1,
	remoteHmuxStandaloneBinding,
	sameHmuxManagedLaunchBinding,
} from "@/lib/terminal/terminalBinding";
import { resolvePaneReference } from "@/lib/workspace/dock";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { commitExplicitDockviewMutation } from "@/lib/workspace/dock/explicitDockviewCommit";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { durableAppStorage, useStore } from "@/store";

function exactLocalSourceBinding(
	value: ReturnType<typeof bindingFromPane>,
	request: RemoteShellRequest,
): value is HmuxStandalonePaneBindingV1 | HmuxManagedPaneBindingV1 {
	return (
		(value?.runtime === "hmux_standalone_v1" ||
			value?.runtime === "hmux_managed_v1") &&
		value.source === "local" &&
		value.hostId === "local" &&
		value.sessionId === request.sourceSessionId &&
		value.workspaceId === request.sourceWorkspaceId
	);
}

function sameLocalSourceBinding(
	value: ReturnType<typeof bindingFromPane>,
	source: HmuxStandalonePaneBindingV1 | HmuxManagedPaneBindingV1,
): boolean {
	if (source.runtime === "hmux_managed_v1") {
		return sameHmuxManagedLaunchBinding(value, source);
	}
	return (
		value?.runtime === "hmux_standalone_v1" &&
		value.source === "local" &&
		value.hostId === "local" &&
		value.sessionId === source.sessionId &&
		value.workspaceId === source.workspaceId
	);
}

function createRequest(
	request: RemoteShellRequest,
	target: ReturnType<typeof planRemoteHmuxCatalogTarget>,
	operationId: string,
): RemoteHmuxStandaloneCreateRequestV1 {
	const targetSessionId = `standalone_${operationId}`;
	return {
		target,
		requestId: operationId,
		targetSessionId,
		launchOwnerProof: `remote_launch_${nanoid(32)}`,
		// A host display name is user-authored and may contain whitespace or
		// Unicode. The remote protocol deliberately accepts only bounded safe
		// identifiers, so bind the name to our generated opaque identity.
		sessionName: `remote-${targetSessionId}`,
		bridgeNonce: `bridge_${operationId}`,
		initialRows: request.initialRows,
		initialColumns: request.initialColumns,
		commandIntercepts: [
			{ command: "claude", providerId: "claude" },
			{ command: "codex", providerId: "codex" },
		],
	};
}

export async function handleRemoteHmuxShellHandoff(
	params: Record<string, unknown>,
	claim: () => Promise<boolean>,
	decide?: (candidate: RemoteShellHostDraft) => Promise<boolean | null>,
) {
	const request = parseRemoteHmuxShellRequest(params);
	const initialState = useStore.getState();
	let host = matchRemoteHmuxHost(initialState.sshHosts, request.destination);
	if (!host && !decide) return { ok: false, fallback: true };

	let resolved: Awaited<ReturnType<typeof resolvePaneReference>>;
	try {
		resolved = await resolvePaneReference(request.sourceSessionId);
	} catch {
		return { ok: false, fallback: true };
	}
	const initialPanel = resolved.api.getPanel(resolved.panelId);
	if (!initialPanel) return { ok: false, fallback: true };
	const sourceBinding = bindingFromPane(
		dockPanelReference(initialPanel),
		initialState.agents,
		initialState.projects,
	);
	if (!exactLocalSourceBinding(sourceBinding, request)) {
		return { ok: false, fallback: true };
	}
	if (!host) {
		const config = await sshConfigHosts().catch(() => undefined);
		if (!config) return { ok: false, fallback: true };
		const candidate = remoteShellHostCandidate(
			initialState.sshHosts,
			request.destination,
			config,
		);
		if (!candidate || !decide) {
			return { ok: false, fallback: true };
		}
		const accepted = await decide(candidate);
		if (accepted === null) return { ok: false, unavailable: true };
		if (!accepted) return { ok: false, fallback: true };
		// Approval belongs to the original source. A closed or replaced pane
		// cannot register a destination or acquire a remote session afterward.
		const panel = resolved.api.getPanel(resolved.panelId);
		const state = useStore.getState();
		if (
			!panel ||
			!sameLocalSourceBinding(
				bindingFromPane(
					dockPanelReference(panel),
					state.agents,
					state.projects,
				),
				sourceBinding,
			)
		)
			return { ok: false, fallback: true };
		if (!(await claim())) return { ok: false, fallback: true };
		host = (await registerSshLoginHostDurably(candidate)).host;
	}

	const trust = await remoteHmuxKnownHostTrust(host.id, host.host, host.port);
	const target = planRemoteHmuxCatalogTarget(
		useStore.getState().sshHosts,
		host.id,
		trust,
	);
	if (!(await claim())) {
		throw new PaneCommandError(
			"request_expired",
			"remote Hmux handoff expired before remote session creation",
		);
	}
	const sourcePanel = resolved.api.getPanel(resolved.panelId);
	const sourcePane = sourcePanel && dockPanelReference(sourcePanel);
	const latest = useStore.getState();
	if (
		!sourcePanel ||
		!sourcePane ||
		!sameLocalSourceBinding(
			bindingFromPane(
				sourcePane,
				latest.agents,
				latest.projects,
			),
			sourceBinding,
		)
	) {
		throw new PaneCommandError(
			"pane_changed",
			"source pane changed before remote Hmux creation",
		);
	}
	const sourceParams = sourcePane.params;
	const saved = sourceParams.remoteHmuxTransition;
	if (
		saved !== undefined &&
		(!isRemoteHmuxPaneTransitionV1(saved) ||
			saved.phase !== "preparing" ||
			saved.targetHostId !== host.id ||
			!sameLocalSourceBinding(saved.sourceBinding, sourceBinding))
	) {
		throw new PaneCommandError(
			"pane_changed",
			"another remote Hmux operation owns this pane",
		);
	}
	const preparing =
		saved === undefined
			? beginRemoteHmuxPaneTransition(
					sourceBinding,
					host.id,
					`remote_shell_${nanoid(32)}`,
				)
			: saved;
	if (saved === undefined) {
		// Persist the existing operation handle before any remote creation. The
		// native journal owns the private launch proof and complete first request.
		commitExplicitDockviewMutation({
			desktopId: resolved.desktopId,
			api: resolved.api,
			mutate: () =>
				sourcePanel.api.updateParameters({
					...sourceParams,
					remoteHmuxTransition: preparing,
				}),
			targetChangedError: () =>
				new PaneCommandError(
					"pane_changed",
					"source desktop changed before remote Hmux preparation",
				),
		});
	}
	await durableAppStorage.flush();
	if (
		!(await hasDurableRemoteHmuxShellPreparation(
			resolved.desktopId,
			resolved.panelId,
			host,
			preparing,
		))
	) {
		throw new PaneCommandError(
			"pane_changed",
			"remote Hmux preparation is no longer the durable pane operation",
		);
	}
	const admittedPanel = resolved.api.getPanel(resolved.panelId);
	const admittedPane = admittedPanel && dockPanelReference(admittedPanel);
	const admittedState = useStore.getState();
	if (
		!admittedPane ||
		!sameLocalSourceBinding(
			bindingFromPane(
				admittedPane,
				admittedState.agents,
				admittedState.projects,
			),
			sourceBinding,
		)
	) {
		throw new PaneCommandError(
			"pane_changed",
			"source pane changed while remote Hmux preparation was persisted",
		);
	}
	const create = createRequest(request, target, preparing.createIdempotencyKey);
	const paneOwnerId = hmuxPaneOwnerId(
		getCurrentWebviewWindow().label,
		resolved.desktopId,
		initialPanel.id,
	);
	// The Tauri create command does not return until it has retained the launch
	// proof under this exact pane identity. No proof enters layout/store: a close
	// before native attach asks the adapter to exercise that pending authority.
	const receipt = await remoteHmuxStandaloneCreate(create, paneOwnerId);
	try {
		const targetBinding = remoteHmuxStandaloneBinding(
			receipt.session.sessionId,
			receipt.session.workspaceId,
			host.id,
			receipt.bridgeNonce,
		);
		const transition = acceptRemoteHmuxAttachReceipt(preparing, {
			createIdempotencyKey: preparing.createIdempotencyKey,
			targetBinding,
		});
		if (!transition) {
			throw new PaneCommandError(
				"pane_changed",
				"remote Hmux create receipt did not match the pane transition",
			);
		}

		const livePanel = resolved.api.getPanel(resolved.panelId);
		if (!livePanel) {
			throw new PaneCommandError(
				"pane_not_found",
				"source pane detached after remote Hmux creation",
			);
		}
		const liveState = useStore.getState();
		const livePane = dockPanelReference(livePanel);
		const liveParams = livePane.params;
		const liveBinding = bindingFromPane(
			livePane,
			liveState.agents,
			liveState.projects,
		);
		if (!sameLocalSourceBinding(liveBinding, sourceBinding)) {
			throw new PaneCommandError(
				"pane_changed",
				"source pane changed after remote Hmux creation",
			);
		}
		commitExplicitDockviewMutation({
			desktopId: resolved.desktopId,
			api: resolved.api,
			mutate: () => {
				livePanel.api.updateParameters({
					...liveParams,
					sessionId: targetBinding.sessionId,
					binding: targetBinding,
					remoteHmuxTransition: transition,
				});
				livePanel.api.setActive();
			},
			targetChangedError: () =>
				new PaneCommandError(
					"pane_changed",
					"source desktop changed before remote Hmux handoff committed",
				),
		});
		return {
			ok: true,
			pane: {
				desktopId: resolved.desktopId,
				panelId: livePanel.id,
				sessionId: targetBinding.sessionId,
				workspaceId: targetBinding.workspaceId,
				hostId: targetBinding.hostId,
				runtime: targetBinding.runtime,
			},
		};
	} catch (error) {
		await remoteHmuxDepartGracefully(
			target,
			receipt.session,
			paneOwnerId,
		).catch(() => {
			// Fail-preserve: an uncertain transport or a raced attachment must
			// never fall back to direct remote process termination.
		});
		throw error;
	}
}
