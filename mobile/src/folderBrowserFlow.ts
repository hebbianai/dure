/** State and IPC wiring for Figma 3369:35182, 3372:85638, and 3372:85748. */

import {
	displayPath,
	type FolderBrowserHost,
	type FolderBrowserStage,
	folderName,
	type NewFolderDraft,
} from "./folderBrowser";
import { renderFolderBrowserScreen } from "./folderBrowserView";
import { t } from "./i18n";
import type { FolderBrowserOutcome, LaunchOffer } from "./ipc";
import {
	emptyForm,
	type LaunchForm,
	type LaunchPress,
	preselect,
} from "./launch";
import type { LaunchMenu, LaunchStage } from "./launchView";

export interface LaunchScreen {
	readonly kind: "launch";
	readonly hubId: string;
	readonly boxLabel: string;
	readonly stage: LaunchStage;
	readonly form: LaunchForm;
	readonly menu: LaunchMenu;
	readonly press?: LaunchPress;
}

export interface FolderBrowserScreen {
	readonly kind: "folder-browser";
	readonly hubId: string;
	readonly boxLabel: string;
	readonly hosts: readonly FolderBrowserHost[];
	readonly stage: FolderBrowserStage;
	readonly hostOpen: boolean;
	readonly create?: NewFolderDraft;
	readonly returnTo: LaunchScreen;
}

export interface FolderBrowserFlowPorts {
	readonly back?: (action: () => void, blocked?: boolean) => () => void;
	readonly browse: (
		hubId: string,
		path?: string,
	) => Promise<FolderBrowserOutcome>;
	readonly create: (
		hubId: string,
		parent: string,
		name: string,
	) => Promise<FolderBrowserOutcome>;
	readonly offer: (hubId: string) => Promise<LaunchOffer>;
	readonly show: (
		screen: LaunchScreen | FolderBrowserScreen,
		clearBanner?: boolean,
	) => void;
	readonly remember: (screen: FolderBrowserScreen) => void;
	readonly current: () => FolderBrowserScreen | undefined;
	readonly describeError: (error: unknown) => string;
}

