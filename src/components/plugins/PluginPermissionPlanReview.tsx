import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";
import {
	encodePluginPermissionReviewValue,
	PluginPermissionReviewDiff,
	PluginPermissionReviewProjectionEvidence,
} from "@/components/plugins/PluginPermissionReviewDiff";
import { Disclosure } from "@/components/ui/disclosure";
import { t } from "@/lib/i18n";
import type { DurePluginPermissionSnapshot } from "@/lib/ipc/plugins";

type PermissionPlan = DurePluginPermissionSnapshot["plan"];

// The settings pages' type: 13px (text-xs) for words and values, values in
// mono at 400; 11px (text-meta) only for a field's label. Pixel literals
// below the tokens (10/11) put this screen off the app's scale (owner
// report 2026-09-14).
const itemClass =
	"whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border border-border/50 bg-foreground/[0.03] px-2.5 py-2 text-xs";
const technicalValueClass =
	"whitespace-pre-wrap break-all [unicode-bidi:isolate] font-mono text-xs text-foreground";

function permissionTitle(kind: string): string {
	if (kind === "dure.issue-tracker.read") return t("plugins.plan.permissions.issueTrackerRead");
	if (kind === "dure.ui.contribute") return t("plugins.plan.permissions.uiContribute");
	return kind;
}

function activationLabel(
	activation: PermissionPlan["activation"][number],
): string {
	switch (activation.kind) {
		case "workspace_contains":
			return t("plugins.plan.activation.workspaceContains", {
				pattern: encodePluginPermissionReviewValue(activation.pattern),
			});
		case "explicit":
			return t("plugins.plan.activation.explicit");
		default:
			return assertNeverActivation(activation);
	}
}

function assertNeverActivation(activation: never): never {
	throw new Error(
		`unsupported_plugin_activation:${JSON.stringify(activation)}`,
	);
}

function PlanList({
	children,
	empty,
}: {
	children: ReactNode;
	empty: boolean;
}) {
	if (empty) {
		return (
			<p className="text-xs text-muted-foreground">{t("plugins.plan.empty")}</p>
		);
	}
	return <ul className="space-y-2">{children}</ul>;
}

function ReviewSection({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<section>
			{/* SettingsSection's label, not a tracked capital: nothing in Settings shouts. */}
			<h4 className="mb-3 text-[11px] leading-[18px] font-medium text-muted-foreground">
				{title}
			</h4>
			{children}
		</section>
	);
}

function TechnicalField({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col gap-1">
			<dt className="text-meta text-muted-foreground">{label}</dt>
			<dd dir="ltr" className={technicalValueClass}>
				{value}
			</dd>
		</div>
	);
}

