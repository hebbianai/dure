import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { nanoid } from "nanoid";
import { HMUX_LOCAL_SHELL_WORKSPACE_ID } from "@/lib/hmux/identity/hmuxProviderSessionSource";
import { t } from "@/lib/i18n";
import { hmux, homeDir } from "@/lib/ipc";
import { hmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import { currentTerminalDefaultColors } from "@/lib/theme/themePreference";
import { findTerminalPanel } from "@/lib/workspace/dock/dockPanelParameters";
import {
	registeredDesktopIdFor,
	waitForDesktopDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { commitExplicitDockviewMutation } from "@/lib/workspace/dock/explicitDockviewCommit";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";
import { addPanePreservingSizes } from "@/lib/workspace/pane/paneMutationSizing";
import {
	type PanelPosition,
	placementOptions,
} from "@/lib/workspace/pane/panePlacement";
import { useStore } from "@/store";
import type { HmuxManagedStopFenceV1, TerminalEnvironment } from "@/types";

export function openHmuxManagedTerminalOn(
	api: DockviewApi,
	sessionId: string,
	workspaceId: string,
	cwd: string,
	position?: PanelPosition,
	createIdempotencyKey?: string,
	stopFence?: HmuxManagedStopFenceV1,
): IDockviewPanel {
	const binding = hmuxManagedBinding(sessionId, workspaceId);
	const existing = findTerminalPanel(api, binding);
	if (existing) {
		existing.api.setActive();
		return existing;
	}
	const pos =
		position ?? (api.panels.length > 0 ? { direction: "right" } : undefined);
	return addPanePreservingSizes(api, {
		id: position?.replacement?.id ?? createPaneId(),
		component: "terminal",
		title: t("common.terminal"),
		params: {
			sessionId,
			cwd,
			binding: {
				...binding,
				...(createIdempotencyKey ? { createIdempotencyKey } : {}),
				...(stopFence ? { stopFence } : {}),
			},
		},
		...placementOptions(pos),
	});
}

/** Create the managed Host before exposing its pane. Failed presentation
 * compensates only a lifetime created by this exact attempt; an idempotently
 * reused Host is never destroyed. */
export async function createHmuxManagedShellTerminalOn(
	api: DockviewApi,
	cwd?: string,
	position?: PanelPosition,
	terminalEnv?: TerminalEnvironment,
	logicalDesktopId?: string,
	requestedSessionId: string = `term-${nanoid(8)}`,
) {
	const desktopId = logicalDesktopId ?? registeredDesktopIdFor(api);
	const launchCwd = cwd || (await homeDir());
	const idempotencyKey = `shell_${requestedSessionId}`;
	const created = await hmux.createManagedShell({
		idempotencyKey,
		sessionId: requestedSessionId,
		workspaceId: HMUX_LOCAL_SHELL_WORKSPACE_ID,
		cwd: launchCwd,
		columns: 120,
		rows: 30,
		terminalEnv,
		terminalDefaultColors: currentTerminalDefaultColors(),
	});
	let panel: IDockviewPanel;
	try {
		const stopFence = created.session.stopFence;
		if (
			created.idempotencyKey !== idempotencyKey ||
			created.session.sessionId !== requestedSessionId ||
			created.session.workspaceId !== HMUX_LOCAL_SHELL_WORKSPACE_ID ||
			created.session.sessionClass !== "managed" ||
			!stopFence
		) {
			throw new Error("managed Hmux shell create receipt identity mismatch");
		}
		useStore.getState().setHmuxSessionMetadata(created.session);
		const targetApi = desktopId ? await waitForDesktopDockview(desktopId) : api;
		if (!targetApi) {
			throw new PaneCommandError(
				"pane_changed",
				`desktop ${desktopId ?? "unknown"} was removed while its managed Hmux shell was being created`,
			);
		}
		if (desktopId) {
			panel = commitExplicitDockviewMutation({
				desktopId,
				api: targetApi,
				mutate: () =>
					openHmuxManagedTerminalOn(
						targetApi,
						created.session.sessionId,
						created.session.workspaceId,
						launchCwd,
						position,
						idempotencyKey,
						stopFence,
					),
				targetChangedError: () =>
					new PaneCommandError(
						"pane_changed",
						`desktop ${desktopId} changed before managed Hmux shell layout commit`,
					),
			});
		} else {
			panel = openHmuxManagedTerminalOn(
				targetApi,
				created.session.sessionId,
				created.session.workspaceId,
				launchCwd,
				position,
				idempotencyKey,
				stopFence,
			);
		}
	} catch (error) {
		if (created.outcome === "created") {
			await hmux
				.stopManagedCreateChain(
					idempotencyKey,
					requestedSessionId,
					HMUX_LOCAL_SHELL_WORKSPACE_ID,
				)
				.catch((cleanupError) => {
					console.error(
						`[hmux managed shell] lifetime cleanup failed for ${requestedSessionId}: ${cleanupError}`,
					);
				});
		}
		throw error;
	}
	return { ...created, panelId: panel.id };
}
