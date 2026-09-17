import type {
  IssueTrackerProviderV1,
  PluginCompatibilityOutcomeV2,
  PluginLocalizedTextV1,
  PluginManifestV2,
  PluginSettingDefinitionV1,
  PluginSettingScopeV1,
  PluginSettingValueV1,
  PluginSettingsSchemaV1,
  PluginIssueTrackerAgentClaimsSurfaceV1,
  PluginViewContainerV1,
  PluginViewV1,
  PluginViewsV1,
  PluginWorkflowContributionV1,
} from "@/contracts/generated/extensionContracts";
import { type Lang, t } from "@/lib/i18n";

export interface DureIssueTrackerCatalogContribution {
  contribution_id: string;
  provider: IssueTrackerProviderV1;
}

interface DureViewsCatalogContribution {
  contribution_id: string;
  views: PluginViewsV1;
}

interface DureWorkflowCatalogContribution {
  contribution_id: string;
  workflow: PluginWorkflowContributionV1;
}

export interface DurePluginCatalogEntry {
  manifest: PluginManifestV2;
  compatibility: PluginCompatibilityOutcomeV2;
  distribution: "bundled" | "installed";
  installed: boolean;
  removable: boolean;
  settings_contribution: DureSettingsCatalogContributionV2 | null;
  issue_tracker_contributions: DureIssueTrackerCatalogContribution[];
  view_contributions: DureViewsCatalogContribution[];
  /** Optional while older desktop catalogs remain wire-compatible. */
  workflow_contributions?: DureWorkflowCatalogContribution[];
}

export interface DurePluginLegacyCatalogEntry {
  manifest: PluginManifestV2;
  compatibility: PluginCompatibilityOutcomeV2;
  distribution: "bundled" | "installed";
  installed: boolean;
  removable: boolean;
  settings_schema: PluginSettingsSchemaV1;
  issue_tracker_contributions: DureIssueTrackerCatalogContribution[];
  view_contributions: DureViewsCatalogContribution[];
}

interface DurePluginCatalogCandidateIdentityV2 {
  source_id: string;
  candidate_id: string;
}

interface DureSettingsCatalogContributionV2 {
  target: DurePluginSettingsTargetV2;
  contribution_id: string;
  schema: PluginSettingsSchemaV1;
}

export interface DurePluginSettingsTargetV2 {
  identity: DurePluginCatalogCandidateIdentityV2;
  plugin_id: string;
  version: string;
  contribution_id: string;
}

interface DurePluginCatalogConflictCandidateV2 {
  source_id: string;
  candidate_id: string;
  version: string;
}

type DurePluginCatalogRejectionV2 =
  | { kind: "source_rejected" }
  | { kind: "catalog_policy_unavailable" }
  | {
      kind: "incompatible";
      compatibility: PluginCompatibilityOutcomeV2;
    }
  | {
      kind: "invalid_contribution";
      contribution_id: string | null;
      family: string | null;
    };

export type DurePluginCatalogOutcomeV2 =
  | {
      status: "available";
      identity: DurePluginCatalogCandidateIdentityV2;
      entry: DurePluginCatalogEntry;
    }
  | {
      status: "rejected";
      identity: DurePluginCatalogCandidateIdentityV2;
      manifest: PluginManifestV2 | null;
      reason: DurePluginCatalogRejectionV2;
    }
  | {
      status: "conflict";
      plugin_id: string;
      candidates: DurePluginCatalogConflictCandidateV2[];
    };

export interface DurePluginCatalogSnapshotV2 {
  schema_version: 2;
  outcomes: DurePluginCatalogOutcomeV2[];
}

export interface DurePluginViewContainer {
  plugin: DurePluginCatalogEntry;
  contributionId: string;
  container: PluginViewContainerV1;
  views: PluginViewV1[];
}

export interface DurePluginAgentClaimView {
  plugin: DurePluginCatalogEntry;
  viewContributionId: string;
  contributionId: string;
  view: Extract<PluginViewV1, { kind: "issue_tracker" }>;
  provider: DureIssueTrackerCatalogContribution;
}

export interface DurePluginWorkflowAction {
  plugin: DurePluginCatalogEntry;
  contributionId: string;
  workflow: PluginWorkflowContributionV1;
}

export interface DurePluginSettingsSnapshot {
  target: DurePluginSettingsTargetV2;
  scope: PluginSettingScopeV1;
  scope_key: string | null;
  values: Record<string, PluginSettingValueV1>;
  settings_revision?: string;
  agent_claim_policy_epochs?: Record<string, number>;
}

export function availablePluginCatalogEntries(
  snapshot: DurePluginCatalogSnapshotV2,
): DurePluginCatalogEntry[] {
  return snapshot.outcomes.flatMap((outcome) =>
    outcome.status === "available" ? [outcome.entry] : [],
  );
}

export function pluginCatalogOutcomeKey(
  outcome: DurePluginCatalogOutcomeV2,
): string {
  if (outcome.status === "available") {
    return `available:${outcome.entry.manifest.id}`;
  }
  if (outcome.status === "conflict") {
    return `conflict:${outcome.plugin_id}`;
  }
  return `rejected:${outcome.identity.source_id}:${outcome.identity.candidate_id}`;
}

export function pluginDescription(entry: DurePluginCatalogEntry): string {
  return entry.manifest.description ?? t("plugins.catalog.noDescription");
}

export function isDurePluginSupported(entry: DurePluginCatalogEntry): boolean {
  return entry.compatibility.status === "supported";
}

export function pluginSettingsForScope(
  schema: PluginSettingsSchemaV1 | null | undefined,
  scope: PluginSettingScopeV1,
): PluginSettingDefinitionV1[] {
  return (schema?.settings ?? []).filter((setting) => setting.scope === scope);
}

