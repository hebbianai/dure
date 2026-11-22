import { Clock3, Cpu, Gauge, Shield, X } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import type { AgentLaunchControlsPresentation } from "@/components/agents/useAgentToolbarControls";
import { useProviderCatalog } from "@/components/agents/useProviderCatalog";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorText } from "@/components/ui/error-text";
import { IconButton } from "@/components/ui/icon-button";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import type { ToolbarControlReveal } from "@/components/ui/toolbar-control";
import { usePaneActions } from "@/components/workspace/usePaneActions";
import {
	type AgentLaunchSelectionSurface,
	agentLaunchSelectionCommandRunner,
	agentLaunchSelectionPresentation,
} from "@/lib/agents/agentLaunchSelectionSurface";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import { agentRuntimeSettingActions } from "@/lib/agents/agentRuntimeSettingActions";
import type { ProviderCatalogSource } from "@/lib/agents/providerModelCatalogSource";
import { permissionModeLabel } from "@/lib/agents/providerPermissions";
import {
	humanizeModelId,
	type ObservedProviderModelV1,
} from "@/lib/agents/providerModels";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Provider } from "@/types";

function SelectionPill({
	label,
	display,
	icon,
	tone,
	reveal,
	checkedValue,
	options,
	disabled,
	onSelect,
	open,
	onOpenChange,
	status,
}: {
	label: string;
	display: string;
	icon: ReactElement;
	tone?: "danger";
	reveal: ToolbarControlReveal;
	checkedValue: string | null;
	options: readonly {
		value: string | null;
		label: string;
		tone?: "danger";
	}[];
	disabled: boolean;
	onSelect: (next: string | null) => void;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	status?: string;
}) {
	return (
		<SelectField
			aria-label={label}
			title={display === label ? label : `${label}: ${display}`}
			value={checkedValue ?? ""}
			onValueChange={(next) => onSelect(next || null)}
			open={open}
			onOpenChange={onOpenChange}
			disabled={disabled}
			leadingIcon={icon}
			display={display}
			toolbar={{ label, reveal, tone }}
		>
			{status && (
				<p role="status" className="px-2 py-1 text-xs text-muted-foreground">
					{status}
				</p>
			)}
			{options.map((option) => (
				<SelectOption
					key={
						option.value === null
							? "selection:null"
							: `selection:${option.value}`
					}
					value={option.value ?? ""}
					className={option.tone === "danger" ? "text-destructive" : undefined}
				>
					{option.label}
				</SelectOption>
			))}
		</SelectField>
	);
}

interface AgentLaunchSelectionOwnerOptions {
	provider: Provider;
	/** The launch selection this surface owns; none offers no pills. */
	launch: AgentRuntimeLaunchSelectionView | undefined;
	observedModel?: string | null;
	catalog?: readonly ObservedProviderModelV1[] | null;
	catalogSource?: ProviderCatalogSource;
	busy: boolean;
}

/** The launch pills of the surface that owns an Agent's launch selection.
 * Its menus and its `settings.*` pane actions are composed from one provider
 * catalog, and selections derive their complete target from the controller's
 * action-time source snapshot, never from an unloaded pane projection. */
export function useAgentLaunchSelectionOwner({
	provider,
	launch,
	observedModel = null,
	catalog = null,
	catalogSource,
	busy,
}: AgentLaunchSelectionOwnerOptions): AgentLaunchSelectionSurface | undefined {
	const discovered = useProviderCatalog(catalogSource);
	const models = discovered.models ?? (discovered.error ? [] : (catalog ?? []));
	const settings = launch
		? agentRuntimeSettingActions({
				provider,
				launch,
				models,
				observedModel,
				busy,
				refreshCatalog: catalogSource ? discovered.refresh : undefined,
			})
		: undefined;
	usePaneActions(
		launch?.ownerKey,
		launch?.paneId && settings
			? { paneId: launch.paneId, actions: settings.actions }
			: undefined,
	);
	if (!launch || !settings) return undefined;
	return {
		presentation: agentLaunchSelectionPresentation({
			launch,
			settings,
			observedModel,
			catalog: {
				offered: catalogSource !== undefined,
				status: discovered.loading
					? "loading"
					: discovered.error
						? "failed"
						: "idle",
			},
		}),
		run: agentLaunchSelectionCommandRunner(settings, launch),
	};
}

