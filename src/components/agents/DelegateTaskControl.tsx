import { GitFork } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DialogActionFooter } from "@/components/common/DialogActionFooter";
import { FormField } from "@/components/common/FormField";
import { usePluginCatalog } from "@/components/plugins/usePluginViewCatalog";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ErrorText } from "@/components/ui/error-text";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Textarea } from "@/components/ui/textarea";
import { useWorkflowDelegateProviders } from "@/lib/agents/agentInstalls";
import { resolveLang, t } from "@/lib/i18n";
import {
	pluginLocalizedText,
	uniquePluginWorkflowAction,
} from "@/lib/plugins/durePlugins";
import {
	eligibleExistingDelegateTargets,
	pendingDelegateOnceIntent,
} from "@/lib/workflows/delegateOnce";
import { delegateOnceFromAgent } from "@/lib/workflows/delegateOnceRuntime";
import { subscribeDelegateTaskDialog } from "@/lib/workspace/pane/paneMenuSignals";
import { useStore } from "@/store";
import { type Agent, PROVIDERS, type Provider } from "@/types";

const CLOSED_DELEGATE_TARGET_AGENTS: readonly Agent[] = [];

function taskInputError(
	summary: string,
	instructions: string,
): string | undefined {
	const encoder = new TextEncoder();
	if (
		!summary ||
		encoder.encode(summary).length > 512 ||
		[...summary].some(control)
	) {
		return t("agents.delegate.taskNameTooLong");
	}
	if (
		!instructions ||
		encoder.encode(instructions).length > 16 * 1024 ||
		[...instructions].some(
			(character) =>
				control(character) && character !== "\n" && character !== "\t",
		)
	) {
		return t("agents.delegate.instructionsTooLarge");
	}
	return undefined;
}

function control(character: string): boolean {
	const code = character.charCodeAt(0);
	return code < 32 || code === 127;
}

