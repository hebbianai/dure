import type { DockviewApi } from "dockview-react";
import { nanoid } from "nanoid";
import { t } from "@/lib/i18n";
import { backendSupports, hmux, homeDir } from "@/lib/ipc";
import { BACKEND_FEATURES } from "@/lib/platform/backendCompatibility";
import {
	hmuxStandaloneBinding,
	hmuxStandalonePaneParams,
} from "@/lib/terminal/terminalBinding";
import { currentTerminalDefaultColors } from "@/lib/theme/themePreference";
import {
	type DesktopPlatform,
	detectDesktopPlatform,
} from "@/lib/workspace/desktop/desktopPlatform";
import {
	dockPanelParameters,
	findTerminalPanel,
} from "@/lib/workspace/dock/dockPanelParameters";
import {
	registeredDesktopIdFor,
	waitForDesktopDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { commitExplicitDockviewMutation } from "@/lib/workspace/dock/explicitDockviewCommit";
import { autoSplitPosition } from "@/lib/workspace/dock/gridPanePlacement";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";
import { addPanePreservingSizes } from "@/lib/workspace/pane/paneMutationSizing";
import {
	type PanelPosition,
	type PanePresentation,
	placementOptions,
} from "@/lib/workspace/pane/panePlacement";
import { useStore } from "@/store";
import type { TerminalEnvironment } from "@/types";

/** Presentation extras for a standalone pane beyond the plain shell:
 * an explicit tab title and the one-shot command-pane close policy. */
export interface StandalonePaneExtras {
	readonly title?: string;
	readonly closeOnSuccess?: boolean;
}

function utf16LeBase64(value: string): string {
	let bytes = "";
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		bytes += String.fromCharCode(codeUnit & 0xff, codeUnit >>> 8);
	}
	return btoa(bytes);
}

function powershellSingleQuote(value: string): string {
	return `'${value.split("'").join("''")}'`;
}

/** Old Windows Hosts create an interactive `cmd /K` session. Encode the
 * complete one-shot command so that outer shell cannot reinterpret its carets,
 * quotes, or pipes, then close that shell with the exact inner exit status. */
export function legacyStandaloneCommandInput(
	commandLine: string,
	platform: DesktopPlatform,
): string {
	if (platform !== "windows") return commandLine;
	const bridge = [
		`$commandLine = ${powershellSingleQuote(commandLine)};`,
		"& $env:ComSpec /D /Q /C $commandLine;",
		"exit $LASTEXITCODE",
	].join(" ");
	return `powershell.exe -NoProfile -EncodedCommand ${utf16LeBase64(bridge)} & call exit /B %%errorlevel%%`;
}

export function openHmuxStandaloneTerminalOn(
	api: DockviewApi,
	sessionId: string,
	workspaceId: string,
	cwd?: string,
	position?: PanelPosition,
	extras?: StandalonePaneExtras,
): PanePresentation {
	const binding = hmuxStandaloneBinding(sessionId, workspaceId);
	const existing = findTerminalPanel(api, binding);
	if (existing) {
		existing.api.updateParameters(
			hmuxStandalonePaneParams(
				dockPanelParameters(existing),
				sessionId,
				workspaceId,
				cwd,
			),
		);
		existing.api.setActive();
		return { panel: existing, paneOwnership: "pre_existing" };
	}
	const panel = addPanePreservingSizes(api, {
		id: position?.replacement?.id ?? createPaneId(),
		component: "terminal",
		title: extras?.title ?? t("common.terminal"),
		params: {
			sessionId,
			cwd,
			binding,
			...(extras?.closeOnSuccess ? { closeOnSuccess: true } : {}),
		},
		...placementOptions(position ?? autoSplitPosition(api)),
	});
	return {
		panel,
		paneOwnership:
			position && "replacement" in position
				? "pre_existing"
				: "created_by_request",
	};
}

/** A correlated app-server request is dispatched to one exact WebView. Commit
 * that explicit mutation synchronously so a background window does not depend
 * on Workspace's focused-writer debounce. Generic UI opens keep using the
 * focused Workspace writer path. */