export function createFolderBrowserFlow(ports: FolderBrowserFlowPorts) {
	let requestGeneration = 0;

	async function browse(
		screen: FolderBrowserScreen,
		path?: string,
	): Promise<void> {
		const generation = ++requestGeneration;
		const rootPath = screen.stage.rootPath;
		ports.show({
			...screen,
			hostOpen: false,
			create: undefined,
			stage: { kind: "loading", rootPath },
		});
		try {
			const result = await ports.browse(screen.hubId, path);
			if (!result.ok || !result.path) {
				throw new Error(result.detail ?? t("폴더를 열지 못했습니다"));
			}
			const current = ports.current();
			if (
				generation !== requestGeneration ||
				!current ||
				current.hubId !== screen.hubId
			)
				return;
			ports.show({
				...current,
				stage: {
					kind: "ready",
					rootPath: rootPath ?? result.path,
					path: result.path,
					entries: result.entries,
				},
			});
		} catch (error) {
			const current = ports.current();
			if (
				generation !== requestGeneration ||
				!current ||
				current.hubId !== screen.hubId
			)
				return;
			ports.show({
				...current,
				stage: {
					kind: "failed",
					message: ports.describeError(error),
					rootPath,
				},
			});
		}
	}

	function open(
		returnTo: LaunchScreen,
		hosts: readonly FolderBrowserHost[],
	): void {
		const screen: FolderBrowserScreen = {
			kind: "folder-browser",
			hubId: returnTo.hubId,
			boxLabel: returnTo.boxLabel,
			hosts,
			stage: { kind: "loading" },
			hostOpen: false,
			returnTo: { ...returnTo, menu: undefined },
		};
		ports.show(screen, true);
		void browse(screen);
	}

	async function selectHost(
		screen: FolderBrowserScreen,
		hubId: string,
	): Promise<void> {
		if (hubId === screen.hubId) {
			ports.show({ ...screen, hostOpen: false });
			return;
		}
		const host = screen.hosts.find((candidate) => candidate.id === hubId);
		if (!host) return;
		const generation = ++requestGeneration;
		ports.show({
			...screen,
			hubId,
			boxLabel: host.label,
			hostOpen: false,
			create: undefined,
			stage: { kind: "loading" },
		});
		try {
			const [offer, folders] = await Promise.all([
				ports.offer(hubId),
				ports.browse(hubId),
			]);
			if (!folders.ok || !folders.path) {
				throw new Error(folders.detail ?? t("폴더를 열지 못했습니다"));
			}
			const current = ports.current();
			if (
				generation !== requestGeneration ||
				!current ||
				current.hubId !== hubId
			)
				return;
			const previous = screen.returnTo.form;
			const selected = preselect(offer);
			ports.show({
				...current,
				stage: {
					kind: "ready",
					rootPath: folders.path,
					path: folders.path,
					entries: folders.entries,
				},
				returnTo: {
					kind: "launch",
					hubId,
					boxLabel: host.label,
					stage: { kind: "ready", offer },
					form: {
						...emptyForm(),
						useWorktree: previous.useWorktree,
						branch: previous.branch,
						...selected,
						kindId: previous.kindId ?? selected.kindId,
					},
					menu: undefined,
				},
			});
		} catch (error) {
			const current = ports.current();
			if (
				generation !== requestGeneration ||
				!current ||
				current.hubId !== hubId
			)
				return;
			ports.show({
				...current,
				stage: { kind: "failed", message: ports.describeError(error) },
			});
		}
	}

	async function create(screen: FolderBrowserScreen): Promise<void> {
		if (
			screen.stage.kind !== "ready" ||
			!screen.create?.name.trim() ||
			screen.create.busy
		) {
			return;
		}
		const name = screen.create.name.trim();
		const generation = ++requestGeneration;
		ports.show({
			...screen,
			create: { ...screen.create, name, busy: true, error: undefined },
		});
		try {
			const result = await ports.create(screen.hubId, screen.stage.path, name);
			if (!result.ok || !result.path) {
				throw new Error(result.detail ?? t("폴더를 만들지 못했습니다"));
			}
			const current = ports.current();
			if (
				generation !== requestGeneration ||
				!current ||
				current.hubId !== screen.hubId
			)
				return;
			ports.show({
				...current,
				create: undefined,
				stage: {
					kind: "ready",
					rootPath: screen.stage.rootPath,
					path: result.path,
					entries: result.entries,
				},
			});
		} catch (error) {
			const current = ports.current();
			if (
				generation !== requestGeneration ||
				!current ||
				current.hubId !== screen.hubId
			)
				return;
			ports.show({
				...current,
				create: { name, busy: false, error: ports.describeError(error) },
			});
		}
	}

	function render(screen: FolderBrowserScreen): HTMLElement {
		const actions = {
			close: () => ports.show(screen.returnTo),
			toggleHost: () => ports.show({ ...screen, hostOpen: !screen.hostOpen }),
			selectHost: (hubId) => void selectHost(screen, hubId),
			browse: (path) => void browse(screen, path),
			choose: (path) => {
				if (screen.stage.kind !== "ready") return;
				ports.show({
					...screen.returnTo,
					form: {
						...screen.returnTo.form,
						folderPath: path,
						folderLabel: folderName(path),
						folderHint: displayPath(screen.stage.rootPath, path),
					},
				});
			},
			openCreate: () =>
				ports.show({
					...screen,
					hostOpen: false,
					create: { name: "", busy: false },
				}),
			// Preserve the focused input node while typing; the view updates its
			// own submit state just like the launch branch field.
			editCreateName: (name) =>
				ports.remember({ ...screen, create: { name, busy: false } }),
			cancelCreate: () => ports.show({ ...screen, create: undefined }),
			createFolder: () => {
				const current = ports.current();
				if (current) void create(current);
			},
		} satisfies Parameters<typeof renderFolderBrowserScreen>[1];
		ports.back?.(
			screen.create
				? actions.cancelCreate
				: screen.hostOpen
					? actions.toggleHost
					: actions.close,
			screen.create?.busy,
		);
		return renderFolderBrowserScreen(screen, actions);
	}

	return { open, render };
}