export function pluginHasSettings(entry: DurePluginCatalogEntry): boolean {
  return pluginSettingsTarget(entry) !== null;
}

export function pluginSettingsTarget(
  entry: DurePluginCatalogEntry,
): DurePluginSettingsTargetV2 | null {
  const contribution = entry.settings_contribution;
  if (!contribution || (contribution.schema.settings?.length ?? 0) === 0) {
    return null;
  }
  const target = contribution.target;
  if (
    target.plugin_id !== entry.manifest.id ||
    target.version !== entry.manifest.version ||
    target.contribution_id !== contribution.contribution_id
  ) {
    return null;
  }
  return target;
}

export function pluginSettingsTargetsEqual(
  left: DurePluginSettingsTargetV2,
  right: DurePluginSettingsTargetV2,
): boolean {
  return (
    left.identity.source_id === right.identity.source_id &&
    left.identity.candidate_id === right.identity.candidate_id &&
    left.plugin_id === right.plugin_id &&
    left.version === right.version &&
    left.contribution_id === right.contribution_id
  );
}

export function pluginWorkspaceBooleanDefault(
  entry: DurePluginCatalogEntry,
  key: string,
): boolean | undefined {
  const definition = (entry.settings_contribution?.schema.settings ?? []).find(
    (setting) =>
      setting.kind === "boolean" &&
      setting.scope === "workspace" &&
      setting.key === key,
  );
  return definition?.kind === "boolean" ? definition.default : undefined;
}

export function agentIntegrationNames(entry: DurePluginCatalogEntry): string[] {
  const enabled =
    entry.compatibility.status === "supported"
      ? new Set(entry.compatibility.enabled_agent_integrations)
      : new Set<string>();
  return (entry.manifest.agent_integrations ?? [])
    .filter((integration) => enabled.has(integration.id))
    .map((integration) => integration.adapter);
}

export function pluginLocalizedText(
  text: PluginLocalizedTextV1,
  lang: Lang,
): string {
  return text.translations?.[lang] ?? text.default;
}

export function pluginWorkflowActions(
  entries: readonly DurePluginCatalogEntry[],
  kind: string,
): DurePluginWorkflowAction[] {
  return entries.flatMap((plugin) => {
    if (!plugin.installed || plugin.compatibility.status !== "supported") return [];
    const negotiated = new Set(
      plugin.compatibility.contributions
        .filter((contribution) => contribution.family === "dure.workflows")
        .map((contribution) => contribution.id),
    );
    return (plugin.workflow_contributions ?? []).flatMap((contribution) =>
      negotiated.has(contribution.contribution_id) &&
      contribution.workflow.schema_version === 1 &&
      contribution.workflow.kind === kind
        ? [
            {
              plugin,
              contributionId: contribution.contribution_id,
              workflow: contribution.workflow,
            },
          ]
        : [],
    );
  });
}

/** Ambiguous host actions fail closed instead of guessing package precedence. */
export function uniquePluginWorkflowAction(
  entries: readonly DurePluginCatalogEntry[],
  kind: string,
): DurePluginWorkflowAction | undefined {
  const actions = pluginWorkflowActions(entries, kind);
  return actions.length === 1 ? actions[0] : undefined;
}

export function pluginViewContainers(
  entries: DurePluginCatalogEntry[],
): DurePluginViewContainer[] {
  return entries.flatMap((plugin) => {
    if (!plugin.installed || plugin.compatibility.status !== "supported") return [];
    const negotiated = new Set(
      plugin.compatibility.contributions
        .filter((contribution) => contribution.family === "dure.views")
        .map((contribution) => contribution.id),
    );
    const negotiatedIssueTrackers = new Set(
      plugin.compatibility.contributions
        .filter((contribution) => contribution.family === "dure.issue-tracker")
        .map((contribution) => contribution.id),
    );
    return plugin.view_contributions
      .filter((contribution) => negotiated.has(contribution.contribution_id))
      .flatMap((contribution) =>
        contribution.views.containers.map((container) => ({
          plugin,
          contributionId: contribution.contribution_id,
          container,
          views: contribution.views.views.filter(
            (view) =>
              view.container_id === container.id &&
              view.kind === "issue_tracker" &&
              negotiatedIssueTrackers.has(view.provider_contribution_id),
          ),
        })),
      )
      .filter((container) => container.views.length > 0);
  });
}

export function issueTrackerContribution(
  entry: DurePluginCatalogEntry,
  contributionId: string,
): DureIssueTrackerCatalogContribution | undefined {
  if (
    entry.compatibility.status !== "supported" ||
    !entry.compatibility.contributions.some(
      (contribution) =>
        contribution.family === "dure.issue-tracker" &&
        contribution.id === contributionId,
    )
  ) {
    return undefined;
  }
  return entry.issue_tracker_contributions.find(
    (contribution) => contribution.contribution_id === contributionId,
  );
}

export function pluginAgentClaimViews(
  entries: DurePluginCatalogEntry[],
  surface: PluginIssueTrackerAgentClaimsSurfaceV1,
): DurePluginAgentClaimView[] {
  return pluginViewContainers(entries).flatMap((container) =>
    container.views.flatMap((view) => {
      if (
        view.kind !== "issue_tracker" ||
        !view.agent_claims?.surfaces.includes(surface)
      ) {
        return [];
      }
      const provider = issueTrackerContribution(
        container.plugin,
        view.provider_contribution_id,
      );
      return provider
        ? [
            {
              plugin: container.plugin,
              viewContributionId: container.contributionId,
              contributionId: provider.contribution_id,
              view,
              provider,
            },
          ]
        : [];
    }),
  );
}
