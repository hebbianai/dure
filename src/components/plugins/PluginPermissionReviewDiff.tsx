import { useId } from "react";
import type {
	PluginPermissionReviewDiffV2,
	PluginPermissionReviewEntryV2,
	PluginPermissionReviewFieldV2,
	PluginPermissionReviewProjectionV2,
	PluginPermissionReviewSubjectV2,
	PluginPermissionReviewValueV2,
} from "@/contracts/generated/extensionContracts";
import { Badge } from "@/components/ui/badge";
import { t } from "@/lib/i18n";

// Same scale as PluginPermissionPlanReview: 13px words and mono values,
// 11px labels, no pixel literals under the tokens.
const technicalValueClass =
	"whitespace-pre-wrap break-all [unicode-bidi:isolate] font-mono text-xs text-foreground";
const itemClass =
	"rounded-md border border-border/50 bg-foreground/[0.03] px-2.5 py-2 text-xs";

function isUnsafeDisplayCharacter(character: string): boolean {
	const codePoint = character.codePointAt(0) ?? -1;
	return (
		codePoint <= 0x1f ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		codePoint === 0xad ||
		codePoint === 0x34f ||
		codePoint === 0x61c ||
		(codePoint >= 0x115f && codePoint <= 0x1160) ||
		(codePoint >= 0x17b4 && codePoint <= 0x17b5) ||
		(codePoint >= 0x180b && codePoint <= 0x180f) ||
		(codePoint >= 0x200b && codePoint <= 0x200f) ||
		(codePoint >= 0x2028 && codePoint <= 0x202e) ||
		(codePoint >= 0x2060 && codePoint <= 0x206f) ||
		codePoint === 0x3164 ||
		(codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
		codePoint === 0xfeff ||
		codePoint === 0xffa0 ||
		(codePoint >= 0xfff0 && codePoint <= 0xfff8) ||
		(codePoint >= 0x1bca0 && codePoint <= 0x1bca3) ||
		(codePoint >= 0x1d173 && codePoint <= 0x1d17a) ||
		(codePoint >= 0xe0000 && codePoint <= 0xe0fff)
	);
}

function escapeCodePoint(character: string): string {
	const codePoint = character.codePointAt(0);
	if (codePoint === undefined) return "";
	const hexadecimal = codePoint.toString(16);
	return codePoint <= 0xffff
		? `\\u${hexadecimal.padStart(4, "0")}`
		: `\\u{${hexadecimal}}`;
}

export function encodePluginPermissionReviewValue(value: unknown): string {
	const encoded = JSON.stringify(value) ?? "null";
	return Array.from(encoded, (character) =>
		isUnsafeDisplayCharacter(character)
			? escapeCodePoint(character)
			: character,
	).join("");
}

function reviewValueData(value: PluginPermissionReviewValueV2): unknown {
	switch (value.kind) {
		case "boolean":
		case "u16":
		case "string":
			return value.value;
		case "string_list":
			return value.values;
		default:
			return assertNever(value);
	}
}

function subjectLabel(subject: PluginPermissionReviewSubjectV2): string {
	switch (subject) {
		case "plan":
			return t("plugins.plan.subject.plan");
		case "identity":
			return t("plugins.plan.subject.identity");
		case "authority":
			return t("plugins.plan.subject.authority");
		case "workspace":
			return t("plugins.plan.subject.workspace");
		case "catalog_selection":
			return t("plugins.plan.subject.catalogSelection");
		case "activation":
			return t("plugins.plan.activation.title");
		case "contribution":
			return t("plugins.plan.contributions.title");
		case "ignored_optional_contribution":
			return t("plugins.plan.subject.ignoredContribution");
		case "agent_integration":
			return t("plugins.plan.agentIntegrations.title");
		case "ignored_optional_agent_integration":
			return t("plugins.plan.subject.ignoredAgentIntegration");
		case "permission":
			return t("plugins.plan.subject.appliedPermission");
		case "catalog_resource":
			return t("plugins.plan.subject.catalogResource");
		default:
			return assertNever(subject);
	}
}

function requiredFieldLabel(subject: PluginPermissionReviewSubjectV2): string {
	switch (subject) {
		case "permission":
			return t("plugins.plan.field.requiredByPolicy");
		case "contribution":
		case "agent_integration":
			return t("plugins.plan.field.requiredByDeclaration");
		case "plan":
		case "identity":
		case "authority":
		case "workspace":
		case "catalog_selection":
		case "activation":
		case "ignored_optional_contribution":
		case "ignored_optional_agent_integration":
		case "catalog_resource":
			return t("plugins.plan.field.required");
		default:
			return assertNever(subject);
	}
}

function fieldLabel(
	subject: PluginPermissionReviewSubjectV2,
	field: PluginPermissionReviewFieldV2,
): string {
	switch (field) {
		case "schema_version":
			return t("plugins.plan.field.schema");
		case "plugin_id":
			return t("plugins.plan.field.pluginId");
		case "publisher":
			return t("plugins.plan.field.displayPublisher");
		case "version":
			return t("plugins.plan.field.version");
		case "authority_id":
			return t("plugins.plan.field.bundledAuthorityId");
		case "catalog_snapshot_sha256":
			return t("plugins.plan.field.catalogSnapshotFingerprint");
		case "workspace_identity":
			return t("plugins.plan.field.workspaceFingerprint");
		case "source_id":
			return t("plugins.plan.field.sourceId");
		case "candidate_id":
			return t("plugins.plan.field.candidateId");
		case "applied_policy_digest":
			return t("plugins.plan.field.policyFingerprint");
		case "negotiated_host_api_version":
			return t("plugins.plan.field.hostApi");
		case "presence":
			return t("plugins.plan.field.presence");
		case "pattern":
			return t("plugins.plan.field.workspacePattern");
		case "family":
			return t("plugins.plan.field.family");
		case "family_api_version":
			return t("plugins.plan.field.familyApi");
		case "required":
			return requiredFieldLabel(subject);
		case "placement":
			return t("plugins.plan.field.placement");
		case "resource":
			return t("plugins.plan.field.resourcePath");
		case "adapter":
			return t("plugins.plan.field.agentAdapter");
		case "selector_plugin":
			return t("plugins.plan.field.agentPluginId");
		case "selector_marketplace":
			return t("plugins.plan.field.agentMarketplaceId");
		case "granted_values":
			return t("plugins.plan.field.grantedValues");
		case "content_sha256":
			return t("plugins.plan.field.resourceContentFingerprint");
		default:
			return assertNever(field);
	}
}

function assertNever(value: never): never {
	throw new Error(
		`unsupported_plugin_permission_review_value:${String(value)}`,
	);
}

function ReviewEntryIdentity({
	entry,
}: {
	entry: PluginPermissionReviewEntryV2;
}) {
	return (
		<>
			<div className="font-medium">{subjectLabel(entry.subject)}</div>
			<div className="text-muted-foreground">
				{fieldLabel(entry.subject, entry.field)}
			</div>
			{entry.key_segments.length > 0 && (
				<dl className="mt-1 grid gap-1">
					{entry.key_segments.map((segment, index) => (
						<div key={`${index}:${segment}`}>
							<dt className="text-meta text-muted-foreground">
								{t("plugins.plan.keySegment", { n: index + 1 })}
							</dt>
							<dd dir="ltr" className={technicalValueClass}>
								{encodePluginPermissionReviewValue(segment)}
							</dd>
						</div>
					))}
				</dl>
			)}
		</>
	);
}

function ReviewValue({
	label,
	value,
}: {
	label: string;
	value: PluginPermissionReviewValueV2;
}) {
	return (
		<div>
			<dt className="text-meta text-muted-foreground">{label}</dt>
			<dd dir="ltr" className={technicalValueClass}>
				{encodePluginPermissionReviewValue(reviewValueData(value))}
			</dd>
		</div>
	);
}

function ProjectionEntry({ entry }: { entry: PluginPermissionReviewEntryV2 }) {
	return (
		<li className={itemClass}>
			<ReviewEntryIdentity entry={entry} />
			<dl className="mt-1">
				<ReviewValue label={t("plugins.plan.value.current")} value={entry.value} />
			</dl>
		</li>
	);
}

function ProjectionSection({
	title,
	entries,
}: {
	title: string;
	entries: PluginPermissionReviewEntryV2[];
}) {
	return (
		<section>
			<h4 className="mb-1.5 text-[11px] leading-[18px] font-medium text-muted-foreground">
				{title}
			</h4>
			{entries.length === 0 ? (
				<p className="text-xs text-muted-foreground">{t("plugins.plan.empty")}</p>
			) : (
				<ul className="space-y-1.5">
					{entries.map((entry, index) => (
						<ProjectionEntry
							key={`${entry.subject}:${entry.field}:${index}`}
							entry={entry}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

export function PluginPermissionReviewProjectionEvidence({
	projection,
}: {
	projection: PluginPermissionReviewProjectionV2;
}) {
	const appliedPolicy = projection.entries.filter(
		(entry) =>
			entry.subject === "permission" &&
			(entry.field === "required" || entry.field === "granted_values"),
	);
	const catalogResources = projection.entries.filter(
		(entry) =>
			entry.subject === "catalog_resource" && entry.field === "content_sha256",
	);

	return (
		<>
			<ProjectionSection
				title={t("plugins.plan.evidence.appliedPolicy")}
				entries={appliedPolicy}
			/>
			<p className="-mt-2 text-meta text-muted-foreground">
				{t("plugins.plan.evidence.grantedValuesNote")}
			</p>
			<ProjectionSection
				title={t("plugins.plan.evidence.resourceFingerprints")}
				entries={catalogResources}
			/>
		</>
	);
}

function ChangeBadge({ kind }: { kind: "added" | "removed" | "changed" }) {
	const label =
		kind === "added"
			? t("plugins.plan.diff.added")
			: kind === "removed"
				? t("plugins.plan.diff.removed")
				: t("plugins.plan.diff.changed");
	return (
		<Badge size="sm" variant="secondary" className="mb-1">
			{label}
		</Badge>
	);
}

export function PluginPermissionReviewDiff({
	diff,
}: {
	diff: PluginPermissionReviewDiffV2;
}) {
	const headingId = useId();

	return (
		<section aria-labelledby={headingId}>
			<h4
				id={headingId}
				className="mb-1.5 text-[11px] leading-[18px] font-medium text-muted-foreground"
			>
				{t("plugins.plan.diff.title")}
			</h4>
			{diff.changes.length === 0 ? (
				<p className="text-xs text-muted-foreground">
					{t("plugins.plan.diff.empty")}
				</p>
			) : (
				<ul className="space-y-1.5">
					{diff.changes.map((change, index) => {
						if (change.kind === "added") {
							return (
								<li key={`added:${index}`} className={itemClass}>
									<ChangeBadge kind="added" />
									<ReviewEntryIdentity entry={change.current} />
									<dl className="mt-1">
										<ReviewValue
											label={t("plugins.plan.value.current")}
											value={change.current.value}
										/>
									</dl>
								</li>
							);
						}
						if (change.kind === "removed") {
							return (
								<li key={`removed:${index}`} className={itemClass}>
									<ChangeBadge kind="removed" />
									<ReviewEntryIdentity entry={change.reviewed} />
									<dl className="mt-1">
										<ReviewValue
											label={t("plugins.plan.value.previous")}
											value={change.reviewed.value}
										/>
									</dl>
								</li>
							);
						}
						return (
							<li key={`changed:${index}`} className={itemClass}>
								<ChangeBadge kind="changed" />
								<ReviewEntryIdentity entry={change.current} />
								<dl className="mt-1 grid gap-1">
									<ReviewValue
										label={t("plugins.plan.value.previous")}
										value={change.reviewed.value}
									/>
									<ReviewValue
										label={t("plugins.plan.value.current")}
										value={change.current.value}
									/>
								</dl>
							</li>
						);
					})}
				</ul>
			)}
			{diff.catalog_snapshot_fingerprint_only && (
				<p className="mt-1.5 text-meta text-muted-foreground">
					{t("plugins.plan.diff.fingerprintOnlyNote")}
				</p>
			)}
		</section>
	);
}
