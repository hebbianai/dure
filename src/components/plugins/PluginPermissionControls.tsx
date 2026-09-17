import { CircleAlert, ShieldCheck } from "lucide-react";
import { DureLoader } from "@/components/ui/dure-loader";
import { useEffect, useRef, useState } from "react";
import { LoadingRow } from "@/components/common/StatusBlocks";
import { PluginPermissionPlanReview } from "@/components/plugins/PluginPermissionPlanReview";
import {
	publishPluginPermissionSnapshot,
	refreshPluginPermissionWorkspace,
	usePluginPermissionWorkspace,
} from "@/components/plugins/usePluginPermissionWorkspace";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/ui/error-text";
import { t } from "@/lib/i18n";
import {
	durePluginPermissionDecide,
	durePluginPermissionDisable,
	durePluginPermissionEnable,
	type DurePluginPermissionDecision,
	type DurePluginPermissionSnapshot,
} from "@/lib/ipc/plugins";

function requestId(): string {
	return `ui:${globalThis.crypto.randomUUID()}`;
}

function plainPermissionSnapshot(
	snapshot: DurePluginPermissionSnapshot,
): DurePluginPermissionSnapshot {
	return {
		plan: snapshot.plan,
		review: snapshot.review,
		record_revision: snapshot.record_revision,
		decision_revision: snapshot.decision_revision,
		enablement_epoch: snapshot.enablement_epoch,
		decision: snapshot.decision,
		reviewed_plan_digest: snapshot.reviewed_plan_digest,
		plan_comparison: snapshot.plan_comparison,
		enabled: snapshot.enabled,
	};
}

