import { inspectHmuxSessionExact } from "@/lib/hmux/identity/exactHmuxSessionInspection";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import {
	HMUX_LOCAL_SHELL_WORKSPACE_ID,
	isHmuxLocalShellBinding,
} from "@/lib/hmux/identity/hmuxProviderSessionSource";
import { type HmuxManagedStopFenceV1, hmux, homeDir } from "@/lib/ipc";
import {
	type HmuxManagedPaneBindingV1,
	hmuxManagedBinding,
} from "@/lib/terminal/terminalBinding";
import { currentTerminalDefaultColors } from "@/lib/theme/themePreference";
import { resolvePaneById } from "@/lib/workspace/dock";
import { dockPanelParameters } from "@/lib/workspace/dock/dockPanelParameters";
import { commitExplicitDockviewMutation } from "@/lib/workspace/dock/explicitDockviewCommit";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";

const STRUCTURED_CAPABILITY = "terminal_state_binary_v1";

interface ManagedShellUpgradeMarkerV1 {
	schemaVersion: 1;
	operationId: string;
	sourceSessionId: string;
	sourceWorkspaceId: string;
	sourceCreateIdempotencyKey?: string;
	sourceStopFence: HmuxManagedStopFenceV1;
	targetSessionId: string;
	targetWorkspaceId: string;
}

function sameRuntime(
	left: { sessionId: string; workspaceId: string },
	right: { sessionId: string; workspaceId: string },
): boolean {
	return (
		left.sessionId === right.sessionId && left.workspaceId === right.workspaceId
	);
}

function marker(value: unknown): ManagedShellUpgradeMarkerV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const candidate = value as Partial<ManagedShellUpgradeMarkerV1>;
	return candidate.schemaVersion === 1 &&
		typeof candidate.operationId === "string" &&
		typeof candidate.sourceSessionId === "string" &&
		typeof candidate.sourceWorkspaceId === "string" &&
		(candidate.sourceCreateIdempotencyKey === undefined ||
			(typeof candidate.sourceCreateIdempotencyKey === "string" &&
				candidate.sourceCreateIdempotencyKey.length > 0)) &&
		candidate.sourceStopFence !== undefined &&
		typeof candidate.targetSessionId === "string" &&
		typeof candidate.targetWorkspaceId === "string"
		? (candidate as ManagedShellUpgradeMarkerV1)
		: undefined;
}