export function openAndCommitHmuxStandaloneTerminalOn(
	desktopId: string,
	api: DockviewApi,
	sessionId: string,
	workspaceId: string,
	cwd?: string,
	position?: PanelPosition,
	extras?: StandalonePaneExtras,
): PanePresentation {
	return commitExplicitDockviewMutation({
		desktopId,
		api,
		mutate: () =>
			openHmuxStandaloneTerminalOn(
				api,
				sessionId,
				workspaceId,
				cwd,
				position,
				extras,
			),
		targetChangedError: () =>
			new PaneCommandError(
				"pane_changed",
				`desktop ${desktopId} changed before layout commit`,
			),
	});
}

/** Create the standalone Host session first, then expose its pane; a failed
 * presentation compensates only the lifetime this exact attempt created.
 * `commandLine` runs a one-shot command through the user's login shell
 * instead of the interactive shell (command panes: login, setup, usage). */
export async function createHmuxStandaloneTerminalOn(
	api: DockviewApi,
	cwd?: string,
	position?: PanelPosition,
	terminalEnv?: TerminalEnvironment,
	logicalDesktopId?: string,
	options?: StandalonePaneExtras & {
		readonly commandLine?: string;
		readonly operationId?: string;
	},
) {
	const operationId = options?.operationId ?? `terminal-${nanoid()}`;
	// Dockview's first StrictMode instance may be replaced while native Host
	// creation is in flight. Remember its logical desktop before awaiting, then
	// commit only to the currently registered instance for that same desktop.
	const desktopId = logicalDesktopId ?? registeredDesktopIdFor(api);
	const launchCwd = cwd || (await homeDir());
	const commandLine = options?.commandLine;
	const hostRunsCommand = commandLine
		? await backendSupports(BACKEND_FEATURES.hmuxStandaloneCommand).catch(
				() => false,
			)
		: false;
	const created = await hmux.createStandalone({
		operationId,
		cwd: launchCwd,
		columns: 120,
		rows: 30,
		terminalEnv,
		...(hostRunsCommand && commandLine ? { commandLine } : {}),
		terminalDefaultColors: currentTerminalDefaultColors(),
	});
	useStore.getState().setHmuxSessionMetadata(created);
	let presentation: PanePresentation;
	try {
		// Builds before hmux.standalone-command-v1 ignore commandLine and open an
		// interactive shell. Deliver the exact one-shot command before exposing
		// its pane so version skew cannot leave a blank, idle installer terminal.
		if (commandLine && !hostRunsCommand) {
			await hmux.commandInput({
				sessionId: created.sessionId,
				workspaceId: created.workspaceId,
				text: legacyStandaloneCommandInput(
					commandLine,
					detectDesktopPlatform(),
				),
				submit: true,
			});
		}
		const targetApi = desktopId ? await waitForDesktopDockview(desktopId) : api;
		if (!targetApi) {
			throw new PaneCommandError(
				"pane_changed",
				`desktop ${desktopId ?? "unknown"} was removed while its Hmux terminal was being created`,
			);
		}
		if (desktopId) {
			presentation = openAndCommitHmuxStandaloneTerminalOn(
				desktopId,
				targetApi,
				created.sessionId,
				created.workspaceId,
				launchCwd,
				position,
				options,
			);
		} else {
			presentation = openHmuxStandaloneTerminalOn(
				targetApi,
				created.sessionId,
				created.workspaceId,
				launchCwd,
				position,
				options,
			);
		}
	} catch (error) {
		await hmux
			.abandonUnpresentedCreation(created.sessionId, created.workspaceId)
			.catch((cleanupError) => {
				console.error(
					`[hmux create] safe unpresented-create compensation failed for ${created.sessionId}: ${cleanupError}`,
				);
			});
		throw error;
	}
	return {
		...created,
		panelId: presentation.panel.id,
		paneOwnership: presentation.paneOwnership,
	};
}