/** One provider-neutral launch-selection surface shared by Chat and Terminal,
 * for the surface that owns the launch selection. */
export function AgentLaunchSelectionControls({
	busy,
	className,
	presentation,
	modelPickerRequest,
	...owner
}: Omit<AgentLaunchSelectionOwnerOptions, "launch"> & {
	launch: AgentRuntimeLaunchSelectionView;
	className?: string;
	/** Interface-mode / hidden-control gating resolved by the caller through
	 * useAgentLaunchControlsPresentation — this component stays store-free. */
	presentation?: AgentLaunchControlsPresentation;
	/** Each increment opens the model menu, as `/model` in the composer asks. */
	modelPickerRequest?: number;
}): ReactElement | null {
	const surface = useAgentLaunchSelectionOwner({ ...owner, busy });
	if (!surface) return null;
	return (
		<AgentLaunchSelectionSurfaceControls
			surface={surface}
			busy={busy}
			className={className}
			presentation={presentation}
			modelPickerRequest={modelPickerRequest}
		/>
	);
}

/** Renders launch pills from a surface's presentation, wherever its commands
 * run: in this window for the owner, or in the source pane's window for an
 * Agent's large window. */
export function AgentLaunchSelectionSurfaceControls({
	surface: { presentation: launch, run },
	busy,
	className,
	presentation,
	modelPickerRequest = 0,
}: {
	surface: AgentLaunchSelectionSurface;
	busy: boolean;
	className?: string;
	presentation?: AgentLaunchControlsPresentation;
	modelPickerRequest?: number;
}): ReactElement {
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const handledModelPickerRequest = useRef(modelPickerRequest);
	const runRef = useRef(run);
	runRef.current = run;
	useEffect(() => {
		if (modelPickerRequest === handledModelPickerRequest.current) return;
		handledModelPickerRequest.current = modelPickerRequest;
		setModelMenuOpen(true);
		void runRef.current({ kind: "load_catalog" });
	}, [modelPickerRequest]);
	useEffect(() => {
		if (busy) setModelMenuOpen(false);
	}, [busy]);
	const loadCatalogOnOpen = (open: boolean) => {
		if (open) void run({ kind: "load_catalog" });
	};
	const catalogStatus =
		launch.catalog.status === "loading"
			? t("common.loading")
			: launch.catalog.status === "failed"
				? t("agents.catalog.loadFailed")
				: undefined;
	const pill = (
		id: "launch-model" | "launch-effort" | "launch-permissions",
		node: ReactElement,
	) =>
		presentation === undefined
			? node
			: presentation.hidden.has(id)
				? null
				: presentation.slot(id, node);
	const { modelOptions, effortOptions, permissionOptions, observedModel } =
		launch;
	const selectableModelOptions = [
		{ value: null, label: t("agents.quickDispatch.autoModel") },
		...modelOptions,
	];
	const selectableEffortOptions = [
		{ value: null, label: t("agents.quickDispatch.autoEffort") },
		...effortOptions,
	];
	const selection = launch.pending
		? { ...launch.pending.selection, loaded: true }
		: launch;

	const selectedModel = modelOptions.find(
		(option) => option.value === selection.model,
	);
	const selectedEffort = effortOptions.find(
		(option) => option.value === selection.effort,
	);
	return (
		<div className={cn("flex min-w-0 items-center gap-0.5", className)}>
			{launch.hydrationError && (
				<div className="flex min-w-0 items-center gap-1">
					<ErrorText className="min-w-0 truncate">
						{t("agents.runtime.launchSelectionUnavailable")}
					</ErrorText>
					<Button
						type="button"
						size="xs"
						variant="ghost"
						disabled={busy}
						onClick={() => void run({ kind: "retry_hydration" })}
					>
						{t("common.retry")}
					</Button>
				</div>
			)}
			{launch.error && (
				<div className="flex min-w-0 items-center gap-0.5">
					<ErrorText className="max-w-40 truncate" title={launch.error}>
						{launch.errorMessage ?? t("agents.runtime.switchFailed")}
					</ErrorText>
					<IconButton
						title={t("common.close")}
						showTooltip={false}
						className="size-5 shrink-0 text-destructive/70 hover:text-destructive"
						onClick={() => void run({ kind: "dismiss_error" })}
					>
						<X aria-hidden="true" />
					</IconButton>
				</div>
			)}
			{launch.pending && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<IconButton
							title={t("agents.runtime.settingsPending")}
							className={
								launch.pending.error ? "text-destructive" : "text-amber-500"
							}
						>
							<Clock3 aria-hidden="true" />
						</IconButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent className="w-max max-w-80">
						<DropdownMenuLabel>
							{t("agents.runtime.settingsPending")}
						</DropdownMenuLabel>
						<p className="px-2 py-1 text-xs text-muted-foreground">
							{t("agents.runtime.discardSourceDescription")}
						</p>
						{launch.pending.error && (
							<ErrorText className="px-2 py-1" title={launch.pending.error}>
								{t("agents.runtime.pendingSettingsFailed")}
							</ErrorText>
						)}
						<DropdownMenuItem
							disabled={busy}
							onSelect={() => {
								void run({ kind: "apply_pending" });
							}}
						>
							{t("agents.runtime.applySettingsNow")}
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={busy}
							onSelect={() => {
								void run({ kind: "cancel_pending" });
							}}
						>
							{t("agents.runtime.cancelPendingSettings")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
			{(modelOptions.length > 0 ||
				launch.catalog.offered ||
				selection.model !== null ||
				observedModel !== null) &&
				pill(
					"launch-model",
					<SelectionPill
						icon={<Cpu aria-hidden="true" className="size-3.5 shrink-0" />}
						reveal={0}
						label={t("agents.chat.modelLabel")}
						display={
							selection.loaded
								? (selectedModel?.label ??
									(selection.model !== null
										? humanizeModelId(selection.model)
										: observedModel !== null
											? humanizeModelId(observedModel)
											: t("agents.quickDispatch.autoModel")))
								: observedModel !== null
									? humanizeModelId(observedModel)
									: // Until anything is known the pill reads as its
										// label; a bare dash is not a menu.
										t("agents.chat.modelLabel")
						}
						checkedValue={selection.loaded ? selection.model : null}
						options={selectableModelOptions}
						open={modelMenuOpen}
						onOpenChange={(open) => {
							setModelMenuOpen(open);
							loadCatalogOnOpen(open);
						}}
						status={
							launch.pending
								? t("agents.runtime.settingsPending")
								: catalogStatus
						}
						disabled={busy}
						onSelect={(value) => {
							void run({ kind: "select", field: "model", value });
						}}
					/>,
				)}
			{(effortOptions.length > 0 ||
				selection.effort !== null ||
				launch.catalog.offered) &&
				pill(
					"launch-effort",
					<SelectionPill
						icon={<Gauge aria-hidden="true" className="size-3.5 shrink-0" />}
						reveal={1}
						label={t("agents.chat.effortLabel")}
						display={
							selection.loaded
								? (selectedEffort?.label ??
									selection.effort ??
									t("agents.quickDispatch.autoEffort"))
								: t("agents.chat.effortLabel")
						}
						checkedValue={selection.loaded ? selection.effort : null}
						options={selectableEffortOptions}
						onOpenChange={loadCatalogOnOpen}
						status={
							launch.pending
								? t("agents.runtime.settingsPending")
								: catalogStatus
						}
						disabled={busy}
						onSelect={(value) => {
							void run({ kind: "select", field: "effort", value });
						}}
					/>,
				)}
			{pill(
				"launch-permissions",
				<SelectionPill
					icon={<Shield aria-hidden="true" className="size-3.5 shrink-0" />}
					reveal={2}
					label={t("agents.chat.permissionLabel")}
					display={
						!selection.loaded
							? t("agents.chat.permissionLabel")
							: permissionModeLabel(selection.permissionMode)
					}
					tone={
						selection.loaded && selection.permissionMode === "skip_permissions"
							? "danger"
							: undefined
					}
					checkedValue={selection.loaded ? selection.permissionMode : null}
					options={permissionOptions}
					status={
						launch.pending ? t("agents.runtime.settingsPending") : undefined
					}
					disabled={busy || permissionOptions.length === 0}
					onSelect={(value) => {
						void run({ kind: "select", field: "permissionMode", value });
					}}
				/>,
			)}
		</div>
	);
}
