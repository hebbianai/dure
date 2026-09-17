import type { DockviewApi } from "dockview-react";
import {
	type CliHmuxPaneIdentity,
	cliHmuxPaneActivationErrorCode,
	projectStandalonePaneReceipt,
	resolveCliHmuxPlacement,
	waitForCliHmuxPaneActivation,
} from "@/lib/cli/cliHmuxPaneActivation";
import { cliHmuxPaneActivationDependencies } from "@/lib/cli/cliHmuxPaneActivationRuntime";
import { claimCliRequest } from "@/lib/cli/cliRequestBroker";
import { cliSpaceIdentityErrorCode } from "@/lib/cli/cliSpaceIdentity";
import {
	type CliSpaceOwnerRoute,
	routeCliRequestToSpaceOwner,
} from "@/lib/cli/cliSpaceOwnerRouting";
import {
	openRemoteHmuxTerminal,
	RemoteHmuxOpenError,
} from "@/lib/hmux/remote/remoteHmuxTerminalSession";
import { type HmuxPaneAttachmentStatus, hmux, homeDir } from "@/lib/ipc";
import type { TerminalDefaultColors } from "@/lib/terminal/state/terminalDefaultColors";
import { terminalEnvironmentParam } from "@/lib/terminal/terminalEnvironmentParam";
import { currentTerminalDefaultColors } from "@/lib/theme/themePreference";
import { resolvePaneReference } from "@/lib/workspace/dock";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { openAndCommitHmuxStandaloneTerminalOn } from "@/lib/workspace/dock/standaloneShellTerminal";
import { preparePaneProjectionRemoval } from "@/lib/workspace/pane/paneCloseCoordinator";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import type {
	PanelPosition,
	PanePresentation,
} from "@/lib/workspace/pane/panePlacement";
import { useStore } from "@/store";

interface CliHmuxCreatedSession {
	readonly sessionId: string;
	readonly workspaceId: string;
}

interface CliHmuxCreatePlacement {
	readonly desktopId: string;
	readonly api: DockviewApi;
	readonly panelId: string;
	readonly cwd?: string;
	readonly direction: "right" | "below";
	readonly position: PanelPosition;
}

type CreateStandaloneRequest = Parameters<(typeof hmux)["createStandalone"]>[0];

/** The create transaction is the sole owner of the new session lifetime until
 * an exact pane attachment acknowledges presentation. */
export interface CliHmuxCreateDependencies {
	claim(reqId: string): Promise<boolean>;
	routeToSpaceOwner(request: {
		reqId: string;
		params: Record<string, unknown>;
	}): Promise<CliSpaceOwnerRoute>;
	spaceExists(spaceId: string): boolean;
	resolvePlacement(
		params: Record<string, unknown>,
	): Promise<CliHmuxCreatePlacement | undefined>;
	activeSpaceId(): string;
	getDockview(desktopId: string): DockviewApi | undefined;
	homeDir(): Promise<string>;
	terminalDefaultColors(): TerminalDefaultColors;
	createStandalone(
		request: CreateStandaloneRequest,
	): Promise<CliHmuxCreatedSession>;
	openAndCommit: typeof openAndCommitHmuxStandaloneTerminalOn;
	openRemote: typeof openRemoteHmuxTerminal;
	waitForActivation(
		identity: CliHmuxPaneIdentity,
	): Promise<HmuxPaneAttachmentStatus>;
	preparePaneRemoval: typeof preparePaneProjectionRemoval;
	abandonUnpresentedCreation(
		sessionId: string,
		workspaceId: string,
	): Promise<unknown>;
}

const defaultDependencies: CliHmuxCreateDependencies = {
	claim: claimCliRequest,
	routeToSpaceOwner: (request) =>
		routeCliRequestToSpaceOwner({ ...request, action: "hmux.create" }),
	spaceExists: (spaceId) =>
		useStore.getState().spaces.some((space) => space.id === spaceId),
	resolvePlacement: (params) =>
		resolveCliHmuxPlacement(params, resolvePaneReference),
	activeSpaceId: () => useStore.getState().activeSpaceId,
	getDockview,
	homeDir,
	terminalDefaultColors: currentTerminalDefaultColors,
	createStandalone: (request) => hmux.createStandalone(request),
	openAndCommit: openAndCommitHmuxStandaloneTerminalOn,
	openRemote: openRemoteHmuxTerminal,
	waitForActivation: (identity) =>
		waitForCliHmuxPaneActivation(identity, cliHmuxPaneActivationDependencies),
	preparePaneRemoval: preparePaneProjectionRemoval,
	abandonUnpresentedCreation: (sessionId, workspaceId) =>
		hmux.abandonUnpresentedCreation(sessionId, workspaceId),
};

function errorPayload(error: unknown) {
	return {
		code:
			error instanceof PaneCommandError || error instanceof RemoteHmuxOpenError
				? error.code
				: (cliSpaceIdentityErrorCode(error) ??
					cliHmuxPaneActivationErrorCode(error) ??
					"hmux_create_failed"),
		message: error instanceof Error ? error.message : String(error),
		...(error instanceof RemoteHmuxOpenError && error.nextAction
			? { nextAction: error.nextAction }
			: {}),
	};
}

