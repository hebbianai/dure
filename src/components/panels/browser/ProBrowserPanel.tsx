import type { IDockviewPanelProps } from "dockview-react";
import {
	ArrowLeft,
	ArrowRight,
	Crosshair,
	Plus,
	Settings2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserElementPicker } from "@/components/panels/browser/BrowserElementPicker";
import { BrowserPageSurface } from "@/components/panels/browser/BrowserPageSurface";
import { BrowserProfileDialog } from "@/components/panels/browser/BrowserProfileDialog";
import { useProBrowserPane } from "@/components/panels/browser/useProBrowserPane";
import { Button, ConfirmationButton } from "@/components/ui/button";
import { ErrorText } from "@/components/ui/error-text";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { usePaneActions } from "@/components/workspace/usePaneActions";
import { normalizeBrowserAddress } from "@/lib/browser/browserAddress";
import { browserPaneActions } from "@/lib/browser/browserPaneActions";
import { acceptRemoteCapture } from "@/lib/design/designModeRuntime";
import { normalizeSlashPath, pathBasename } from "@/lib/files/paths";
import { t } from "@/lib/i18n";
import { browserRequestFailureMessage } from "@/lib/ipc/dureBrowser";
import { applyAutomaticPaneTitle } from "@/lib/workspace/pane/paneTitleOverrideStore";

