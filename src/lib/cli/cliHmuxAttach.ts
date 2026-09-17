import type { DockviewApi } from "dockview-react";
import {
	type CliHmuxPaneIdentity,
	cliHmuxPaneActivationErrorCode,
	projectStandalonePaneReceipt,
	resolveCliHmuxPlacement,
	resolveCliStandaloneHmuxSession,
	waitForCliHmuxPaneActivation,
} from "@/lib/cli/cliHmuxPaneActivation";
import { cliHmuxPaneActivationDependencies } from "@/lib/cli/cliHmuxPaneActivationRuntime";
import { claimCliRequest } from "@/lib/cli/cliRequestBroker";
import {
	cliSpaceIdentityErrorCode,
	resolveCliSpaceId,
} from "@/lib/cli/cliSpaceIdentity";
import { inspectHmuxSessionExact } from "@/lib/hmux/identity/exactHmuxSessionInspection";
import {
	type RetargetHmuxStandalonePaneReceipt,
	type RetargetHmuxStandalonePaneRequest,
	retargetHmuxStandaloneTerminalPanel,
} from "@/lib/hmux/standalone/standaloneHmuxPaneSet";
import { type HmuxPaneAttachmentStatus, hmux } from "@/lib/ipc";
import { resolvePaneReference } from "@/lib/workspace/dock";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { openAndCommitHmuxStandaloneTerminalOn } from "@/lib/workspace/dock/standaloneShellTerminal";
import { preparePaneProjectionRemoval } from "@/lib/workspace/pane/paneCloseCoordinator";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";
import { useStore } from "@/store";

interface CliHmuxAttachSession {
	readonly sessionId: string;
	readonly workspaceId: string;
}

interface CliHmuxAttachPlacement {
	readonly desktopId: string;
	readonly api: DockviewApi;
	readonly panelId: string;
	readonly cwd?: string;
	readonly direction: "right" | "below";
	readonly position: PanelPosition;
}

/** The attach transaction can present an existing session, but deliberately
 * has no capability to create, restart, stop, or abandon session lifetime. */
export interface CliHmuxAttachDependencies {
	claim(reqId: string): Promise<boolean>;
	resolveSession(
		params: Record<string, unknown>,
	): Promise<CliHmuxAttachSession>;
	retarget(
		request: RetargetHmuxStandalonePaneRequest,
		claim: () => Promise<boolean>,
	): Promise<RetargetHmuxStandalonePaneReceipt>;
	resolvePlacement(
		params: Record<string, unknown>,
	): Promise<CliHmuxAttachPlacement | undefined>;
	activeSpaceId(): string;
	getDockview(desktopId: string): DockviewApi | undefined;
	openAndCommit: typeof openAndCommitHmuxStandaloneTerminalOn;
	preparePaneRemoval: typeof preparePaneProjectionRemoval;
	waitForActivation(
		identity: CliHmuxPaneIdentity,
	): Promise<HmuxPaneAttachmentStatus>;
}

const defaultDependencies: CliHmuxAttachDependencies = {
	claim: claimCliRequest,
	resolveSession: (params) =>
		resolveCliStandaloneHmuxSession(params, {
			resolveNamedSession: hmux.resolveNamedSession,
			inspectSession: inspectHmuxSessionExact,
		}),
	retarget: retargetHmuxStandaloneTerminalPanel,
	resolvePlacement: (params) =>
		resolveCliHmuxPlacement(params, resolvePaneReference),
	activeSpaceId: () => useStore.getState().activeSpaceId,
	getDockview,
	openAndCommit: openAndCommitHmuxStandaloneTerminalOn,
	preparePaneRemoval: preparePaneProjectionRemoval,
	waitForActivation: (identity) =>
		waitForCliHmuxPaneActivation(identity, cliHmuxPaneActivationDependencies),
};

function errorPayload(error: unknown) {
	return {
		code:
			error instanceof PaneCommandError
				? error.code
				: (cliSpaceIdentityErrorCode(error) ??
					cliHmuxPaneActivationErrorCode(error) ??
					"hmux_attach_failed"),
		message: error instanceof Error ? error.message : String(error),
	};
}

/** Attach one pre-existing standalone Hmux session to a durable pane. An
 * explicit target completes at the correlated retarget commit because a cold
 * Space intentionally has no native surface to acknowledge yet. */
export async function handleCliHmuxAttach(
	params: Record<string, unknown>,
	reqId: string,
	dependencies: CliHmuxAttachDependencies = defaultDependencies,
) {
	let claimed: boolean | undefined;
	const claim = async () => {
		if (claimed !== undefined) return claimed;
		claimed = await dependencies.claim(reqId);
		return claimed;
	};
	try {
		const requestedSpaceId = resolveCliSpaceId(params);
		const { sessionId, workspaceId } =
			await dependencies.resolveSession(params);
		const targetPanelId = String(params.targetPanelId ?? "").trim();
		if (targetPanelId) {
			const pane = await dependencies.retarget(
				{
					panelId: targetPanelId,
					sessionId,
					workspaceId,
					cwd: params.cwd ? String(params.cwd) : undefined,
				},
				claim,
			);
			return { ok: true, pane: projectStandalonePaneReceipt(pane) };
		}

		const placement = await dependencies.resolvePlacement(params);
		if (!(await claim())) return null;
		const desktopId =
			placement?.desktopId ?? requestedSpaceId ?? dependencies.activeSpaceId();
		const api = placement?.api ?? dependencies.getDockview(desktopId);
		if (!api) {
			throw new PaneCommandError(
				"pane_not_found",
				`desktop ${desktopId} is not mounted`,
			);
		}
		const cwd = params.cwd ? String(params.cwd) : undefined;
		const { panel, paneOwnership } = dependencies.openAndCommit(
			desktopId,
			api,
			sessionId,
			workspaceId,
			cwd,
			placement?.position,
		);
		const panelId = panel.id;
		const removePane =
			paneOwnership === "created_by_request"
				? dependencies.preparePaneRemoval(desktopId, api, panel)
				: undefined;
		const attachment = await dependencies
			.waitForActivation({ desktopId, panelId, sessionId, workspaceId })
			.catch((error) => {
				try {
					removePane?.();
				} catch (cleanupError) {
					console.error(
						`[cli hmux.attach] pane compensation failed for ${sessionId}: ${cleanupError}`,
					);
				}
				throw error;
			});
		return {
			ok: true,
			pane: projectStandalonePaneReceipt(
				{
					desktopId,
					panelId,
					sessionId,
					workspaceId,
					cwd,
					sessionOwnership: "pre_existing",
					paneOwnership,
					...(placement
						? {
								referencePanelId: placement.panelId,
								direction: placement.direction,
							}
						: {}),
				},
				attachment,
			),
		};
	} catch (error) {
		if (!(await claim())) return null;
		return { ok: false, error: errorPayload(error) };
	}
}
