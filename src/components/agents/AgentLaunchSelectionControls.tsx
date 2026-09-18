import { Clock3, Cpu, Gauge, Shield, X } from "lucide-react";
import type { ReactElement } from "react";
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
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import { agentRuntimeSettingActions } from "@/lib/agents/agentRuntimeSettingActions";
import type { ProviderCatalogSource } from "@/lib/agents/providerModelCatalogSource";
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
	onOpenChange?: (open: boolean) => void;
	status?: string;
}) {
	return (
		<SelectField
			aria-label={label}
			title={display === label ? label : `${label}: ${display}`}
			value={checkedValue ?? ""}
			onValueChange={(next) => onSelect(next || null)}
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

/** One provider-neutral launch-selection surface shared by Chat and Terminal.
 * Selection callbacks derive their complete target from the controller's
 * action-time source snapshot, never from an unloaded pane projection. */
export function AgentLaunchSelectionControls({
	provider,
	launch,
	observedModel = null,
	catalog = null,
	catalogSource,
	busy,
	className,
	presentation,
}: {
	provider: Provider;
	launch: AgentRuntimeLaunchSelectionView;
	observedModel?: string | null;
	catalog?: readonly ObservedProviderModelV1[] | null;
	catalogSource?: ProviderCatalogSource;
	busy: boolean;
	className?: string;
	/** Interface-mode / hidden-control gating resolved by the caller through
	 * useAgentLaunchControlsPresentation — this component stays store-free. */
	presentation?: AgentLaunchControlsPresentation;
}): ReactElement | null {
	const discovered = useProviderCatalog(catalogSource);
	const models = discovered.models ?? (discovered.error ? [] : (catalog ?? []));
	const catalogStatus = discovered.loading
		? t("common.loading")
		: discovered.error
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
	const { actions, modelOptions, permissionOptions, effortOptions } =
		agentRuntimeSettingActions({
			provider,
			launch,
			models,
			observedModel,
			busy,
			refreshCatalog: catalogSource ? discovered.refresh : undefined,
		});
	usePaneActions(
		launch.ownerKey,
		launch.paneId ? { paneId: launch.paneId, actions } : undefined,
	);
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
						onClick={launch.retryHydration}
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
						onClick={launch.dismissError}
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
						{launch.pending.error && (
							<ErrorText className="px-2 py-1" title={launch.pending.error}>
								{t("agents.runtime.pendingSettingsFailed")}
							</ErrorText>
						)}
						<DropdownMenuItem
							disabled={busy}
							onSelect={() => {
								void actions["settings.applyPending"]();
							}}
						>
							{t("agents.runtime.applySettingsNow")}
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={busy}
							onSelect={() => {
								void actions["settings.cancelPending"]();
							}}
						>
							{t("agents.runtime.cancelPendingSettings")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
			{(modelOptions.length > 0 ||
				catalogSource !== undefined ||
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
						onOpenChange={discovered.onOpenChange}
						status={
							launch.pending
								? t("agents.runtime.settingsPending")
								: catalogStatus
						}
						disabled={busy}
						onSelect={(value) => {
							void actions["settings.model"]({ value });
						}}
					/>,
				)}
			{(effortOptions.length > 0 ||
				selection.effort !== null ||
				catalogSource !== undefined) &&
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
						onOpenChange={discovered.onOpenChange}
						status={
							launch.pending
								? t("agents.runtime.settingsPending")
								: catalogStatus
						}
						disabled={busy}
						onSelect={(value) => {
							void actions["settings.effort"]({ value });
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
							: selection.permissionMode === "skip_permissions"
								? t("agents.chat.permissionSkip")
								: selection.permissionMode === "auto_edit"
									? t("agents.chat.permissionAutoEdit")
									: t("agents.chat.permissionDefault")
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
						void actions["settings.permission"]({ value });
					}}
				/>,
			)}
		</div>
	);
}