export function PluginPermissionControls({
	pluginName,
	pluginId,
	workspaceRoot,
}: {
	pluginName: string;
	pluginId: string;
	workspaceRoot: string;
}) {
	const input = { pluginId, workspaceRoot };
	const { permission, permissionLoaded, permissionError } =
		usePluginPermissionWorkspace(input);
	const [busy, setBusy] = useState(false);
	const [mutationError, setMutationError] = useState<string | null>(null);
	const target = JSON.stringify([pluginId, workspaceRoot]);
	const [runtimeRetirementRepairTarget, setRuntimeRetirementRepairTarget] =
		useState<string | null>(null);
	const runtimeRetirementRepairNeeded =
		runtimeRetirementRepairTarget === target;
	const operationGeneration = useRef(0);
	useEffect(() => {
		operationGeneration.current += 1;
		setBusy(false);
		setMutationError(null);
		setRuntimeRetirementRepairTarget(null);
	}, [target]);
	useEffect(() => {
		setMutationError(null);
	}, [permission?.record_revision]);
	useEffect(
		() => () => {
			operationGeneration.current += 1;
		},
		[],
	);

	const mutate = async (
		action: DurePluginPermissionDecision | "enable" | "disable",
	) => {
		if (!permission || busy) return;
		const generation = ++operationGeneration.current;
		const expectedWorkspaceIdentity = permission.plan.workspace_identity;
		const expectedPlanDigest = permission.plan.digest;
		setBusy(true);
		setMutationError(null);
		const base = {
			plugin_id: pluginId,
			workspace_root: workspaceRoot,
			request_id: requestId(),
			expected_record_revision: permission.record_revision,
		};
		try {
			const next =
				action === "enable"
					? await durePluginPermissionEnable({
							...base,
							expected_plan_digest: permission.plan.digest,
						})
					: action === "disable"
						? await durePluginPermissionDisable({
								plugin_id: pluginId,
								workspace_root: workspaceRoot,
								request_id: base.request_id,
							})
						: await durePluginPermissionDecide({
								...base,
								decision: action,
								expected_plan_digest: permission.plan.digest,
							});
			if (operationGeneration.current !== generation) return;
			if (
				next.plan.identity.plugin_id !== pluginId ||
				next.plan.workspace_identity !== expectedWorkspaceIdentity ||
				(action !== "disable" && next.plan.digest !== expectedPlanDigest)
			) {
				throw new Error("plugin_permission_snapshot_target_mismatch");
			}
			if ("runtime_retirement" in next) {
				setRuntimeRetirementRepairTarget(
					next.runtime_retirement === "failed" ? target : null,
				);
			}
			publishPluginPermissionSnapshot(plainPermissionSnapshot(next));
		} catch (error) {
			if (operationGeneration.current !== generation) return;
			if (action === "disable") {
				setRuntimeRetirementRepairTarget(target);
			}
			setMutationError(String(error));
			refreshPluginPermissionWorkspace(input);
		} finally {
			if (operationGeneration.current === generation) setBusy(false);
		}
	};

	if (!permissionLoaded) {
		return (
			<LoadingRow className="px-4 py-4">
				{t("plugins.permissions.checking")}
			</LoadingRow>
		);
	}
	if (!permission) {
		return (
			<div className="px-4 py-4 text-xs text-destructive">
				<div className="flex items-start gap-2">
					<CircleAlert className="mt-0.5 size-3.5 shrink-0" />
					<span>
						{t("plugins.permissions.loadFailed")}
						{permissionError ? ` ${permissionError}` : null}
					</span>
				</div>
				<Button
					variant="outline"
					size="sm"
					className="mt-2"
					onClick={() => refreshPluginPermissionWorkspace(input)}
				>
					{t("common.retry")}
				</Button>
			</div>
		);
	}

	const reviewed = permission.plan_comparison === "matches_reviewed_plan";
	const approved = reviewed && permission.decision === "approve";
	const effectivePermissionEnabled = permission.enabled && approved;
	const status = effectivePermissionEnabled
		? t("plugins.permissions.status.approvedOn")
		: approved
			? t("plugins.permissions.status.approvedOff")
			: permission.plan_comparison === "changed_since_review"
				? t("plugins.permissions.status.scopeChanged")
				: permission.decision === "reject"
					? t("plugins.permissions.status.rejected")
					: permission.decision === "defer"
						? t("plugins.permissions.status.deferred")
						: t("plugins.permissions.status.reviewRequired");

	return (
		<section className="px-4 py-4">
			{/* The shield sits on the title line — 16px centred in the 14px
			    title's 20px line box — not floated between the two lines
			    (owner report 2026-09-15). */}
			<div className="flex items-start gap-2">
				<ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
				<div className="min-w-0 flex-1">
					<h3 className="truncate text-sm font-medium text-foreground">
						{t("plugins.permissions.title", { name: pluginName })}
					</h3>
					<p
						role="status"
						aria-live="polite"
						className="mt-0.5 text-xs text-muted-foreground"
					>
						{status}
					</p>
				</div>
			</div>
			<PluginPermissionPlanReview
				permission={permission}
				workspaceRoot={workspaceRoot}
			/>
			<p className="mt-4 text-meta text-muted-foreground">
				{t("plugins.permissions.scopeNote")}
			</p>
			{mutationError && (
				<ErrorText className="mt-2 text-xs">
					{t("plugins.permissions.saveFailed")} {mutationError}
				</ErrorText>
			)}
			{runtimeRetirementRepairNeeded && (
				<p
					role="alert"
					className="mt-2 flex items-start gap-1.5 text-xs text-destructive"
				>
					<CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
					<span>
						{t("plugins.permissions.cleanupFailed")}
					</span>
				</p>
			)}
			<div aria-busy={busy} className="mt-3 flex flex-wrap gap-2">
				{runtimeRetirementRepairNeeded ? (
					<Button
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() => void mutate("disable")}
					>
						{t("plugins.permissions.retryCleanup")}
					</Button>
				) : !approved ? (
					<>
						<Button size="sm" disabled={busy} onClick={() => void mutate("approve")}>
							{t("plugins.permissions.approve")}
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => void mutate("defer")}
						>
							{t("plugins.permissions.defer")}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={busy}
							onClick={() => void mutate("reject")}
						>
							{t("plugins.permissions.reject")}
						</Button>
					</>
				) : !effectivePermissionEnabled ? (
					<Button size="sm" disabled={busy} onClick={() => void mutate("enable")}>
						{t("plugins.permissions.enable")}
					</Button>
				) : (
					<Button
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() => void mutate("disable")}
					>
						{t("plugins.permissions.disable")}
					</Button>
				)}
			</div>
			{busy && (
				<span
					role="status"
					aria-live="polite"
					className="mt-2 flex items-center"
				>
					<DureLoader decorative />
					<span className="sr-only">{t("common.saving")}</span>
				</span>
			)}
		</section>
	);
}
