import { AlertTriangle } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { useEffect, useId, useMemo, useState } from "react";
import { DialogActionFooter } from "@/components/common/DialogActionFooter";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ErrorText } from "@/components/ui/error-text";
import { InsetPanel } from "@/components/ui/inset-panel";
import { Label } from "@/components/ui/label";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { t } from "@/lib/i18n";
import {
	type AgentPermissionModeV1,
	type ManagedAgentPermissionModeRelaunchResultV1,
	managedAgentPermissionModeRelaunchPreview,
} from "@/lib/sessions/managed/managedAgentPermissionModeRelaunch";
import {
	inspectManagedAgentRehost,
	type ManagedAgentRehostInspection,
} from "@/lib/sessions/managed/managedAgentRehost";
import { showToast } from "@/lib/toast";
import { type Agent, PROVIDERS } from "@/types";

function permissionModeLabel(mode: AgentPermissionModeV1): string {
	return mode === "skip_permissions"
		? t("agents.permission.skipPrompts")
		: t("agents.permission.defaultPrompts");
}

export function AgentPermissionModeDialog({
	agent,
	panelId,
	open,
	onOpenChange,
	busy,
	execute,
}: {
	agent: Agent;
	panelId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	busy: boolean;
	execute: (
		inspection: ManagedAgentRehostInspection,
		targetMode: AgentPermissionModeV1,
	) => Promise<ManagedAgentPermissionModeRelaunchResultV1>;
}) {
	const selectId = useId();
	const [inspection, setInspection] = useState<ManagedAgentRehostInspection>();
	const [targetMode, setTargetMode] =
		useState<AgentPermissionModeV1>("skip_permissions");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setInspection(undefined);
		setError(undefined);
		setLoading(true);
		void inspectManagedAgentRehost(agent.id, panelId)
			.then((next) => {
				if (cancelled) return;
				setInspection(next);
				setTargetMode(
					next.permissionMode === "bypass_approvals"
						? "default"
						: "skip_permissions",
				);
			})
			.catch((reason) => {
				if (!cancelled) setError(String(reason));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [agent.id, open, panelId]);

	const preview = useMemo(() => {
		if (!inspection) return undefined;
		try {
			return managedAgentPermissionModeRelaunchPreview(inspection, targetMode);
		} catch {
			return undefined;
		}
	}, [inspection, targetMode]);
	const bypassSupported = Boolean(PROVIDERS[agent.provider].skipPermFlag);
	const currentMode = inspection
		? inspection.permissionMode === "bypass_approvals"
			? "skip_permissions"
			: "default"
		: undefined;
	const unsupportedTarget =
		targetMode === "skip_permissions" && !bypassSupported;

	const submit = async () => {
		if (!inspection || !preview || unsupportedTarget || busy) return;
		setError(undefined);
		try {
			const result = await execute(inspection, targetMode);
			showToast(
				t("agents.permission.relaunchedWithMode", {
					mode: permissionModeLabel(result.receipt.targetMode),
				}),
			);
			onOpenChange(false);
		} catch (reason) {
			setError(String(reason));
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("agents.permission.changeModeTitle")}</DialogTitle>
					<DialogDescription>
						{t("agents.permission.restartRequiredExplanation")}
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3 py-1">
					<InsetPanel className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-3 py-2 text-sm">
						<span className="text-muted-foreground">{t("agents.permission.currentMode")}</span>
						<span className="font-medium">
							{preview
								? permissionModeLabel(preview.currentMode)
								: t("common.checking")}
						</span>
						<Label
							htmlFor={selectId}
							className="self-center text-muted-foreground"
						>
							{t("agents.permission.targetMode")}
						</Label>
						<SelectField
							id={selectId}
							value={targetMode}
							disabled={loading || busy || !inspection}
							onValueChange={(nextValue) =>
								setTargetMode(nextValue as AgentPermissionModeV1)
							}
							className="disabled:opacity-50"
						>
							<SelectOption value="default" disabled={currentMode === "default"}>
								{permissionModeLabel("default")}
							</SelectOption>
							<SelectOption
								value="skip_permissions"
								disabled={!bypassSupported || currentMode === "skip_permissions"}
							>
								{permissionModeLabel("skip_permissions")}
							</SelectOption>
						</SelectField>
					</InsetPanel>
					<Alert icon={false} tone="warn" className="flex gap-2">
						<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
						<div className="grid gap-1">
							<p className="font-medium">
								{t("agents.permission.providerWillRestart")}
							</p>
							<p className="text-muted-foreground">
								{t("agents.permission.identitiesPreserved")}
							</p>
						</div>
					</Alert>
					{unsupportedTarget && (
						<ErrorText>
							{t("agents.permission.skipUnsupported")}
						</ErrorText>
					)}
					{error && <ErrorText className="break-words">{error}</ErrorText>}
				</div>
				<DialogActionFooter
					cancelLabel={t("common.cancel")}
					onCancel={() => onOpenChange(false)}
					confirmLabel={t("agents.permission.relaunchAgent")}
					busyLabel={t("common.restarting")}
					busy={busy}
					disabled={loading || !preview || unsupportedTarget}
					onConfirm={() => void submit()}
				/>
			</DialogContent>
		</Dialog>
	);
}