async function abandonCreatedSession(
	dependencies: CliHmuxCreateDependencies,
	created: CliHmuxCreatedSession,
): Promise<void> {
	await dependencies
		.abandonUnpresentedCreation(created.sessionId, created.workspaceId)
		.catch((cleanupError) => {
			console.error(
				`[cli hmux.create] safe unpresented-create compensation failed for ${created.sessionId}: ${cleanupError}`,
			);
		});
}

async function compensateCommittedPane(
	dependencies: CliHmuxCreateDependencies,
	created: CliHmuxCreatedSession,
	removePane: (() => boolean) | undefined,
): Promise<void> {
	try {
		removePane?.();
	} catch (cleanupError) {
		console.error(
			`[cli hmux.create] pane compensation failed for ${created.sessionId}: ${cleanupError}`,
		);
	}
	await abandonCreatedSession(dependencies, created);
}

/** Reuse the presentation transaction for the selected host. Local creation
 * confirms native attachment; remote creation confirms durable pane mount. */
export async function handleCliHmuxCreate(
	params: Record<string, unknown>,
	reqId: string,
	dependencies: CliHmuxCreateDependencies = defaultDependencies,
) {
	let claimed = false;
	const claim = async () => {
		if (claimed) return true;
		claimed = await dependencies.claim(reqId);
		return claimed;
	};

	try {
		const route = await dependencies.routeToSpaceOwner({ reqId, params });
		if (route.kind === "forwarded") return null;
		if (!(await claim())) return null;
		const desktopId = route.spaceId ?? dependencies.activeSpaceId();
		const api = dependencies.getDockview(desktopId);
		if (!dependencies.spaceExists(desktopId) || !api) {
			throw new PaneCommandError(
				"pane_not_found",
				`desktop ${desktopId} is not mounted`,
			);
		}
		const cwd = params.cwd ? String(params.cwd) : undefined;
		const placement = await dependencies.resolvePlacement(params);
		const paneDesktopId = placement?.desktopId ?? desktopId;
		if (
			params.hostId !== undefined &&
			(typeof params.hostId !== "string" || !params.hostId.trim())
		) {
			throw new PaneCommandError(
				"invalid_request",
				"hostId must be local or a registered SSH host ID",
			);
		}
		const hostId =
			typeof params.hostId === "string" ? params.hostId.trim() : "local";
		if (hostId !== "local") {
			// The GUI remote transaction owns registration, mount and compensation.
			// In particular, never substitute a local home for a remote default cwd.
			const pane = await dependencies.openRemote({
				api: placement?.api ?? api,
				desktopId: paneDesktopId,
				hostId,
				...(cwd !== undefined ? { cwd } : {}),
				...(placement ? { position: placement.position } : {}),
			});
			return {
				ok: true,
				pane: {
					...pane,
					spaceId: paneDesktopId,
					desktopId: paneDesktopId,
					hostId,
					runtime: "hmux_standalone_v1",
					source: "ssh",
					mode: "controller",
					sessionOwnership: "created_by_request",
					paneOwnership: "created_by_request",
				},
			};
		}
		const launchCwd = cwd ?? placement?.cwd ?? (await dependencies.homeDir());
		const created = await dependencies.createStandalone({
			operationId: reqId,
			cwd: launchCwd,
			columns: 120,
			rows: 30,
			terminalEnv: terminalEnvironmentParam(params.terminalEnv),
			terminalDefaultColors: dependencies.terminalDefaultColors(),
		});
		const paneApi = placement?.api ?? api;
		let presentation: PanePresentation;
		try {
			presentation = dependencies.openAndCommit(
				paneDesktopId,
				paneApi,
				created.sessionId,
				created.workspaceId,
				launchCwd,
				placement?.position,
			);
		} catch (presentationError) {
			await abandonCreatedSession(dependencies, created);
			throw presentationError;
		}
		const { panel, paneOwnership } = presentation;
		const panelId = panel.id;
		const removePane =
			paneOwnership === "created_by_request"
				? dependencies.preparePaneRemoval(paneDesktopId, paneApi, panel)
				: undefined;

		let attachment: HmuxPaneAttachmentStatus;
		try {
			attachment = await dependencies.waitForActivation({
				desktopId: paneDesktopId,
				panelId,
				sessionId: created.sessionId,
				workspaceId: created.workspaceId,
			});
		} catch (presentationError) {
			await compensateCommittedPane(dependencies, created, removePane);
			throw presentationError;
		}

		return {
			ok: true,
			pane: projectStandalonePaneReceipt(
				{
					desktopId: paneDesktopId,
					panelId,
					sessionId: created.sessionId,
					workspaceId: created.workspaceId,
					cwd: launchCwd,
					sessionOwnership: "created_by_request",
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