export function PluginPermissionPlanReview({
	permission,
	workspaceRoot,
}: {
	permission: DurePluginPermissionSnapshot;
	workspaceRoot: string;
}) {
	const { plan } = permission;
	const { comparison } = permission.review;
	const needsReview = comparison.status !== "matches_reviewed_projection";
	const detailsRef = useRef<HTMLDetailsElement>(null);
	const ignoredCount =
		plan.ignored_optional_contributions.length +
		plan.ignored_optional_agent_integrations.length;
	useLayoutEffect(() => {
		if (detailsRef.current) detailsRef.current.open = needsReview;
	}, [needsReview, permission.review.current.projection_digest]);

	return (
		<Disclosure
			ref={detailsRef}
			size="meta"
			className="mt-3"
			label={t("plugins.plan.viewFullScope")}
			// Flush with the block, not stepped in under the chevron: the
			// settings sections below this block set their rows at the same
			// 16px, and the review's labels and values read as one column with
			// them (owner report 2026-09-15). Only the summary keeps its chevron.
			bodyClassName="mt-3 pl-0"
		>
			<div className="space-y-6">
				{comparison.status === "changed_since_review" && (
					<PluginPermissionReviewDiff diff={comparison.diff} />
				)}
				<ReviewSection title={t("plugins.plan.identity.title")}>
					<dl className="grid gap-3">
						<TechnicalField
							label={t("plugins.plan.field.pluginId")}
							value={plan.identity.plugin_id}
						/>
						<TechnicalField
							label={t("plugins.plan.field.displayPublisher")}
							value={plan.identity.publisher}
						/>
						<TechnicalField
							label={t("plugins.plan.field.version")}
							value={plan.identity.version}
						/>
						<TechnicalField
							label={t("plugins.plan.field.requestingWorkspacePath")}
							value={encodePluginPermissionReviewValue(workspaceRoot)}
						/>
						<TechnicalField
							label={t("plugins.plan.field.workspaceFingerprint")}
							value={plan.workspace_identity}
						/>
					</dl>
				</ReviewSection>

				<ReviewSection title={t("plugins.plan.permissions.title")}>
					<PlanList empty={plan.permissions.length === 0}>
						{plan.permissions.map((requested) => (
							<li key={requested.kind} className={itemClass}>
								<div className="font-medium">
									{permissionTitle(requested.kind)}
								</div>
								<div className={technicalValueClass}>{requested.kind}</div>
								{Object.entries(requested.parameters ?? {})
									.sort(([left], [right]) => left.localeCompare(right))
									.map(([parameter, values]) => (
										<div key={parameter} className="mt-1 text-muted-foreground">
											<span className="font-mono text-meta">{parameter}</span>
											:{" "}
											<code className={technicalValueClass}>
												{encodePluginPermissionReviewValue(values ?? [])}
											</code>
										</div>
									))}
							</li>
						))}
					</PlanList>
				</ReviewSection>

				<PluginPermissionReviewProjectionEvidence
					projection={permission.review.current}
				/>

				<ReviewSection title={t("plugins.plan.activation.title")}>
					<PlanList empty={plan.activation.length === 0}>
						{plan.activation.map((activation) => (
							<li key={JSON.stringify(activation)} className={itemClass}>
								{activationLabel(activation)}
							</li>
						))}
					</PlanList>
				</ReviewSection>

				<ReviewSection title={t("plugins.plan.contributions.title")}>
					<PlanList empty={plan.contributions.length === 0}>
						{plan.contributions.map((contribution) => (
							<li key={contribution.id} className={itemClass}>
								<div className="font-medium">{contribution.id}</div>
								<div className="text-muted-foreground">
									{contribution.family} API {contribution.family_api_version} ·{" "}
									{contribution.required ? t("plugins.plan.required") : t("plugins.plan.optional")} ·{" "}
									{t("plugins.plan.contributions.placement", {
										placement: contribution.placement,
									})}
								</div>
								<div className={technicalValueClass}>
									{encodePluginPermissionReviewValue(contribution.resource)}
								</div>
							</li>
						))}
					</PlanList>
				</ReviewSection>

				<ReviewSection title={t("plugins.plan.agentIntegrations.title")}>
					<PlanList empty={plan.agent_integrations.length === 0}>
						{plan.agent_integrations.map((integration) => (
							<li key={integration.id} className={itemClass}>
								<div className="font-medium">{integration.id}</div>
								<div className="text-muted-foreground">
									{integration.adapter} ·{" "}
									{integration.required ? t("plugins.plan.required") : t("plugins.plan.optional")}
								</div>
								<dl className="mt-1 grid gap-1">
									<TechnicalField
										label={t("plugins.plan.field.agentPluginId")}
										value={integration.selector.plugin}
									/>
									<TechnicalField
										label={t("plugins.plan.field.agentMarketplaceId")}
										value={integration.selector.marketplace}
									/>
								</dl>
								<div className={technicalValueClass}>
									{encodePluginPermissionReviewValue(integration.resource)}
								</div>
							</li>
						))}
					</PlanList>
					<p className="mt-2 text-meta text-muted-foreground">
						{t("plugins.plan.agentIntegrations.installNote")}
					</p>
				</ReviewSection>

				{ignoredCount > 0 && (
					<ReviewSection title={t("plugins.plan.excluded.title")}>
						<dl className="space-y-3">
							{plan.ignored_optional_contributions.length > 0 && (
								<TechnicalField
									label={t("plugins.plan.excluded.contributions")}
									value={encodePluginPermissionReviewValue(
										plan.ignored_optional_contributions,
									)}
								/>
							)}
							{plan.ignored_optional_agent_integrations.length > 0 && (
								<TechnicalField
									label={t("plugins.plan.excluded.agentIntegrations")}
									value={encodePluginPermissionReviewValue(
										plan.ignored_optional_agent_integrations,
									)}
								/>
							)}
						</dl>
					</ReviewSection>
				)}

				<ReviewSection title={t("plugins.plan.trust.title")}>
					<dl className="grid gap-3">
						<TechnicalField
							label={t("plugins.plan.field.bundledAuthorityId")}
							value={plan.authority.authority}
						/>
						<TechnicalField
							label={t("plugins.plan.field.catalogSnapshotFingerprint")}
							value={plan.authority.catalog_snapshot_sha256}
						/>
						<TechnicalField
							label={t("plugins.plan.field.sourceId")}
							value={plan.catalog_selection.source_id}
						/>
						<TechnicalField
							label={t("plugins.plan.field.candidateId")}
							value={plan.catalog_selection.candidate_id}
						/>
						<TechnicalField
							label={t("plugins.plan.field.policyFingerprint")}
							value={plan.applied_policy_digest}
						/>
						<TechnicalField
							label={t("plugins.plan.field.hostApi")}
							value={String(plan.negotiated_host_api_version)}
						/>
						<TechnicalField
							label={t("plugins.plan.field.schema")}
							value={String(plan.schema_version)}
						/>
						<TechnicalField label={t("plugins.plan.field.currentFingerprint")} value={plan.digest} />
						{(comparison.status === "changed_since_review" ||
							comparison.status === "legacy_digest_only") && (
							<TechnicalField
								label={t("plugins.plan.field.reviewedFingerprint")}
								value={comparison.reviewed_plan_digest}
							/>
						)}
					</dl>
					<p className="mt-2 text-meta text-muted-foreground">
						{t("plugins.plan.trust.fingerprintScopeNote")}
					</p>
					{comparison.status === "legacy_digest_only" && (
						<p className="mt-2 text-meta text-muted-foreground">
							{t("plugins.plan.trust.legacyReviewNote")}
						</p>
					)}
				</ReviewSection>
			</div>
		</Disclosure>
	);
}