async function identityDigest(parts: readonly string[]): Promise<string> {
	const encoded = new TextEncoder().encode(parts.join("\0"));
	const bytes = new Uint8Array(
		await globalThis.crypto.subtle.digest("SHA-256", encoded),
	);
	return [...bytes]
		.slice(0, 16)
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

async function clearMarker(
	targetPanelId: string,
	expected: ManagedShellUpgradeMarkerV1,
): Promise<void> {
	const resolved = await resolvePaneById(targetPanelId);
	const panel = resolved.api.getPanel(resolved.panelId);
	if (!panel) return;
	const params = dockPanelParameters(panel);
	const current = marker(params.managedShellUpgrade);
	if (
		!current ||
		current.operationId !== expected.operationId ||
		params.sessionId !== expected.targetSessionId
	) {
		return;
	}
	commitExplicitDockviewMutation({
		desktopId: resolved.desktopId,
		api: resolved.api,
		mutate: () => {
			const { managedShellUpgrade: _completed, ...next } = params;
			// Dockview merges parameter updates, so omission does not clear a
			// completed recovery journal field.
			panel.api.updateParameters({
				...next,
				managedShellUpgrade: undefined,
			});
		},
		targetChangedError: () =>
			new PaneCommandError(
				"pane_changed",
				"managed shell pane changed while clearing its upgrade receipt",
			),
	});
}

async function finishPendingUpgrade(
	targetPanelId: string,
	pending: ManagedShellUpgradeMarkerV1,
) {
	const source = await inspectHmuxSessionExact({
		sessionId: pending.sourceSessionId,
		workspaceId: pending.sourceWorkspaceId,
	});
	if (source) {
		if (!sameHmuxManagedGeneration(source.stopFence, pending.sourceStopFence)) {
			throw new PaneCommandError(
				"pane_changed",
				"managed shell upgrade source changed before cleanup",
			);
		}
	}
	if (source || pending.sourceCreateIdempotencyKey) {
		await closeUpgradeSource(pending);
	}
	await clearMarker(targetPanelId, pending);
	return {
		ok: true as const,
		upgrade: {
			action: "upgrade_managed_shell_with_current_build",
			outcome: "rehosted",
			replayed: true,
			sourceSessionId: pending.sourceSessionId,
			sourceWorkspaceId: pending.sourceWorkspaceId,
		},
		pane: {
			panelId: targetPanelId,
			sessionId: pending.targetSessionId,
			workspaceId: pending.targetWorkspaceId,
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
		},
	};
}

function closeUpgradeSource(pending: ManagedShellUpgradeMarkerV1) {
	if (pending.sourceCreateIdempotencyKey) {
		return hmux.stopManagedCreateChain(
			pending.sourceCreateIdempotencyKey,
			pending.sourceSessionId,
			pending.sourceWorkspaceId,
		);
	}
	// Older upgrade journals retain only an exact generation. Do not invent a
	// create identity or a product resource binding for those legacy sources.
	return hmux.stopManaged(
		`stop_${pending.operationId}`,
		pending.sourceSessionId,
		pending.sourceWorkspaceId,
		pending.sourceStopFence,
	);
}

/** Returns undefined when the pane is not a local managed shell so the
 * standalone upgrade path can inspect it. The source stays live until a
 * current-build target is ready and the same panel has committed its binding. */
export async function tryUpgradeManagedHmuxShell(
	params: Record<string, unknown>,
	claimRequest: () => Promise<boolean>,
) {
	const targetPanelId = String(params.targetPanelId ?? "").trim();
	if (!targetPanelId) return undefined;
	const resolved = await resolvePaneById(targetPanelId);
	const panel = resolved.api.getPanel(resolved.panelId);
	if (!panel) return undefined;
	const initialParams = dockPanelParameters(panel);
	const sourceBinding = isHmuxLocalShellBinding(
		initialParams.binding,
		panel.api.component,
	)
		? initialParams.binding
		: undefined;
	if (!sourceBinding || initialParams.sessionId !== sourceBinding.sessionId) {
		return undefined;
	}

	const pending = marker(initialParams.managedShellUpgrade);
	if (
		pending &&
		sameRuntime(sourceBinding, {
			sessionId: pending.targetSessionId,
			workspaceId: pending.targetWorkspaceId,
		})
	) {
		if (!(await claimRequest())) return null;
		return finishPendingUpgrade(targetPanelId, pending);
	}

	if (params.confirmRestart !== true) {
		throw new PaneCommandError(
			"invalid_request",
			"upgrading a managed shell restarts that shell; pass --confirm-restart",
		);
	}
	const state = useStore.getState();
	if (
		state.sessionAgentPin[sourceBinding.sessionId] !== undefined ||
		state.sessionAgent[sourceBinding.sessionId] !== undefined ||
		state.agents.some((agent) => agent.sessionId === sourceBinding.sessionId)
	) {
		throw new PaneCommandError(
			"invalid_request",
			"managed Agent panes must use conversation-preserving rehost",
		);
	}
	const source = await inspectHmuxSessionExact({
		sessionId: sourceBinding.sessionId,
		workspaceId: sourceBinding.workspaceId,
	});
	const persistedStopFence =
		sourceBinding.runtime === "hmux_managed_v1"
			? sourceBinding.stopFence
			: undefined;
	const sourceManifestReady =
		source?.manifestLifecycle === "ready" ||
		(source?.manifestLifecycle === undefined && source?.lifecycle === "ready");
	if (
		source &&
		persistedStopFence &&
		!sameHmuxManagedGeneration(source.stopFence, persistedStopFence)
	) {
		throw new PaneCommandError(
			"pane_changed",
			"managed shell source changed from the pane's exact generation",
		);
	}
	const sourceStopFence = source?.stopFence ?? persistedStopFence;
	if (
		(source !== undefined &&
			(source.sessionClass !== "managed" || !sourceManifestReady)) ||
		!sourceStopFence
	) {
		throw new PaneCommandError(
			"pane_changed",
			"managed shell source is not an exact recoverable generation",
		);
	}
	const sourceIsWritable =
		source?.lifecycle === "ready" &&
		source.inputAllowed === true &&
		source.detachOnly !== true;
	if (
		params.forceRestart !== true &&
		sourceIsWritable &&
		source?.capabilities.includes(STRUCTURED_CAPABILITY) === true
	) {
		return {
			ok: true as const,
			upgrade: {
				action: "upgrade_managed_shell_with_current_build",
				outcome: "already_current",
				replayed: false,
				sourceSessionId: source.sessionId,
				sourceWorkspaceId: source.workspaceId,
				replacementSession: source,
			},
			pane: {
				desktopId: resolved.desktopId,
				panelId: resolved.panelId,
				sessionId: source.sessionId,
				workspaceId: source.workspaceId,
				runtime: "hmux_managed_v1",
				source: "local",
				hostId: "local",
			},
		};
	}
	if (!(await claimRequest())) return null;

	const cwd =
		(typeof initialParams.cwd === "string" && initialParams.cwd) ||
		state.sessionCwd[sourceBinding.sessionId] ||
		(await homeDir());
	const digest = await identityDigest([
		"managed-shell-build-upgrade-v1",
		sourceBinding.workspaceId,
		sourceBinding.sessionId,
		sourceStopFence.terminalEpoch,
	]);
	const operationId = `upgrade_shell_${digest}`;
	const targetSessionId = `managed_shell_${digest}`;
	const created = await hmux.createManagedShell({
		idempotencyKey: operationId,
		sessionId: targetSessionId,
		workspaceId: HMUX_LOCAL_SHELL_WORKSPACE_ID,
		cwd,
		columns: 120,
		rows: 30,
		terminalDefaultColors: currentTerminalDefaultColors(),
	});
	const targetStopFence = created.session.stopFence;
	if (
		created.idempotencyKey !== operationId ||
		created.session.sessionId !== targetSessionId ||
		created.session.workspaceId !== HMUX_LOCAL_SHELL_WORKSPACE_ID ||
		created.session.sessionClass !== "managed" ||
		created.session.lifecycle !== "ready" ||
		!created.session.capabilities.includes(STRUCTURED_CAPABILITY) ||
		!targetStopFence
	) {
		if (created.outcome === "created") {
			await hmux
				.stopManagedCreateChain(
					operationId,
					targetSessionId,
					HMUX_LOCAL_SHELL_WORKSPACE_ID,
				)
				.catch(() => undefined);
		}
		throw new Error("managed shell upgrade target is not structured and ready");
	}

	const livePanel = resolved.api.getPanel(resolved.panelId);
	const liveParams = livePanel ? dockPanelParameters(livePanel) : undefined;
	const liveBinding = isHmuxLocalShellBinding(
		liveParams?.binding,
		livePanel?.api.component,
	)
		? liveParams.binding
		: undefined;
	if (
		!livePanel ||
		!liveParams ||
		!liveBinding ||
		!sameRuntime(liveBinding, sourceBinding) ||
		liveParams.sessionId !== sourceBinding.sessionId
	) {
		if (created.outcome === "created") {
			await hmux.stopManagedCreateChain(
				operationId,
				targetSessionId,
				HMUX_LOCAL_SHELL_WORKSPACE_ID,
			);
		}
		throw new PaneCommandError(
			"pane_changed",
			"managed shell pane changed before current-build target commit",
		);
	}

	const upgradeMarker: ManagedShellUpgradeMarkerV1 = {
		schemaVersion: 1,
		operationId,
		sourceSessionId: sourceBinding.sessionId,
		sourceWorkspaceId: sourceBinding.workspaceId,
		sourceCreateIdempotencyKey:
			sourceBinding.runtime === "hmux_managed_v1"
				? sourceBinding.createIdempotencyKey
				: undefined,
		sourceStopFence,
		targetSessionId: created.session.sessionId,
		targetWorkspaceId: created.session.workspaceId,
	};
	const targetBinding: HmuxManagedPaneBindingV1 = {
		...hmuxManagedBinding(
			created.session.sessionId,
			created.session.workspaceId,
			undefined,
			undefined,
			targetStopFence,
		),
		createIdempotencyKey: operationId,
	};
	useStore.getState().setHmuxSessionMetadata(created.session);
	commitExplicitDockviewMutation({
		desktopId: resolved.desktopId,
		api: resolved.api,
		mutate: () => {
			livePanel.api.updateParameters({
				...liveParams,
				sessionId: created.session.sessionId,
				cwd,
				binding: targetBinding,
				managedShellUpgrade: upgradeMarker,
			});
			if (params.activate !== false) livePanel.api.setActive();
		},
		targetChangedError: () =>
			new PaneCommandError(
				"pane_changed",
				"managed shell desktop changed before current-build target commit",
			),
	});

	await closeUpgradeSource(upgradeMarker);
	await clearMarker(targetPanelId, upgradeMarker);
	return {
		ok: true as const,
		upgrade: {
			action: "upgrade_managed_shell_with_current_build",
			outcome: "rehosted",
			replayed: created.outcome !== "created",
			sourceSessionId: sourceBinding.sessionId,
			sourceWorkspaceId: sourceBinding.workspaceId,
			replacementSession: created.session,
		},
		pane: {
			desktopId: resolved.desktopId,
			panelId: resolved.panelId,
			sessionId: created.session.sessionId,
			workspaceId: created.session.workspaceId,
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
		},
	};
}