export function ProBrowserPanel(
	props: IDockviewPanelProps<{
		url: string;
		browserBinding?: unknown;
		browserCreation?: unknown;
	}>,
) {
	const pane = useProBrowserPane(props);
	const workspaceOptions = useMemo(() => {
		const counts = new Map<string, number>();
		for (const workspace of pane.workspaces)
			counts.set(
				workspace.root_path,
				(counts.get(workspace.root_path) ?? 0) + 1,
			);
		return pane.workspaces.map((workspace) => {
			const folder = pathBasename(normalizeSlashPath(workspace.root_path));
			const label =
				folder === workspace.project_name
					? folder
					: `${folder} · ${workspace.project_name}`;
			return (
				<SelectOption
					key={workspace.workspace_id}
					value={workspace.workspace_id}
					textValue={label}
					title={workspace.root_path}
					description={
						<span className="break-all">
							{workspace.root_path}
							{(counts.get(workspace.root_path) ?? 0) > 1 && (
								<span className="block">{workspace.workspace_id}</span>
							)}
						</span>
					}
				>
					<span className="min-w-0 truncate">{label}</span>
				</SelectOption>
			);
		});
	}, [pane.workspaces]);
	const selectWorkspaceBrowser = pane.useForWorkspace;
	const [address, setAddress] = useState(
		props.params.url === "about:blank" ? "" : props.params.url || "",
	);
	const [optionsOpen, setOptionsOpen] = useState(false);
	const [navigation, setNavigation] = useState<{ url: string }>();
	const navigate = useCallback(
		async (url: string) => {
			const intent = { url };
			setNavigation(intent);
			setAddress(url);
			try {
				await pane.navigate(url);
			} finally {
				setNavigation((pending) => (pending === intent ? undefined : pending));
			}
		},
		[pane.navigate],
	);
	const initialAddress = useRef(
		!props.params.browserBinding && !props.params.browserCreation
			? props.params.url
			: undefined,
	);
	const [returnTo, setReturnTo] = useState<string>();
	const [closeTarget, setCloseTarget] = useState<typeof pane.session>();
	const editing = useRef(false);
	const pickerTrigger = useRef<HTMLButtonElement>(null);
	const [picking, setPicking] = useState<string>();
	const captureScope = JSON.stringify([
		pane.session?.resource,
		pane.view.page,
		pane.view.control?.controller,
	]);
	const current = pane.view.observation?.pages.find(
		(row) => row.page.page_id === pane.view.page?.page_id,
	);
	const control = pane.view.control;
	const owned = control?.controller?.controller_id === pane.controllerId;
	const enabled =
		owned &&
		!!pane.view.page &&
		control?.phase === "ready" &&
		!control.requested_controller &&
		pane.active &&
		!pane.busy &&
		!pane.error;
	useEffect(() => {
		if (current && !navigation) {
			if (!editing.current) setAddress(current.url);
			applyAutomaticPaneTitle(props.api, current.title || current.url);
		}
	}, [current?.url, current?.title, props.api, navigation]);
	const canNavigate =
		pane.active &&
		!pane.busy &&
		pane.connected &&
		(pane.session ? enabled : true);
	useEffect(() => {
		const url = initialAddress.current;
		if (!url || url === "about:blank" || !canNavigate) return;
		initialAddress.current = undefined;
		void navigate(normalizeBrowserAddress(url));
	}, [canNavigate, navigate]);
	useEffect(() => {
		const requested = (event: Event) => {
			const url = normalizeBrowserAddress(
				(event as CustomEvent<string>).detail,
			);
			setAddress(url);
			if (canNavigate) void navigate(url);
		};
		window.addEventListener(`browser-navigate:${props.api.id}`, requested);
		return () =>
			window.removeEventListener(`browser-navigate:${props.api.id}`, requested);
	}, [canNavigate, props.api.id, navigate]);
	const action = (kind: "back" | "forward" | "reload" | "new_page") => {
		if (!pane.session) return;
		void pane.run(() =>
			pane.session!.input(
				kind === "new_page" ? { kind, url: "about:blank" } : { kind },
			),
		);
	};
	useEffect(() => {
		if (!enabled || picking !== captureScope) setPicking(undefined);
	}, [captureScope, enabled, picking]);
	const failure = pane.error || pane.view.error;
	const { entry, takeControl } = browserPaneActions({
		paneId: props.api.id,
		session: pane.session,
		view: pane.view,
		busy: pane.busy,
		take: async (expected) => {
			setReturnTo(expected?.controller_id);
			await pane.handoff(pane.controllerId, expected);
		},
	});
	usePaneActions(
		JSON.stringify([props.api.id, pane.session?.resource, pane.controllerId]),
		entry,
	);
	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
				<IconButton
					title={t("common.back")}
					disabled={!enabled}
					onClick={() => action("back")}
				>
					<ArrowLeft className="size-3.5" />
				</IconButton>
				<IconButton
					title={t("panels.browser.forward")}
					disabled={!enabled}
					onClick={() => action("forward")}
				>
					<ArrowRight className="size-3.5" />
				</IconButton>
				<RefreshButton
					title={t(
						!pane.session || failure
							? "panels.browser.reconnect"
							: "common.refresh",
					)}
					disabled={!pane.session || failure ? pane.busy : !enabled}
					onClick={() =>
						!pane.session || failure ? pane.reconnect() : action("reload")
					}
					iconClassName="size-3.5"
				/>
				<Input
					className="h-7"
					aria-label={t("panels.browser.address")}
					value={address}
					placeholder="https://"
					spellCheck={false}
					onChange={(event) => {
						editing.current = true;
						setAddress(event.target.value);
					}}
					onBlur={() => {
						editing.current = false;
						if (navigation) setAddress(navigation.url);
						else if (current) setAddress(current.url);
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape" && current) {
							setAddress(navigation?.url ?? current.url);
							event.currentTarget.blur();
						}
						if (event.key === "Enter" && canNavigate) {
							initialAddress.current = undefined;
							editing.current = false;
							void navigate(normalizeBrowserAddress(address));
						}
					}}
				/>
				<IconButton
					title={t("panels.browser.pickElement")}
					disabled={!enabled || !pane.view.frame}
					ref={pickerTrigger}
					pressed={picking === captureScope}
					onClick={() =>
						setPicking(picking === captureScope ? undefined : captureScope)
					}
				>
					<Crosshair className="size-3.5" />
				</IconButton>
				<IconButton
					title={t("panels.browser.closeBrowser")}
					disabled={pane.busy || !pane.session}
					onClick={() => setCloseTarget(pane.session)}
				>
					<X className="size-3.5" />
				</IconButton>
				<IconButton
					title={t("panels.browser.options")}
					pressed={optionsOpen}
					onClick={() => setOptionsOpen(!optionsOpen)}
				>
					<Settings2 className="size-3.5" />
				</IconButton>
			</div>
			{optionsOpen && (
				<div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1">
					<div className="min-w-28 flex-1">
						<SelectField
							aria-label={t("panels.browser.workspace")}
							value={pane.workspaceId}
							contentClassName="w-max min-w-64 max-w-[min(32rem,var(--radix-select-content-available-width))] max-h-[min(24rem,var(--radix-select-content-available-height))]"
							disabled={pane.busy}
							onValueChange={(nextValue) =>
								void pane.selectWorkspace(nextValue)
							}
						>
							<SelectOption value="">
								{t("panels.browser.chooseWorkspace")}
							</SelectOption>
							{workspaceOptions}
						</SelectField>
					</div>
					{pane.next && (
						<Button
							size="sm"
							variant="ghost"
							onClick={() => void pane.loadMore()}
						>
							{t("panels.browser.moreWorkspaces")}
						</Button>
					)}
					<div className="min-w-24 flex-1">
						<SelectField
							aria-label={t("panels.browser.resource")}
							value={pane.session?.resource.resource_id ?? ""}
							disabled={pane.busy || !pane.workspaceId}
							onValueChange={(nextValue) => pane.attach(nextValue)}
						>
							<SelectOption value="">
								{t("panels.browser.chooseBrowser")}
							</SelectOption>
							{pane.resources.map((resource, index) => (
								<SelectOption
									key={resource.resource.resource_id}
									value={resource.resource.resource_id}
								>
									{t("panels.browser.browserNumber", { number: index + 1 })}
								</SelectOption>
							))}
						</SelectField>
					</div>
					<IconButton
						title={t("panels.browser.newBrowser")}
						disabled={pane.busy || !pane.connected}
						onClick={() => void pane.create()}
					>
						<Plus className="size-3.5" />
					</IconButton>
					<Button
						size="sm"
						variant="ghost"
						disabled={pane.busy || !pane.session || !pane.active}
						onClick={() => void selectWorkspaceBrowser()}
					>
						{t("panels.browser.useForWorkspace")}
					</Button>
				</div>
			)}
			{pane.session && (
				<div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1">
					<div className="min-w-24 flex-1">
						<SelectField
							aria-label={t("panels.browser.page")}
							value={
								pane.view.followingCurrent
									? ""
									: (pane.view.selectedPageId ?? "")
							}
							disabled={pane.busy}
							onValueChange={(nextValue) => pane.selectPage(nextValue)}
						>
							<SelectOption value="">
								{t("panels.browser.followCurrent")}
							</SelectOption>
							{pane.view.selectedPageId && !current && (
								<SelectOption value={pane.view.selectedPageId}>
									{t("common.loading")}
								</SelectOption>
							)}
							{pane.view.observation?.pages.map((row) => (
								<SelectOption key={row.page.page_id} value={row.page.page_id}>
									{row.title || row.url}
								</SelectOption>
							))}
						</SelectField>
					</div>
					<IconButton
						title={t("panels.browser.newPage")}
						disabled={!enabled}
						onClick={() => action("new_page")}
					>
						<Plus className="size-3.5" />
					</IconButton>
					<BrowserProfileDialog
						key={captureScope}
						session={pane.session}
						view={pane.view}
						onProfileDeleted={pane.refreshAfterProfileDeletion}
						enabled={enabled}
					/>
					<span className="text-xs text-muted-foreground" aria-live="polite">
						{t(
							control?.requested_controller
								? "panels.browser.controlPending"
								: owned
									? "panels.browser.youControl"
									: "panels.browser.otherControl",
						)}
					</span>
					{!owned ? (
						<Button
							size="sm"
							variant="outline"
							disabled={!!takeControl.definition.unavailable}
							onClick={() => void takeControl(takeControl.definition.current)}
						>
							{t("panels.browser.takeControl")}
						</Button>
					) : (
						returnTo && (
							<Button
								size="sm"
								variant="outline"
								disabled={pane.busy || !!control?.requested_controller}
								onClick={() => void pane.handoff(returnTo)}
							>
								{t("panels.browser.returnControl")}
							</Button>
						)
					)}
				</div>
			)}
			{failure && (
				<div className="border-b px-3 py-2">
					<ErrorText>{browserRequestFailureMessage(failure)}</ErrorText>
				</div>
			)}
			{closeTarget && closeTarget === pane.session && (
				<div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs">
					<span className="flex-1">
						{t("panels.browser.closeConfirmation")}
					</span>
					<ConfirmationButton
						variant="glass"
						onClick={() => setCloseTarget(undefined)}
					>
						{t("common.cancel")}
					</ConfirmationButton>
					<ConfirmationButton
						variant="destructive"
						onClick={() => {
							setCloseTarget(undefined);
							void pane.close();
						}}
					>
						{t("panels.browser.closeBrowser")}
					</ConfirmationButton>
				</div>
			)}
			{pane.session ? (
				<BrowserPageSurface
					session={pane.session}
					view={pane.view}
					enabled={enabled}
					paneId={props.api.id}
				>
					{enabled && picking === captureScope && pane.view.frame && (
						<BrowserElementPicker
							key={captureScope}
							session={pane.session}
							frame={pane.view.frame.capture}
							onClose={() => {
								setPicking(undefined);
								pickerTrigger.current?.focus();
							}}
							onCapture={(captured) => {
								setPicking(undefined);
								acceptRemoteCapture(captured.captured, "send", captured);
							}}
						/>
					)}
				</BrowserPageSurface>
			) : (
				!failure && (
					<div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
						{t(pane.busy ? "common.loading" : "panels.browser.enterAddress")}
					</div>
				)
			)}
		</div>
	);
}
