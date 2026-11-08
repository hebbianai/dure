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
import { HmuxPaneAttachmentTimeoutError } from "@/lib/hmux/hmuxPaneAttachment";
import {
	openRemoteHmuxTerminal,
	RemoteHmuxOpenError,
} from "@/lib/hmux/remote/remoteHmuxTerminalSession";
import {
	type HmuxPaneAttachmentStatus,
	type HmuxPaneDepartureReceipt,
	hmux,
	homeDir,
} from "@/lib/ipc";
import type { TerminalDefaultColors } from "@/lib/terminal/state/terminalDefaultColors";
import { terminalEnvironmentParam } from "@/lib/terminal/terminalEnvironmentParam";
import { currentTerminalDefaultColors } from "@/lib/theme/themePreference";
import { resolvePaneReference } from "@/lib/workspace/dock";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { openAndCommitHmuxStandaloneTerminalOn } from "@/lib/workspace/dock/standaloneShellTerminal";
import { preparePaneProjectionRemoval } from "@/lib/workspace/pane/paneCloseCoordinator";
import {
	PaneCommandError,
	spaceNotMountedError,
} from "@/lib/workspace/pane/paneCommandError";
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
	): Promise<HmuxPaneDepartureReceipt>;
	/** Whether this window's document is hidden (minimized or covered). */
	windowHidden(): boolean;
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
	windowHidden: () => document.visibilityState === "hidden",
};

/** What a failed local create left behind. Only a confirmed rollback makes a
 * new create safe; anything else must be inspected before creating again. */
type CreationRollback =
	| { readonly confirmed: true }
	| { readonly confirmed: false; readonly reason: string };

interface CreationRecovery {
	readonly retryable: boolean;
	readonly nextAction: string;
}

const ROLLED_BACK =
	"Nothing was kept: this request's pane and Hmux session were removed.";

function creationRecovery(
	rollback: CreationRollback,
	created: CliHmuxCreatedSession,
	hiddenActiveSpace: boolean,
): CreationRecovery {
	if (!rollback.confirmed) {
		return {
			retryable: false,
			nextAction:
				`Cleanup was not confirmed (${rollback.reason}): the pane or Hmux ` +
				`session ${created.sessionId} in workspace ${created.workspaceId} ` +
				"may remain. Inspect dure client observe --json before creating " +
				"another terminal.",
		};
	}
	return {
		retryable: true,
		// The active Space defers terminal attachment while its window is hidden
		// (VisibilityRetainedStructuredTerminal), so this create could not finish.
		nextAction: hiddenActiveSpace
			? `${ROLLED_BACK} The Dure window is hidden, and the active Space ` +
				"attaches a new terminal only while the window is visible. Show the " +
				"Dure window, then create the terminal again."
			: `${ROLLED_BACK} Creating the terminal again is safe.`,
	};
}

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
): Promise<CreationRollback> {
	try {
		const receipt = await dependencies.abandonUnpresentedCreation(
			created.sessionId,
			created.workspaceId,
		);
		// Only an armed retirement proves the Host is ending this exact launch.
		return receipt?.state === "retirement_armed"
			? { confirmed: true }
			: {
					confirmed: false,
					reason: receipt?.reason ?? receipt?.state ?? "session_cleanup_failed",
				};
	} catch (cleanupError) {
		console.error(
			`[cli hmux.create] safe unpresented-create compensation failed for ${created.sessionId}: ${cleanupError}`,
		);
		return { confirmed: false, reason: "session_cleanup_failed" };
	}
}

async function compensateCommittedPane(
	dependencies: CliHmuxCreateDependencies,
	created: CliHmuxCreatedSession,
	removePane: (() => boolean) | undefined,
): Promise<CreationRollback> {
	// A pre-existing pane is not this request's to remove, so it stays behind.
	let paneCleanup: string | undefined = removePane
		? undefined
		: "pane_preserved";
	try {
		if (removePane && !removePane()) paneCleanup = "pane_cleanup_failed";
	} catch (cleanupError) {
		paneCleanup = "pane_cleanup_failed";
		console.error(
			`[cli hmux.create] pane compensation failed for ${created.sessionId}: ${cleanupError}`,
		);
	}
	const session = await abandonCreatedSession(dependencies, created);
	return paneCleanup ? { confirmed: false, reason: paneCleanup } : session;
}

/** Reuse the presentation transaction for the selected host. Local creation
 * confirms native attachment; remote creation confirms durable pane mount. */
export async function handleCliHmuxCreate(
	params: Record<string, unknown>,
	reqId: string,
	dependencies: CliHmuxCreateDependencies = defaultDependencies,
) {
	let claimed = false;
	let recovery: CreationRecovery | undefined;
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
		if (!dependencies.spaceExists(desktopId)) {
			throw new PaneCommandError(
				"pane_not_found",
				`desktop ${desktopId} is not mounted`,
			);
		}
		if (!api) throw spaceNotMountedError(desktopId);
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
			recovery = creationRecovery(
				await abandonCreatedSession(dependencies, created),
				created,
				false,
			);
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
			const hiddenActiveSpace =
				presentationError instanceof HmuxPaneAttachmentTimeoutError &&
				paneDesktopId === dependencies.activeSpaceId() &&
				dependencies.windowHidden();
			recovery = creationRecovery(
				await compensateCommittedPane(dependencies, created, removePane),
				created,
				hiddenActiveSpace,
			);
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
		return { ok: false, error: { ...errorPayload(error), ...recovery } };
	}
}