export function DelegateTaskControl({
	agent,
	desktopId,
	hiddenTrigger = false,
	panelId,
}: {
	agent: Agent;
	desktopId: string;
	hiddenTrigger?: boolean;
	panelId?: string;
}) {
	const [open, setOpen] = useState(false);
	const providers = useWorkflowDelegateProviders(agent.provider);
	const agents = useStore((state) =>
		open ? state.agents : CLOSED_DELEGATE_TARGET_AGENTS,
	);
	const language = useStore((state) => state.language);
	const { catalog } = usePluginCatalog();
	const workflowAction = uniquePluginWorkflowAction(
		catalog ?? [],
		"workflow.delegate_once",
	);
	const actionTitle = workflowAction
		? pluginLocalizedText(workflowAction.workflow.title, resolveLang(language))
		: t("common.delegateTask");
	const actionDescription = workflowAction
		? pluginLocalizedText(
				workflowAction.workflow.description,
				resolveLang(language),
			)
		: t("agents.delegate.createWorkerDescription");
	const binding = agent.runtimeBinding;
	const supported =
		!agent.workflowDispatch &&
		binding?.runtime === "hmux_managed_v1" &&
		binding.source === "local" &&
		binding.sessionId === agent.sessionId &&
		!!binding.stopFence;
	const available = !!workflowAction && providers.length > 0;
	const disabledReason = agent?.workflowDispatch
		? t("agents.delegate.noNestedDelegation")
		: !supported
			? t("agents.delegate.localManagedOnly")
			: !workflowAction
				? t("agents.delegate.extensionMissing")
				: providers.length === 0
					? t("agents.delegate.noCapableProvider")
					: t("agents.delegate.startWorkerDescription");
	const [summary, setSummary] = useState("");
	const [instructions, setInstructions] = useState("");
	const [providerId, setProviderId] = useState<Provider>(agent.provider);
	const [targetAgentId, setTargetAgentId] = useState("");
	const [locked, setLocked] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const eligibleTargets = useMemo(
		() => eligibleExistingDelegateTargets(agent, agents, providers),
		[agent, agents, providers],
	);
	const selectedTarget = targetAgentId
		? agents.find((candidate) => candidate.id === targetAgentId)
		: undefined;
	const targetOptions = useMemo(() => {
		if (
			!selectedTarget ||
			eligibleTargets.some((candidate) => candidate.id === selectedTarget.id)
		) {
			return eligibleTargets;
		}
		return [selectedTarget, ...eligibleTargets];
	}, [eligibleTargets, selectedTarget]);

	const show = useCallback(() => {
		setError(supported && available ? undefined : disabledReason);
		try {
			const pending = pendingDelegateOnceIntent(agent.id);
			if (pending) {
				setSummary(pending.task.summary);
				setInstructions(pending.task.instructions);
				setProviderId(pending.providerId);
				setTargetAgentId(pending.target?.agentId ?? "");
				setLocked(true);
			} else {
				setSummary("");
				setInstructions("");
				setProviderId(
					providers.includes(agent.provider)
						? agent.provider
						: (providers[0] ?? agent.provider),
				);
				setTargetAgentId("");
				setLocked(false);
			}
			setOpen(true);
		} catch (cause) {
			setError(String(cause));
			setOpen(true);
		}
	}, [
		agent.id,
		agent.provider,
		available,
		disabledReason,
		providers,
		supported,
	]);

	useEffect(() => {
		if (!hiddenTrigger || !panelId) return;
		return subscribeDelegateTaskDialog(panelId, show);
	}, [hiddenTrigger, panelId, show]);

	const submit = async () => {
		if (!supported || providers.length === 0) {
			setError(disabledReason);
			return;
		}
		if (!workflowAction) {
			setError(t("agents.delegate.extensionMissing"));
			return;
		}
		const task = {
			summary: summary.trim(),
			instructions: instructions.trim(),
		};
		const invalid = taskInputError(task.summary, task.instructions);
		if (invalid) {
			setError(invalid);
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			if (targetAgentId && !selectedTarget) {
				throw new Error(t("agents.delegate.selectedPaneMissing"));
			}
			await delegateOnceFromAgent({
				contributionId: workflowAction.contributionId,
				desktopId,
				coordinator: agent,
				task,
				providerId: selectedTarget?.provider ?? providerId,
				...(selectedTarget ? { target: selectedTarget } : {}),
			});
			setOpen(false);
		} catch (cause) {
			try {
				setLocked(!!pendingDelegateOnceIntent(agent.id));
			} catch {
				setLocked(false);
			}
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			{!hiddenTrigger && (
				<Button
					variant="ghost"
					size="sm"
					disabled={!supported || !available}
					onClick={show}
					title={disabledReason}
					aria-label={actionTitle}
				>
					<GitFork className="size-3.5" />
					<span>{actionTitle}</span>
				</Button>
			)}
			<Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{actionTitle}</DialogTitle>
						<DialogDescription>
							{selectedTarget
								? t("agents.delegate.assignExistingDescription")
								: actionDescription}
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-3 py-1">
						<FormField
							label={t("common.target")}
							description={
								eligibleTargets.length === 0 && !locked
									? t("agents.delegate.noEligiblePane")
									: undefined
							}
						>
							<SelectField
								disabled={busy || locked}
								value={targetAgentId}
								onValueChange={(nextValue) => {
									const next = nextValue;
									setTargetAgentId(next);
									const target = agents.find((candidate) => candidate.id === next);
									if (target) setProviderId(target.provider);
								}}
							>
								<SelectOption value="">{t("agents.delegate.createWorker")}</SelectOption>
								{targetOptions.map((target) => (
									<SelectOption key={target.id} value={target.id}>
										{target.displayName ?? target.name}
									</SelectOption>
								))}
							</SelectField>
						</FormField>
						<FormField label={t("agents.delegate.taskName")}>
							<Input
								autoFocus
								disabled={busy || locked}
								value={summary}
								placeholder={t("agents.delegate.taskNamePlaceholder")}
								onChange={(event) => setSummary(event.target.value)}
							/>
						</FormField>
						<FormField
							label={t("agents.delegate.instructions")}
							description={t("agents.delegate.noSecretsHint")}
						>
							<Textarea
								className="min-h-28"
								disabled={busy || locked}
								value={instructions}
								placeholder={t("agents.delegate.instructionsPlaceholder")}
								onChange={(event) => setInstructions(event.target.value)}
							/>
						</FormField>
						<FormField label={t("common.provider")}>
							<SelectField
								disabled={busy || locked || !!selectedTarget}
								value={selectedTarget?.provider ?? providerId}
								onValueChange={(nextValue) => setProviderId(nextValue as Provider)}
							>
								{(locked && !providers.includes(providerId)
									? [providerId, ...providers]
									: providers
								).map((provider) => (
									<SelectOption key={provider} value={provider}>
										{PROVIDERS[provider].label}
									</SelectOption>
								))}
							</SelectField>
						</FormField>
						{locked && (
							<p className="text-xs text-muted-foreground">
								{t("agents.delegate.lostResponseRetryHint")}
							</p>
						)}
						{error && <ErrorText className="break-words">{error}</ErrorText>}
					</div>
					<DialogActionFooter
						cancelLabel={t("common.close")}
						onCancel={() => setOpen(false)}
						confirmLabel={
							locked
								? t("agents.delegate.retrySameRequest")
								: selectedTarget
									? t("agents.delegate.assignExisting")
									: t("agents.delegate.startWorker")
						}
						busyLabel={t("agents.delegate.delegating")}
						busy={busy}
						disabled={!supported || !available || (!!error && !summary)}
						onConfirm={() => void submit()}
					/>
				</DialogContent>
			</Dialog>
		</>
	);
}
